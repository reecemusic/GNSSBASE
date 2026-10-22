'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { SerialPort } = require('serialport');
const { parseAsciiLog, readBinaryLog, findSyncIndex } = require('./novatel');

const MAX_BUFFER_BYTES = 1 << 20;
const NEWLINE = 0x0a;
const PROBE_LOGS = new Set([
  'VERSION', 'RXSTATUS', 'BESTPOS', 'BESTGNSSPOS', 'RANGE', 'SATVIS2', 'BESTSATS', 'TRACKSTAT',
  'ITDETECTSTATUS', 'GPSEPHEM', 'GLOEPHEMERIS', 'GALINAVEPHEMERIS', 'GALFNAVEPHEMERIS',
  'BDSEPHEMERIS', 'QZSSEPHEMERIS', 'NAVICEPHEMERIS',
]);

/**
 * Maintains a TCP or serial connection to the receiver and splits its stream into logs.
 * Events: 'status' (connection state), 'log' (parsed message).
 */
class ReceiverClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.socket = null;
    this.port = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectTimer = null;
    this.probeTimer = null;
    this.serialIdleTimer = null;
    this.stopped = true;
    // In 'auto' mode each connection cycle tries serial first, then falls back to TCP.
    this.autoTarget = 'serial';
    this.state = {
      connected: false,
      phase: 'stopped',
      retryAt: null,
      mode: options.transport || 'tcp',
      transport: this.activeTransport(),
      host: options.receiverHost,
      port: options.receiverPort,
      serialPath: options.serialPath,
      baudRate: options.serialBaudRate,
      lastError: null,
      lastDataAt: null,
    };
  }

  activeTransport() {
    if (this.options.transport === 'auto') return this.autoTarget;
    return this.options.transport === 'serial' ? 'serial' : 'tcp';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.autoTarget = 'serial';
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeCurrentTransport();
  }

  disconnect() {
    this.stop();
    this.updateState({ connected: false, phase: 'stopped', retryAt: null });
    return Promise.resolve();
  }

  reconfigure(settings) {
    this.stop();
    Object.assign(this.options, settings);
    this.buffer = Buffer.alloc(0);
    this.autoTarget = 'serial';
    this.stopped = false;
    this.updateState({
      mode: this.options.transport,
      transport: this.activeTransport(),
      host: this.options.receiverHost,
      port: this.options.receiverPort,
      serialPath: this.options.serialPath,
      baudRate: this.options.serialBaudRate,
      connected: false,
      phase: 'connecting',
      retryAt: null,
      lastError: null,
    });
    this.connect();
  }

  closeCurrentTransport() {
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
    clearTimeout(this.serialIdleTimer);
    this.serialIdleTimer = null;
    const socket = this.socket;
    const port = this.port;
    this.socket = null;
    this.port = null;
    if (socket && !socket.destroyed) socket.destroy();
    if (port && port.isOpen) {
      try {
        port.close((error) => {
          if (port === this.port && error && error.code !== 'ERR_PORT_NOT_OPEN') this.setError(error);
        });
      } catch (error) {
        this.setError(error);
      }
    }
  }

  connect() {
    this.stopped = false;
    if (this.socket || this.port) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.buffer = Buffer.alloc(0);
    this.updateState({ transport: this.activeTransport(), phase: 'connecting', retryAt: null });
    try {
      if (this.state.transport === 'serial') this.connectSerial();
      else this.connectTcp();
    } catch (error) {
      this.closeCurrentTransport();
      this.onAttemptFailed(error);
    }
  }

  /** In auto mode a failed serial attempt falls straight through to TCP; otherwise wait and retry. */
  onAttemptFailed(error) {
    this.setError(error);
    if (this.stopped) return;
    if (this.options.transport === 'auto' && this.autoTarget === 'serial') {
      this.autoTarget = 'tcp';
      console.warn(`[receiver] serial unavailable (${error.message || error}); falling back to TCP`);
      this.connect();
      return;
    }
    this.autoTarget = 'serial';
    this.scheduleReconnect();
  }

  connectTcp() {
    const { receiverHost, receiverPort, idleTimeoutMs } = this.options;
    const socket = net.createConnection({ host: receiverHost, port: receiverPort });
    this.socket = socket;
    socket.setKeepAlive(true, 10000);
    socket.setTimeout(idleTimeoutMs);

    socket.on('connect', () => {
      if (socket !== this.socket || this.stopped) return;
      this.onConnected();
      this.sendConfiguredCommands(socket);
    });
    socket.on('data', (chunk) => {
      if (socket === this.socket) this.onData(chunk);
    });
    socket.on('timeout', () => {
      socket.destroy(new Error(`No data received for ${idleTimeoutMs} ms`));
    });
    socket.on('error', (error) => {
      if (socket === this.socket) this.setError(error);
    });
    socket.on('close', () => this.onClosed(socket));
  }

  connectSerial() {
    const { serialPath, serialBaudRate } = this.options;
    const port = new SerialPort({ path: serialPath, baudRate: serialBaudRate, autoOpen: false });
    this.port = port;
    port.on('data', (chunk) => {
      if (port === this.port) this.onData(chunk);
    });
    port.on('error', (error) => {
      if (port === this.port) this.setError(error);
    });
    port.on('close', () => this.onClosed(port));
    port.open((error) => {
      if (port !== this.port || this.stopped) {
        if (!error && port.isOpen) {
          port.close((closeError) => {
            if (closeError) console.warn(`[receiver] could not close superseded serial port: ${closeError.message}`);
          });
        }
        return;
      }
      if (error) {
        this.port = null;
        this.onAttemptFailed(error);
        return;
      }
      this.onConnected();
      this.sendConfiguredCommands(port);
      this.startSerialProbe(port);
      this.armSerialIdle();
    });
  }

  /** Serial has no socket idle timeout, so recycle a silent open port on the same interval as TCP. */
  armSerialIdle() {
    const idleTimeoutMs = this.options.idleTimeoutMs;
    if (!this.port || this.stopped || !(idleTimeoutMs > 0)) return;
    clearTimeout(this.serialIdleTimer);
    this.serialIdleTimer = setTimeout(() => {
      this.serialIdleTimer = null;
      if (!this.port || this.stopped) return;
      this.setError(new Error(`No data received for ${idleTimeoutMs} ms`));
      this.closeCurrentTransport();
      this.autoTarget = 'serial';
      this.updateState({ connected: false, phase: 'waiting', retryAt: null });
      this.scheduleReconnect();
    }, idleTimeoutMs);
  }

  /** In auto mode, an open serial port only counts once it yields a decodable log (e.g. wrong baud fails). */
  startSerialProbe(port) {
    const probeMs = this.options.serialProbeMs;
    if (this.options.transport !== 'auto' || !(probeMs > 0)) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (port !== this.port || this.stopped) return;
      this.closeCurrentTransport();
      this.updateState({ connected: false, phase: this.stopped ? 'stopped' : 'waiting', retryAt: null });
      this.onAttemptFailed(new Error(
        `No NovAtel logs on ${this.options.serialPath} @ ${this.options.serialBaudRate} within ${probeMs} ms`,
      ));
    }, probeMs);
  }

  emitLog(message) {
    const name = message && message.header && message.header.messageName;
    if (this.probeTimer && message && message.crcValid === true && PROBE_LOGS.has(name)) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (message && message.crcValid === true && this.state.lastError) this.updateState({ lastError: null });
    this.emit('log', message);
  }

  sendConfiguredCommands(transport) {
    const profileCommands = this.options.sendLogCommands
      ? (this.options.logCommands || []).filter((command) => !/^LOG (?:ITDETECTSTATUS|BESTSATS|TRACKSTAT)[A-Z]? /i.test(command))
      : [];
    const commands = [
      ...(this.options.ephemerisLogCommands || []),
      ...profileCommands,
      'LOG BESTSATSA ONTIME 1',
      'LOG TRACKSTATA ONTIME 5',
      'LOG ITDETECTSTATUSA ONTIME 1',
    ];
    for (const command of commands) {
      try {
        transport.write(`${command}\r\n`, (error) => {
          if (error && transport === (this.socket || this.port)) this.setError(error);
        });
      } catch (error) {
        this.setError(error);
      }
    }
  }

  onConnected() {
    this.updateState({
      connected: true,
      phase: 'connected',
      retryAt: null,
      mode: this.options.transport || 'tcp',
      transport: this.activeTransport(),
      host: this.options.receiverHost,
      port: this.options.receiverPort,
      serialPath: this.options.serialPath,
      baudRate: this.options.serialBaudRate,
      lastError: null,
    });
  }

  onData(chunk) {
    this.state.lastDataAt = Date.now();
    if (this.port) this.armSerialIdle();
    this.ingest(chunk);
  }

  onClosed(transport) {
    if (transport !== this.socket && transport !== this.port) return;
    if (transport === this.socket) this.socket = null;
    if (transport === this.port) this.port = null;
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.autoTarget = 'serial';
    this.updateState({ connected: false, phase: this.stopped ? 'stopped' : 'waiting', retryAt: null });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.options.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.updateState({ phase: 'waiting', retryAt: Date.now() + delay });
  }

  setError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.state.lastError !== message) this.updateState({ lastError: message });
  }

  ingest(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = this.buffer.subarray(this.buffer.length - MAX_BUFFER_BYTES);
      this.setError(new Error('Receiver input exceeded the 1 MiB frame buffer; older bytes were discarded'));
    }

    while (this.buffer.length) {
      const previousBuffer = this.buffer;
      try {
        const binary = readBinaryLog(this.buffer);
        if (binary) {
          if (binary.need) break;
          this.buffer = this.buffer.subarray(binary.consumed);
          this.emitLog(binary.message);
          continue;
        }

        if (findSyncIndex(this.buffer) === 0 && this.buffer.length >= 3) {
          this.setError(new Error('Skipped an implausible NovAtel binary header'));
          this.buffer = this.buffer.subarray(1);
          continue;
        }

        const newlineIndex = this.buffer.indexOf(NEWLINE);
        const syncIndex = findSyncIndex(this.buffer);
        if (newlineIndex !== -1 && (syncIndex === -1 || newlineIndex < syncIndex)) {
          const hash = this.buffer.indexOf(0x23);
          const percent = this.buffer.indexOf(0x25);
          let marker = -1;
          if (hash !== -1 && hash < newlineIndex) marker = hash;
          if (percent !== -1 && percent < newlineIndex && (marker === -1 || percent < marker)) marker = percent;
          if (marker > 0) {
            this.buffer = this.buffer.subarray(marker);
            continue;
          }
          const line = this.buffer.toString('ascii', 0, newlineIndex);
          this.buffer = this.buffer.subarray(newlineIndex + 1);
          const message = parseAsciiLog(line);
          if (message) this.emitLog(message);
          continue;
        }

        if (syncIndex > 0) {
          this.buffer = this.buffer.subarray(syncIndex);
          continue;
        }
        break;
      } catch (error) {
        this.setError(error);
        if (this.buffer === previousBuffer) this.buffer = this.buffer.subarray(1);
      }
    }
  }

  updateState(patch) {
    Object.assign(this.state, patch);
    this.emit('status', { ...this.state });
  }
}

module.exports = { ReceiverClient };

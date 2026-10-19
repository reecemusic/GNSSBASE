'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { parseAsciiLog, readBinaryLog, findSyncIndex } = require('./novatel');

const MAX_BUFFER_BYTES = 1 << 20; // guard against a peer that never sends a delimiter
const NEWLINE = 0x0a;

/**
 * Maintains a TCP connection to the receiver and splits the stream into logs.
 * The stream may mix ASCII sentences with binary (0xAA 0x44 0x12) logs, so both
 * framings are handled in one pass.
 *
 * Events: 'status' (connection state), 'log' (parsed message).
 */
class ReceiverClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectTimer = null;
    this.stopped = false;
    this.state = { connected: false, host: options.receiverHost, port: options.receiverPort, lastError: null, lastDataAt: null };
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.destroy();
  }

  connect() {
    const { receiverHost, receiverPort, idleTimeoutMs } = this.options;
    this.buffer = Buffer.alloc(0);

    const socket = net.createConnection({ host: receiverHost, port: receiverPort });
    this.socket = socket;
    socket.setKeepAlive(true, 10000);
    socket.setTimeout(idleTimeoutMs);

    socket.on('connect', () => {
      this.updateState({ connected: true, lastError: null });
      for (const command of this.options.ephemerisLogCommands || []) {
        socket.write(`${command}\r\n`);
      }
      if (this.options.sendLogCommands) {
        for (const command of this.options.logCommands) {
          socket.write(`${command}\r\n`);
        }
      }
    });

    socket.on('data', (chunk) => {
      this.state.lastDataAt = Date.now();
      this.ingest(chunk);
    });

    socket.on('timeout', () => {
      socket.destroy(new Error(`No data received for ${idleTimeoutMs} ms`));
    });

    socket.on('error', (err) => {
      this.updateState({ lastError: err.message });
    });

    socket.on('close', () => {
      this.updateState({ connected: false });
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectDelayMs);
  }

  ingest(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = this.buffer.subarray(this.buffer.length - MAX_BUFFER_BYTES);
    }

    while (this.buffer.length) {
      const binary = readBinaryLog(this.buffer);
      if (binary) {
        if (binary.need) break; // rest of this log has not arrived yet
        this.buffer = this.buffer.subarray(binary.consumed);
        this.emit('log', binary.message);
        continue;
      }

      const newlineIndex = this.buffer.indexOf(NEWLINE);
      const syncIndex = findSyncIndex(this.buffer);

      if (newlineIndex !== -1 && (syncIndex === -1 || newlineIndex < syncIndex)) {
        const line = this.buffer.toString('ascii', 0, newlineIndex);
        this.buffer = this.buffer.subarray(newlineIndex + 1);
        const message = parseAsciiLog(line);
        if (message) this.emit('log', message);
        continue;
      }

      if (syncIndex > 0) {
        this.buffer = this.buffer.subarray(syncIndex); // drop leading noise
        continue;
      }

      break; // incomplete frame
    }
  }

  updateState(patch) {
    Object.assign(this.state, patch);
    this.emit('status', { ...this.state });
  }
}

module.exports = { ReceiverClient };

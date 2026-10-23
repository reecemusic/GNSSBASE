/**
 * TCP, serial, and auto transport for one NovAtel receiver.
 * Frames the byte stream into binary and ASCII logs and reports connection state.
 * 'status' comes from updateState as a shallow copy of state. 'log' comes from emitLog.
 * Message bodies are decoded by the server, not here.
 */
'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { SerialPort } = require('serialport');
const { parseAsciiLog, readBinaryLog, findSyncIndex } = require('./novatel');
const { logLimited } = require('./loglimit');

/** Reassembly cap. ingest drops the oldest bytes past this size. */
const MAX_BUFFER_BYTES = 1 << 20;
/** Line feed. ASCII logs are split on this byte. */
const NEWLINE = 0x0a;
/**
 * Names that prove the serial port is emitting NovAtel logs.
 * emitLog clears the auto-mode probe when crcValid is true and the message name is in this set.
 */
/**
 * ONTIME period for a log this process requests.
 * A positive integer is used as-is. Anything else, including a missing option,
 * returns fallback so existing callers keep BESTSATSA at 1 s and TRACKSTAT at 5 s.
 * @param {*} value options.bestsatsLogSeconds or options.trackstatLogSeconds.
 * @param {number} fallback Seconds used when value is not an integer >= 1.
 * @returns {number}
 * Side effects: none.
 * @emits none
 */
function logPeriodSeconds(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

const PROBE_LOGS = new Set([
  'VERSION', 'RXSTATUS', 'BESTPOS', 'BESTGNSSPOS', 'RANGE', 'SATVIS2', 'BESTSATS', 'TRACKSTAT',
  'ITDETECTSTATUS', 'GPSEPHEM', 'GLOEPHEMERIS', 'GALINAVEPHEMERIS', 'GALFNAVEPHEMERIS',
  'BDSEPHEMERIS', 'QZSSEPHEMERIS', 'NAVICEPHEMERIS',
]);

/**
 * One live connection to the receiver. Splits its stream into logs.
 * Events: 'status' from updateState (a shallow copy of state), 'log' from emitLog.
 */
class ReceiverClient extends EventEmitter {
  /**
   * Stores options and the idle connection state. Does not open a socket or port.
   * @param {object} options Settings kept on this.options. The constructor reads
   *   transport, receiverHost, receiverPort, serialPath, and serialBaudRate.
   *   Later methods also read idleTimeoutMs, reconnectDelayMs, serialProbeMs,
   *   sendLogCommands, logCommands, and ephemerisLogCommands.
   * @returns {void}
   * Side effects: stopped starts true, autoTarget starts at 'serial', buffer is empty.
   *   No I/O, timers, logs, or throws of its own. Reading options throws if options is missing.
   * @emits none
   */
  constructor(options) {
    super();
    this.options = options;
    this.socket = null;
    this.port = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectTimer = null;
    this.probeTimer = null;
    this.logTimer = null;
    this.serialIdleTimer = null;
    this.stopped = true;
    // Auto mode tries serial first. onAttemptFailed moves this to 'tcp' after a
    // failed serial attempt and connects immediately. Other failures put it back
    // to 'serial' and wait for scheduleReconnect.
    this.autoTarget = 'serial';
    this.serialRateWarned = false;
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

  /**
   * Transport this cycle should open.
   * @returns {'serial'|'tcp'} In auto mode, the current autoTarget. Otherwise 'serial'
   *   only when options.transport is 'serial'; every other value is 'tcp'.
   * Side effects: none.
   * @emits none
   */
  activeTransport() {
    if (this.options.transport === 'auto') return this.autoTarget;
    return this.options.transport === 'serial' ? 'serial' : 'tcp';
  }

  /**
   * Begins connecting unless a session is already running.
   * @returns {void} Returns immediately when stopped is already false.
   * Side effects: sets stopped false, sets autoTarget to 'serial', then calls connect,
   *   which may open a socket or serial port and arm timers.
   * @emits status through connect and updateState.
   */
  start() {
    // Already running: leave the open transport and the reconnect timer alone.
    if (!this.stopped) return;
    // A new session starts on serial. connect() opens whichever activeTransport reports.
    this.stopped = false;
    this.autoTarget = 'serial';
    this.connect();
  }

  /**
   * Stops reconnects and closes the current transport.
   * @returns {void}
   * Side effects: sets stopped, clears the reconnect timer, and closes the socket or
   *   serial port through closeCurrentTransport (which also clears the probe and serial-idle
   *   timers). Does not by itself change phase; disconnect does that.
   * @emits status only when closeCurrentTransport reports a synchronous close error via setError.
   */
  stop() {
    this.stopped = true;
    // Drop a pending reconnect before closing so it cannot fire against a stopped client.
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeCurrentTransport();
  }

  /**
   * Stops the client and publishes phase 'stopped'.
   * @returns {Promise<void>} An already fulfilled promise.
   * Side effects: same as stop, then updateState with connected false, phase 'stopped',
   *   and retryAt null. The fulfilled promise does no further I/O.
   * @emits status
   */
  disconnect() {
    // stop() closes the transport. Phase is set to stopped after that returns.
    this.stop();
    // disconnect is what publishes phase 'stopped'. stop() only sets the flag and closes.
    this.updateState({ connected: false, phase: 'stopped', retryAt: null });
    return Promise.resolve();
  }

  /**
   * Applies new connection settings and connects again.
   * Copies settings onto options, clears the byte buffer and lastError, then connect.
   * @param {object} settings Own enumerable properties copied onto this.options.
   * @returns {void}
   * Side effects: stop() clears timers and closes the current transport. Replaces
   *   this.buffer, sets autoTarget to 'serial', and sets stopped false before connect.
   * @emits status from the updateState below and from connect.
   */
  reconfigure(settings) {
    this.stop();
    // Settings are copied onto the existing options object.
    Object.assign(this.options, settings);
    // Clear the byte buffer before the new link frames its first bytes.
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
      // lastError is cleared as part of the same state publish, then connect() runs.
      lastError: null,
    });
    this.connect();
  }

  /**
   * Clears idle and probe timers and drops the current socket or serial port.
   * @returns {void}
   * Side effects: clears probeTimer and serialIdleTimer. Sets this.socket and this.port
   *   to null before destroy or close, so a late error cannot be attributed to the next
   *   connection. Destroys the socket when it exists and is not already destroyed. Closes
   *   an open serial port. A synchronous throw from port.close is passed to setError.
   *   Logs nothing itself.
   * @emits status when setError changes lastError.
   */
  closeCurrentTransport() {
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
    clearTimeout(this.logTimer);
    this.logTimer = null;
    clearTimeout(this.serialIdleTimer);
    this.serialIdleTimer = null;
    const socket = this.socket;
    const port = this.port;
    // Null the references before destroy/close. The close callback below uses identity
    // so a late error cannot stamp the next connection.
    this.socket = null;
    this.port = null;
    if (socket && !socket.destroyed) socket.destroy();
    if (port && port.isOpen) {
      try {
        /**
         * Late close result. this.port was cleared above, so this error is applied only
         * when the same port object is current again.
         * @param {Error|null|undefined} error
         * @returns {void}
         * Side effects: setError only when port === this.port and code is not ERR_PORT_NOT_OPEN.
         * @emits status when that setError changes lastError.
         */
        port.close((error) => {
          // this.port was nulled before close(). Set an error only when this same port
          // object is current again and the code is not ERR_PORT_NOT_OPEN.
          if (port === this.port && error && error.code !== 'ERR_PORT_NOT_OPEN') this.setError(error);
        });
      } catch (error) {
        this.setError(error);
      }
    }
  }

  /**
   * Opens the transport selected by activeTransport.
   * @returns {void} Returns immediately if this.socket or this.port is already held,
   *   and that return happens before the reconnect timer or the byte buffer is cleared.
   *   Otherwise clears the reconnect timer and the byte buffer, publishes phase
   *   'connecting', and opens serial or TCP.
   * Side effects: sets stopped false even on the early return. May create a socket or
   *   SerialPort, arm socket timeouts, and write configuration commands once connected.
   *   A synchronous throw from connectSerial or connectTcp closes the transport and
   *   becomes an attempt failure. No direct console logging.
   * @emits status
   */
  connect() {
    // stopped is cleared even when a socket or port is already held and this returns.
    this.stopped = false;
    // A socket or port is already held. Return before touching the timer or the buffer.
    if (this.socket || this.port) return;
    clearTimeout(this.reconnectTimer);
    // The early return above already happened. Clear the reconnect timer and the byte buffer.
    this.reconnectTimer = null;
    // Drop bytes left over from the previous attempt.
    this.buffer = Buffer.alloc(0);
    this.updateState({ connected: false, transport: this.activeTransport(), phase: 'connecting', retryAt: null });
    try {
      if (this.state.transport === 'serial') this.connectSerial();
      else this.connectTcp();
    } catch (error) {
      this.closeCurrentTransport();
      this.onAttemptFailed(error);
    }
  }

  /**
   * Records a failed open or probe and chooses the next attempt.
   * In auto mode a failed serial attempt switches autoTarget to tcp and connects
   * immediately. Any other failure resets autoTarget to serial and scheduleReconnect.
   * @param {Error|string} error Failure from open, probe timeout, or a synchronous connect throw.
   * @returns {void} Returns without scheduling when stopped is set.
   * Side effects: setError mutates lastError. The serial-to-TCP path logs a console warning.
   *   scheduleReconnect arms reconnectTimer. Does not throw.
   * @emits status through setError, connect, or scheduleReconnect.
   */
  onAttemptFailed(error) {
    this.setError(error);
    // Already stopping: record the error and do not open another transport.
    if (this.stopped) return;
    // Auto mode: this serial failure switches to TCP and connects immediately.
    if (this.options.transport === 'auto' && this.autoTarget === 'serial') {
      this.autoTarget = 'tcp';
      // Auto mode retries serial, then TCP, for as long as the receiver is down.
      // The first line is printed; later cycles are counted once a minute.
      logLimited('warn', 'serial-fallback', `[receiver] serial unavailable (${error.message || error}); falling back to TCP`);
      this.connect();
      return;
    }
    // Any other failure retries from serial after the reconnect delay.
    this.autoTarget = 'serial';
    this.scheduleReconnect();
  }

  /**
   * Opens a TCP socket to receiverHost:receiverPort and wires its listeners.
   * @returns {void}
   * Side effects: net.createConnection, setKeepAlive(true, 10000), and
   *   socket.setTimeout(idleTimeoutMs). The timeout handler destroys the socket with
   *   an error. Assigns this.socket. Commands are written after the connect event.
   *   Throws only if creating or configuring the socket throws, which connect() catches.
   * @emits status and log through the socket listeners (onConnected, onData, setError, onClosed).
   */
  connectTcp() {
    const { receiverHost, receiverPort, idleTimeoutMs } = this.options;
    const socket = net.createConnection({ host: receiverHost, port: receiverPort });
    this.socket = socket;
    socket.setKeepAlive(true, 10000);
    // TCP idle is socket.setTimeout(idleTimeoutMs). The timeout listener destroys the socket.
    socket.setTimeout(idleTimeoutMs);

    /**
     * Completes TCP setup when this socket is still current and the client is not stopped.
     * @returns {void}
     * Side effects: onConnected and sendConfiguredCommands.
     * @emits status, and status again if a command write fails.
     */
    socket.on('connect', () => {
      if (socket !== this.socket || this.stopped) return;
      this.onConnected();
      this.sendConfiguredCommands(socket);
    });
    /**
     * Forwards bytes only when this socket is still this.socket.
     * @param {Buffer} chunk
     * @returns {void}
     * Side effects: onData.
     * @emits log or status through ingest.
     */
    socket.on('data', (chunk) => {
      if (socket === this.socket) this.onData(chunk);
    });
    /**
     * Idle handler. Destroys the socket with an error so the error and close listeners run.
     * @returns {void}
     * Side effects: socket.destroy with `No data received for <idleTimeoutMs> ms`.
     * @emits none directly. error and close then call setError and onClosed.
     */
    socket.on('timeout', () => {
      socket.destroy(new Error(`No data received for ${idleTimeoutMs} ms`));
    });
    /**
     * Records a socket error only while this socket is current.
     * @param {Error} error
     * @returns {void}
     * Side effects: setError.
     * @emits status when the message changes. close is a separate event.
     */
    socket.on('error', (error) => {
      if (socket === this.socket) this.setError(error);
    });
    /**
     * Always forwards to onClosed, which ignores a socket that is no longer current.
     * @returns {void}
     * Side effects: onClosed.
     * @emits status when this socket is still current.
     */
    socket.on('close', () => this.onClosed(socket));
  }

  /**
   * Opens the configured serial port with autoOpen false.
   * @returns {void}
   * Side effects: constructs a SerialPort, assigns this.port, and calls port.open.
   *   On success: onConnected, sendConfiguredCommands, startSerialProbe, and armSerialIdle.
   *   On an open error: clears this.port and onAttemptFailed. A port that opens after it
   *   was superseded or after stop is closed, with a console warning if that close fails.
   *   A synchronous throw escapes to connect().
   * @emits status and log through the open path and the port listeners.
   */
  connectSerial() {
    const { serialPath, serialBaudRate } = this.options;
    const port = new SerialPort({ path: serialPath, baudRate: serialBaudRate, autoOpen: false });
    this.port = port;
    /**
     * Forwards serial bytes only while this port object is current.
     * @param {Buffer} chunk
     * @returns {void}
     * Side effects: onData, which re-arms serial idle.
     * @emits log or status through ingest.
     */
    port.on('data', (chunk) => {
      if (port === this.port) this.onData(chunk);
    });
    /**
     * Records a serial error only while this port object is current.
     * @param {Error} error
     * @returns {void}
     * Side effects: setError. Does not by itself reconnect; close does.
     * @emits status when the message changes.
     */
    port.on('error', (error) => {
      if (port === this.port) this.setError(error);
    });
    /**
     * Forwards to onClosed, which ignores a port that is no longer current.
     * @returns {void}
     * Side effects: onClosed.
     * @emits status when this port is still current.
     */
    port.on('close', () => this.onClosed(port));
    /**
     * Open callback. Superseded and stopped ports are closed if the open succeeded.
     * An open error clears this.port and fails the attempt. Success sends commands,
     * starts the auto-mode probe, and arms serial idle.
     * @param {Error|null} error
     * @returns {void}
     * Side effects: port.close, onAttemptFailed, onConnected, writes, timers.
     * @emits status, and log later from received bytes.
     */
    port.open((error) => {
      if (port !== this.port || this.stopped) {
        // Open won the race with stop or a newer port. Close it and do not treat it as connected.
        if (!error && port.isOpen) {
          /**
           * Logs a failed close of a port that must not stay open.
           * @param {Error|null} closeError
           * @returns {void}
           * Side effects: console.warn when closeError is set. Does not call setError.
           * @emits none
           */
          port.close((closeError) => {
            if (closeError) console.warn(`[receiver] could not close superseded serial port: ${closeError.message}`);
          });
        }
        return;
      }
      if (error) {
        // The failed port must not count as held, or the TCP fallback's connect() would return early.
        this.port = null;
        this.onAttemptFailed(error);
        return;
      }
      this.onConnected();
      this.sendConfiguredCommands(port);
      // Probe only matters in auto mode, and only after the port is actually open.
      this.startSerialProbe(port);
      // Idle is armed on open and re-armed from onData on each chunk.
      this.armSerialIdle();
    });
  }

  /**
   * Arms the serial idle timer. Serial has no socket idle timeout, so a silent open
   * port is recycled on the same interval as TCP.
   * Called after a successful open and again from onData for every chunk.
   * @returns {void} No-op when there is no port, the client is stopped, or idleTimeoutMs is not > 0.
   * Side effects: replaces serialIdleTimer. If the timer fires while the port is still
   *   current and the client is not stopped, it sets lastError, closes the port, forces
   *   autoTarget back to 'serial', publishes phase 'waiting', and calls scheduleReconnect.
   *   That path does not call onAttemptFailed, so auto mode does not jump to TCP on silence.
   * @emits status from setError, updateState, and scheduleReconnect.
   */
  armSerialIdle() {
    const idleTimeoutMs = this.options.idleTimeoutMs;
    if (!this.port || this.stopped || !(idleTimeoutMs > 0)) return;
    clearTimeout(this.serialIdleTimer);
    this.serialIdleTimer = setTimeout(() => {
      // Timer fired. Forget the handle before deciding whether the port is still current.
      this.serialIdleTimer = null;
      // The port was closed, or stop() won, while this timer was waiting.
      if (!this.port || this.stopped) return;
      // Silence sets lastError and schedules a serial reconnect. This does not call
      // onAttemptFailed, so auto mode does not jump to TCP.
      this.setError(new Error(`No data received for ${idleTimeoutMs} ms`));
      // Closing here also clears a probe timer, so a silent port does not also fail over to TCP.
      this.closeCurrentTransport();
      // Force serial. scheduleReconnect waits; it does not open TCP immediately.
      this.autoTarget = 'serial';
      this.updateState({ connected: false, phase: 'waiting', retryAt: null });
      this.scheduleReconnect();
    }, idleTimeoutMs);
  }

  /**
   * In auto mode, an open serial port only counts once it yields a decodable log.
   * Only runs when options.transport is 'auto' and serialProbeMs > 0. Armed from
   * connectSerial after a successful open. emitLog clears it when crcValid is true
   * and the message name is in PROBE_LOGS. closeCurrentTransport and onClosed clear
   * it as well, including when serial idle closes a silent port first.
   * @param {import('serialport').SerialPort} port Port that just opened. The timer
   *   no-ops if this.port has since changed.
   * @returns {void}
   * Side effects: arms probeTimer. On timeout, closes the port and calls onAttemptFailed,
   *   which in auto mode falls through to TCP. Does not throw.
   * @emits status through closeCurrentTransport, updateState, and onAttemptFailed.
   */
  startSerialProbe(port) {
    const probeMs = this.options.serialProbeMs;
    // The probe runs only in auto mode, and only when serialProbeMs is a positive number.
    if (this.options.transport !== 'auto' || !(probeMs > 0)) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      // The port changed or the client stopped before the probe deadline.
      if (port !== this.port || this.stopped) return;
      // No CRC-valid probe log in time. Close the port and fail the attempt, which falls through to TCP.
      this.closeCurrentTransport();
      this.updateState({ connected: false, phase: this.stopped ? 'stopped' : 'waiting', retryAt: null });
      this.onAttemptFailed(new Error(
        `No NovAtel logs on ${this.options.serialPath} @ ${this.options.serialBaudRate} within ${probeMs} ms`,
      ));
    }, probeMs);
  }

  /**
   * Hands a parsed message to listeners and retires a successful serial probe.
   * @param {object} message Parsed log. Connection health requires crcValid === true.
   *   The probe also requires header.messageName to be in PROBE_LOGS.
   * @returns {void}
   * Side effects: may clear probeTimer, reset logTimer, mark connected, or clear lastError.
   *   Does not log or throw.
   * @emits log always. Emits status when a CRC-valid message clears a previous lastError.
   */
  emitLog(message) {
    const name = message && message.header && message.header.messageName;
    if (message && message.crcValid === true) {
      if (this.probeTimer && PROBE_LOGS.has(name)) {
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
      }
      const transport = this.socket || this.port;
      if (transport && !this.stopped) {
        // Other profile logs may resume after reboot without restoring our ONTIME requests.
        if (name === 'ITDETECTSTATUS') this.startLogWatchdog(transport);
        if (!this.state.connected) {
          this.updateState({ connected: true, phase: 'connected', lastError: null });
        }
      }
    }
    // Any CRC-valid log clears a sticky lastError. The probe set is not required here.
    if (message && message.crcValid === true && this.state.lastError) this.updateState({ lastError: null });
    this.emit('log', message);
  }

  startLogWatchdog(transport) {
    clearTimeout(this.logTimer);
    this.logTimer = null;
    const timeoutMs = this.options.idleTimeoutMs;
    if (!(timeoutMs > 0)) return;
    this.logTimer = setTimeout(() => {
      this.logTimer = null;
      if (this.stopped || transport !== (this.socket || this.port)) return;
      this.closeCurrentTransport();
      this.updateState({ connected: false, phase: 'waiting', retryAt: null });
      this.onAttemptFailed(new Error(`No valid ITDETECTSTATUS logs received for ${timeoutMs} ms`));
    }, timeoutMs);
  }

  /**
   * Writes the NovAtel log requests for this session.
   * Always sends options.ephemerisLogCommands, then profile logCommands only when
   * options.sendLogCommands is true. Profile lines matching
   * /^LOG (?:ITDETECTSTATUS|BESTSATS|TRACKSTAT)[A-Z]? /i are filtered out. The list
   * always ends with LOG BESTSATSA ONTIME <bestsatsLogSeconds>, LOG TRACKSTATA
   * ONTIME <trackstatLogSeconds>, and LOG ITDETECTSTATUSA ONTIME 1. Those two
   * periods default to 1 and 5 when the option is missing or not a positive integer.
   * The send flag is options.sendLogCommands. Baud is not changed and SAVECONFIG
   * is never sent.
   * @param {import('node:net').Socket|import('serialport').SerialPort} transport Open socket or port.
   * @returns {void}
   * Side effects: one transport.write per command, each ending in CR LF, without waiting
   *   for the previous callback. A write callback calls setError only when that transport
   *   is still current (transport === this.socket || this.port). A synchronous throw from
   *   write() calls setError for that command and the loop continues. Does not throw.
   * @emits status when setError changes lastError.
   */
  sendConfiguredCommands(transport) {
    // Profile commands are included only when options.sendLogCommands is true, and
    // LOG ITDETECTSTATUS / BESTSATS / TRACKSTAT lines (one optional letter) are removed.
    const profileCommands = this.options.sendLogCommands
      ? (this.options.logCommands || []).filter((command) => !/^LOG (?:ITDETECTSTATUS|BESTSATS|TRACKSTAT)[A-Z]? /i.test(command))
      : [];
    const commands = [
      // Ephemeris commands are always sent. The three logs below are always appended after the profile.
      ...(this.options.ephemerisLogCommands || []),
      ...profileCommands,
      `LOG BESTSATSA ONTIME ${logPeriodSeconds(this.options.bestsatsLogSeconds, 1)}`,
      `LOG TRACKSTATA ONTIME ${logPeriodSeconds(this.options.trackstatLogSeconds, 5)}`,
      'LOG ITDETECTSTATUSA ONTIME 1',
    ];
    for (const command of commands) {
      try {
        transport.write(`${command}\r\n`, (error) => {
          // Write errors are reported only while this transport is still the current socket or port.
          if (error && transport === (this.socket || this.port)) this.setError(error);
        });
      } catch (error) {
        this.setError(error);
      }
    }
  }

  /**
   * Publishes the open transport as connecting until a CRC-valid log arrives.
   * @returns {void}
   * Side effects: mutates state through updateState. Copies mode, transport, host, port,
   *   serial path, and baud from the current options. Arms the periodic-log watchdog.
   * @emits status
   */
  onConnected() {
    this.updateState({
      connected: false,
      phase: 'connecting',
      retryAt: null,
      mode: this.options.transport || 'tcp',
      transport: this.activeTransport(),
      host: this.options.receiverHost,
      port: this.options.receiverPort,
      serialPath: this.options.serialPath,
      baudRate: this.options.serialBaudRate,
      lastError: null,
    });
    this.startLogWatchdog(this.socket || this.port);
    this.warnIfSerialOversubscribed();
  }

  /**
   * Warns once when this connection is serial at 19200 baud or below.
   * BESTSATSA once a second plus TRACKSTAT every five seconds can exceed a real
   * RS-232 link at 9600 baud (about 960 bytes/s). USB virtual COM ports are not
   * limited that way. The baud and the receiver's saved configuration are left
   * alone; BESTSATS_LOG_SEC and TRACKSTAT_LOG_SEC slow only the two requests
   * this process sends. SAVECONFIG is not sent.
   * @returns {void}
   * Side effects: one console.warn per ReceiverClient, the first time the active
   *   transport is serial and serialBaudRate is finite and <= 19200. No I/O to the receiver.
   * @emits none
   */
  warnIfSerialOversubscribed() {
    if (this.serialRateWarned) return;
    if (this.activeTransport() !== 'serial') return;
    const baud = Number(this.options.serialBaudRate);
    if (!Number.isFinite(baud) || baud > 19200) return;
    this.serialRateWarned = true;
    const bestsats = logPeriodSeconds(this.options.bestsatsLogSeconds, 1);
    const trackstat = logPeriodSeconds(this.options.trackstatLogSeconds, 5);
    console.warn(`[receiver] serial at ${baud} baud may be oversubscribed by LOG BESTSATSA ONTIME ${bestsats} `
      + `and LOG TRACKSTATA ONTIME ${trackstat}. If this port is real RS-232, set BESTSATS_LOG_SEC and `
      + 'TRACKSTAT_LOG_SEC to slow those two logs. Baud and the receiver configuration are unchanged.');
  }

  /**
   * Records that bytes arrived, re-arms serial idle, and frames the chunk.
   * @param {Buffer} chunk Newly received bytes.
   * @returns {void}
   * Side effects: writes this.state.lastDataAt directly, so that field changes without
   *   a status event. When this.port is set, replaces the serial idle timer. Appends to
   *   the reassembly buffer inside ingest.
   * @emits log and status only through ingest and emitLog.
   */
  onData(chunk) {
    // Direct write: lastDataAt changes without an extra status event.
    this.state.lastDataAt = Date.now();
    // Each serial chunk re-arms idle. TCP silence is handled by socket.setTimeout instead.
    if (this.port) this.armSerialIdle();
    this.ingest(chunk);
  }

  /**
   * Handles a close from the socket or serial port that is still current.
   * @param {import('node:net').Socket|import('serialport').SerialPort} transport Object that closed.
   * @returns {void} Returns immediately when transport is neither this.socket nor this.port,
   *   so a superseded connection cannot schedule a reconnect.
   * Side effects: nulls the matching field, clears probeTimer, sets autoTarget to 'serial',
   *   and scheduleReconnect. Phase becomes 'stopped' when stopped is set, otherwise 'waiting'.
   * @emits status
   */
  onClosed(transport) {
    // Close from a socket or port that was already replaced.
    if (transport !== this.socket && transport !== this.port) return;
    if (transport === this.socket) this.socket = null;
    if (transport === this.port) this.port = null;
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
    clearTimeout(this.logTimer);
    this.logTimer = null;
    clearTimeout(this.serialIdleTimer);
    this.serialIdleTimer = null;
    // The next attempt starts on serial. scheduleReconnect is a no-op while stopped.
    this.autoTarget = 'serial';
    this.updateState({ connected: false, phase: this.stopped ? 'stopped' : 'waiting', retryAt: null });
    this.scheduleReconnect();
  }

  /**
   * Arms one reconnect timer.
   * @returns {void} No-op when stopped is set or a reconnect timer already exists.
   * Side effects: sets reconnectTimer for options.reconnectDelayMs. The timer calls connect.
   *   Publishes phase 'waiting' and retryAt = now + delay. Does not log or throw.
   * @emits status
   */
  scheduleReconnect() {
    // No-op while stopped, or while a reconnect timer is already armed.
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.options.reconnectDelayMs;
    /**
     * Reconnect callback. Clears the timer handle and opens the transport again.
     * @returns {void}
     * Side effects: connect(), which may open a socket or port.
     * @emits status through connect.
     */
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.updateState({ phase: 'waiting', retryAt: Date.now() + delay });
  }

  /**
   * Publishes lastError when the message actually changed.
   * @param {Error|string} error Stored as error.message, or String(error) when it is not an Error.
   * @returns {void}
   * Side effects: updateState only when state.lastError differs. No I/O and no throw.
   * @emits status when the text changes. No event when the same error is repeated.
   */
  setError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.state.lastError !== message) this.updateState({ lastError: message });
  }

  /**
   * Appends chunk and pulls every complete log out of the reassembly buffer.
   * @param {Buffer} chunk Bytes to append. An empty buffer is replaced by chunk itself;
   *   otherwise the buffers are concatenated.
   * @returns {void}
   * Side effects: mutates this.buffer. A buffer past MAX_BUFFER_BYTES (1 MiB) keeps the
   *   newest bytes and setError reports the drop. readBinaryLog's need result waits.
   *   A buffer that starts with AA 44 12 or AA 44 13 and is rejected by readBinaryLog
   *   (null) skips one byte and sets lastError to 'Skipped an implausible NovAtel binary header'.
   *   ASCII is taken only when a newline occurs before the next sync. On throw, setError,
   *   and if this.buffer was not replaced on that pass, one byte is dropped so the framer
   *   cannot stall. Does not throw.
   * @emits log through emitLog, and status through setError or emitLog.
   */
  ingest(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // 1 MiB cap: keep the tail and drop the oldest bytes.
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = this.buffer.subarray(this.buffer.length - MAX_BUFFER_BYTES);
      this.setError(new Error('Receiver input exceeded the 1 MiB frame buffer; older bytes were discarded'));
    }

    while (this.buffer.length) {
      const previousBuffer = this.buffer;
      try {
        const binary = readBinaryLog(this.buffer);
        if (binary) {
          // readBinaryLog has a real header and is waiting for the rest of the frame.
          if (binary.need) break;
          this.buffer = this.buffer.subarray(binary.consumed);
          this.emitLog(binary.message);
          continue;
        }

        // Starts with AA 44 12 or AA 44 13, but readBinaryLog returned null. Skip one byte.
        if (findSyncIndex(this.buffer) === 0 && this.buffer.length >= 3) {
          this.setError(new Error('Skipped an implausible NovAtel binary header'));
          this.buffer = this.buffer.subarray(1);
          continue;
        }

        const newlineIndex = this.buffer.indexOf(NEWLINE);
        const syncIndex = findSyncIndex(this.buffer);
        // ASCII is taken only when a newline occurs before the next binary sync.
        if (newlineIndex !== -1 && (syncIndex === -1 || newlineIndex < syncIndex)) {
          const hash = this.buffer.indexOf(0x23);
          const percent = this.buffer.indexOf(0x25);
          let marker = -1;
          if (hash !== -1 && hash < newlineIndex) marker = hash;
          if (percent !== -1 && percent < newlineIndex && (marker === -1 || percent < marker)) marker = percent;
          // Junk ahead of '#' (0x23) or '%' (0x25) on this line is skipped; parsing waits until it is at index 0.
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

        // No complete ASCII line before the next sync. Discard the leading bytes.
        if (syncIndex > 0) {
          this.buffer = this.buffer.subarray(syncIndex);
          continue;
        }
        break;
      } catch (error) {
        this.setError(error);
        // The throw did not replace the buffer, so this pass did not shrink it. Drop one byte
        // so the framer cannot stall on the same input.
        if (this.buffer === previousBuffer) this.buffer = this.buffer.subarray(1);
      }
    }
  }

  /**
   * Merges patch into this.state and emits a shallow copy.
   * @param {object} patch Fields assigned onto this.state.
   * @returns {void}
   * Side effects: mutates this.state. The emitted object is a shallow copy taken after
   *   the assign, so listeners do not hold the live state object. No I/O and no throw.
   * @emits status
   */
  updateState(patch) {
    Object.assign(this.state, patch);
    // Shallow copy. Listeners do not see later writes to this.state, including lastDataAt.
    this.emit('status', { ...this.state });
  }
}

module.exports = { ReceiverClient };

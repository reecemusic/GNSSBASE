/**
 * HTTP and Server-Sent Events front end for the GNSS base UI.
 * Serves the static page, JSON routes, and a live event stream.
 * Owns the receiver client, the in-memory store, satellite and interference
 * history, and the interference archive.
 */
'use strict';

// The libuv pool is created on first use of fs, dns, or zlib. Set the size before
// any of those run. A hung NAS read pins one worker; the default pool has four,
// so a few stuck scans stall history saves and static files. An explicit env value
// is kept. src/start.js sets the same default before this file is loaded.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SerialPort } = require('serialport');

const config = require('./config');
const { ReceiverClient } = require('./receiver');
const { decode } = require('./messages');
const { saneTimestamp } = require('./novatel');
const { History } = require('./history');
const { InterferenceArchive } = require('./archive');
const { logLimited } = require('./loglimit');

/**
 * Logs an unhandled promise rejection. Does not call process.exit.
 * @param {*} reason Error, or any other rejection value.
 * @returns {void}
 * Side effects: console.error of reason.stack, reason.message, or String(reason).
 * @emits none
 */
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error(`[process] unhandledRejection: ${message}`);
});
/**
 * Logs an uncaught exception. Does not call process.exit.
 * @param {Error} error
 * @returns {void}
 * Side effects: console.error of error.stack or error.message.
 * @emits none
 */
process.on('uncaughtException', (error) => {
  console.error(`[process] uncaughtException: ${error.stack || error.message}`);
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HTTP_HEADERS_TIMEOUT_MS = 15_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
};
/** At most one ephemeris SSE frame per this many milliseconds, however many satellites arrived. */
const EPHEMERIS_COALESCE_MS = 250;

/**
 * Live view filled by processReceiverLog.
 * latest is the last CRC-valid decoded record per message name.
 * counts includes decode failures. itdetectHistory keeps recent ITDETECTSTATUS
 * records, including a failed CRC. itdetectBySignal is sent in snapshots and is
 * not written by processReceiverLog. rawLog is capped by config.rawLogSize.
 */
const store = {
  latest: {},
  counts: {},
  itdetectHistory: [],
  itdetectBySignal: {},
  satvisBySystem: {},
  ephemeris: {},
  rawLog: [],
};

const clients = new Set();
let latestStatus = null;

const history = new History({
  retentionMs: config.historyRetentionMinutes * 60000,
  trackSampleMs: config.trackSampleSeconds * 1000,
  maxInterferenceSamples: config.maxInterferenceSamples,
  filePath: config.historyFile,
});
// Load the history file before the prune and save timers start.
history.load();
/**
 * Prunes history every 60 seconds.
 * @returns {void}
 * Side effects: history.prune(). unref() so this timer does not keep the process alive.
 * @emits none
 */
setInterval(() => history.prune(), 60000).unref();
/**
 * Saves history every config.historySaveSeconds seconds when a history file is configured.
 * @returns {void}
 * Side effects: history.save(). The interval is unref'd, same as the prune timer.
 * @emits none
 */
if (config.historyFile) setInterval(() => history.save(), config.historySaveSeconds * 1000).unref();

const archive = new InterferenceArchive({
  defaultRoot: config.archiveRoot,
  defaultDays: config.archiveDefaultDays,
  maxDays: config.archiveMaxDays,
  maxSamples: config.archiveMaxSamples,
  cacheDir: config.archiveCacheDir,
  settingsFile: config.archiveSettingsFile,
  defaultAuto: config.archiveAuto,
  refreshMs: config.archiveRefreshMinutes * 60000,
  fsTimeoutMs: config.archiveTimeoutSeconds * 1000,
  stallTimeoutMs: Math.max(60, config.archiveTimeoutSeconds * 6) * 1000,
});
/**
 * Forwards archive status to SSE clients as an 'archive' event.
 * @param {object} status Value from the archive 'status' event.
 * @returns {void}
 * Side effects: broadcast writes to current SSE clients.
 * @emits none
 */
archive.on('status', (status) => broadcast('archive', status));

// Apply a saved connection file, or its .bak, onto config before the receiver is built.
const savedConnection = config.loadConnectionOverrides(config.connectionSettingsFile);
if (savedConnection) Object.assign(config, savedConnection);

const receiver = new ReceiverClient(config);

let lastStatusLog = '';
/**
 * Remembers the latest receiver status, logs it when the summary changes, and broadcasts it.
 * @param {object} state Shallow status copy emitted by the receiver.
 * @returns {void}
 * Side effects: assigns latestStatus. console.log when the summary line differs from
 *   lastStatusLog. Repeats of a changing pair (connected, then disconnected) are
 *   counted and summarised once a minute by logLimited. The line names the serial
 *   path and baud, or host:port, and appends lastError when it is set. Then
 *   broadcast('status', state).
 * @emits none
 */
receiver.on('status', (state) => {
  latestStatus = state;
  const target = state.transport === 'serial'
    ? `${state.serialPath} @ ${state.baudRate}`
    : `${state.host}:${state.port}`;
  const line = `[receiver] ${state.connected ? 'connected to' : 'disconnected from'} ${target}${state.lastError ? ` (${state.lastError})` : ''}`;
  // An identical line is not logged again. Two alternating lines used to defeat that
  // check and print on every reconnect. Those changes share one rate-limit bucket.
  if (line !== lastStatusLog) logLimited('log', 'receiver-status', line);
  lastStatusLog = line;
  broadcast('status', state);
});

/**
 * Passes one parsed receiver log to processReceiverLog.
 * @param {object} message Parsed log from the receiver 'log' event.
 * @returns {void}
 * Side effects: a throw here is console.error'd. Decode failures are handled inside
 *   processReceiverLog and do not reach this catch. This handler does not call setError.
 * @emits none
 */
receiver.on('log', (message) => {
  try {
    processReceiverLog(message);
  } catch (error) {
    console.error(`[receiver] could not process log: ${error.stack || error.message}`);
  }
});

/**
 * Decodes one receiver log into the live store, history, and an SSE 'message' event.
 * History timestamps use saneTimestamp(header.utc, receivedAt) via reportTimestamp.
 * @param {object} message Parsed log.
 * @returns {void}
 * Side effects: a decode throw is logged, passed to receiver.setError, counted, appended
 *   to rawLog as a diagnostic, broadcast, and then ignored for store.latest, so the last
 *   good record stays. CRC-valid records update store.latest. A failed CRC still goes to
 *   the raw log, and an ITDETECTSTATUS record still goes to itdetectHistory. Trusted
 *   ephemeris, BESTPOS, SATVIS2, and ITDETECTSTATUS pass the gates below. Caps rawLog
 *   at config.rawLogSize and itdetectHistory at config.historySize. console.warn when
 *   a CRC-failed ITDETECTSTATUS is left out of history.addInterference.
 * @emits none. broadcast writes SSE frames.
 */
function processReceiverLog(message) {
  /**
   * History time for a decoded record. Calls saneTimestamp(header.utc, receivedAt).
   * @param {object} record Decoded record. Missing header or receivedAt are passed through.
   * @returns {number} The milliseconds saneTimestamp returns.
   * Side effects: none.
   * @emits none
   */
  const reportTimestamp = (record) => saneTimestamp(
    record && record.header && record.header.utc,
    record && record.receivedAt,
  );

  /**
   * Display copy of a raw frame. Strings past 16 KiB are cut so rawLog and snapshots
   * cannot retain a multi-megabyte frame. Shorter text, including undefined, is unchanged.
   * The page already shows this same truncation.
   * @param {*} text Raw field.
   * @returns {*}
   * Side effects: none.
   * @emits none
   */
  const storedRaw = (text) => {
    if (typeof text !== 'string' || text.length <= 16384) return text;
    return `${text.slice(0, 16384)} [display truncated]`;
  };

  /**
   * Counts one message name. A 257th distinct name is ignored so store.counts stays bounded.
   * Names already present keep incrementing.
   * @param {string} messageName Log name.
   * @returns {void}
   * Side effects: store.counts.
   * @emits none
   */
  const noteCount = (messageName) => {
    if (!Object.hasOwn(store.counts, messageName) && Object.keys(store.counts).length >= 256) return;
    store.counts[messageName] = (store.counts[messageName] || 0) + 1;
  };

  let record;
  try {
    // A decode throw is logged, set on the receiver error, and counted.
    // It does not replace the last good record in store.latest.
    record = decode(message);
  } catch (error) {
    // The first failure is logged in full. A burst is counted and summarised once a minute.
    // The vm tests that slice this function do not define logLimited, so they still see console.error.
    if (typeof logLimited === 'function') logLimited('error', 'receiver-decode', `[receiver] could not decode log: ${error.message}`);
    else console.error(`[receiver] could not decode log: ${error.message}`);
    if (typeof receiver !== 'undefined' && receiver && typeof receiver.setError === 'function') receiver.setError(error);
    const name = (message && message.header && message.header.messageName) || 'UNKNOWN';
    noteCount(name);
    const diagnostic = storedRaw(`${error.message}\n${message && message.raw ? message.raw : ''}`.trim());
    const receivedAt = new Date().toISOString();
    store.rawLog.push({
      name, receivedAt, format: message && message.format, crcValid: message && message.crcValid, raw: diagnostic,
    });
    if (store.rawLog.length > config.rawLogSize) store.rawLog.shift();
    broadcast('message', {
      record: {
        name,
        format: message && message.format,
        receivedAt,
        header: message && message.header,
        crcValid: message && message.crcValid,
        raw: diagnostic,
        data: null,
        error: error.message,
      },
      counts: store.counts,
    });
    return;
  }

  const name = record.name;
  // CRC-valid records update live state. Failed CRC still reaches the raw log,
  // and ITDETECTSTATUS is still pushed onto itdetectHistory below.
  const trusted = record.crcValid === true;
  if (typeof record.raw === 'string') record.raw = storedRaw(record.raw);
  if (trusted) store.latest[name] = record;
  // Every decoded message is counted, including a failed CRC. At most 256 names.
  noteCount(name);

  // Only a CRC-valid ephemeris updates the per-satellite table.
  if (trusted && record.kind === 'ephemeris') {
    const entry = store.ephemeris[name] || { count: 0, records: {} };
    entry.count++;
    entry.lastSatellite = record.data ? record.data.satelliteId : '';
    entry.lastAt = record.receivedAt;
    const previous = entry.records[entry.lastSatellite];
    const hasParameters = record.data && record.data.parameters && record.data.parameters.length;
    // A record with no parameters does not replace a stored record for that satellite.
    // A new satellite id past 128 is ignored. An id already stored is still updated.
    if (entry.lastSatellite && (hasParameters || !previous)
      && (previous || Object.keys(entry.records).length < 128)) {
      entry.records[entry.lastSatellite] = record;
    }
    entry.satellites = Object.keys(entry.records);
    store.ephemeris[name] = entry;
    // The live message below does not carry the whole store. One coalesced frame
    // per EPHEMERIS_COALESCE_MS carries the satellite that just changed.
    // Sliced tests have no noteEphemeris; the in-memory store above is what they assert.
    if (typeof noteEphemeris === 'function') {
      const satelliteId = entry.lastSatellite;
      noteEphemeris({
        name,
        count: entry.count,
        lastSatellite: satelliteId,
        lastAt: entry.lastAt,
        satelliteId,
        record: ephemerisDeltaRecord(entry.records[satelliteId]),
        satellites: entry.satellites,
      });
    }
  }

  if (name === 'ITDETECTSTATUS') {
    // Every ITDETECTSTATUS is kept here, including one whose CRC failed.
    store.itdetectHistory.push(record);
    if (store.itdetectHistory.length > config.historySize) store.itdetectHistory.shift();
    const detections = (record.data && record.data.detections) || [];
    const bySignal = new Map();
    for (const detection of detections) {
      const signalDetections = bySignal.get(detection.signalType) || [];
      signalDetections.push(detection);
      bySignal.set(detection.signalType, signalDetections);
    }
    const reportTime = reportTimestamp(record);
    // history.addInterference runs only for a CRC-valid record.
    // crcValid === false is logged. Any other non-true crcValid is skipped with no warning.
    if (!trusted) {
      // One warning for the first failed CRC, then a once-per-minute count. Sliced tests use console.warn.
      if (record.crcValid === false) {
        const crcLine = '[receiver] excluding CRC-failed ITDETECTSTATUS from history';
        if (typeof logLimited === 'function') logLimited('warn', 'itdetect-crc', crcLine);
        else console.warn(crcLine);
      }
    } else if (bySignal.size) {
      for (const [signal, signalDetections] of bySignal) {
        history.addInterference(signal, signalDetections, reportTime);
      }
    } else {
      // A CRC-valid report with no detections is stored under the signal name 'ALL'.
      history.addInterference('ALL', [], reportTime);
    }
  }

  // Solution history takes a CRC-valid BESTPOS that includes data.
  if (name === 'BESTPOS' && trusted && record.data) history.addSolution(record.data, reportTimestamp(record));

  if (name === 'SATVIS2' && record.data && record.data.system) {
    // The live skyplot follows CRC-valid SATVIS2 for this system.
    if (trusted) store.satvisBySystem[record.data.system] = record;
    // With a valid CRC, visibilityValid === false skips the track sample.
    // Any other value, including a missing flag, is stored.
    if (trusted && record.data.visibilityValid !== false) {
      history.addSatellites(record.data.system, record.data.satellites || [], reportTimestamp(record));
    }
  }

  // A decoded record is appended to the raw log whether or not its CRC matched.
  store.rawLog.push({
    name, receivedAt: record.receivedAt, format: record.format, crcValid: record.crcValid, raw: storedRaw(record.raw),
  });
  if (store.rawLog.length > config.rawLogSize) store.rawLog.shift();

  // Ephemeris state goes out through noteEphemeris, not on this frame. Attaching the
  // whole store here was about 728 KB per satellite and disconnected every browser
  // when a connect replayed ~195 ephemerides into the 256 KiB backlog.
  broadcast('message', {
    record,
    counts: store.counts,
  });
}

/**
 * Writes one SSE event to every connected client.
 * The frame is an `event:` line, a `data:` line holding JSON, and a blank line.
 * @param {string} event Event name.
 * @param {*} data Value passed to JSON.stringify.
 * @returns {void} Returns when clients is empty, or when JSON.stringify throws.
 * Side effects: an encode failure is logged and leaves the client set alone. A client
 *   that is already destroyed, or whose write throws, is removed and destroyed.
 *   writableLength above 256 KiB destroys the client for a message that is not
 *   replaceable. A replaceable event (status, archive, ephemeris, or an ephemeris
 *   message) is skipped and the client stays. A failed write destroys that client
 *   only. Does not throw.
 * @emits none
 */
function broadcast(event, data) {
  if (!clients.size) return;
  let payload;
  try {
    payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch (error) {
    console.error(`[stream] could not encode ${event} event: ${error.message}`);
    return;
  }
  // status, archive, and ephemeris are replaced by the next frame. An ephemeris
  // 'message' is too: the coalesced ephemeris event carries the table. Checked
  // here so a test that loads only this function does not need another helper.
  // Other messages still disconnect a client past the 256 KiB backlog.
  const replaceable = event === 'status' || event === 'archive' || event === 'ephemeris'
    || (event === 'message' && !!(data && data.record && data.record.kind === 'ephemeris'));
  for (const res of clients) {
    // A dead socket is dropped. A full buffer drops a replaceable frame and keeps
    // the client; any other frame disconnects that client only.
    if (res.destroyed || res.writableLength > 256 * 1024) {
      if (!res.destroyed && replaceable) continue;
      clients.delete(res);
      res.destroy();
    } else {
      try {
        res.write(payload);
      } catch (error) {
        // This write failed. Destroy this response and continue with the other clients.
        console.warn(`[stream] closing client after write failure: ${error.message}`);
        clients.delete(res);
        res.destroy();
      }
    }
  }
}

/**
 * Collects the current live view for a new SSE client or GET /api/snapshot.
 * @returns {object} status, store fields, historyRetentionMinutes, and archive.status().
 *   The store arrays and objects are the live references, not copies.
 * Side effects: calls archive.status(). Does not mutate the store.
 * @emits none
 */
function snapshot() {
  return {
    status: latestStatus,
    latest: store.latest,
    counts: store.counts,
    ephemeris: store.ephemeris,
    itdetectHistory: store.itdetectHistory,
    itdetectBySignal: store.itdetectBySignal,
    satvisBySystem: store.satvisBySystem,
    rawLog: store.rawLog,
    historyRetentionMinutes: config.historyRetentionMinutes,
    archive: archive.status(),
  };
}

/**
 * Copy of one ephemeris record for an SSE delta, without the raw log text.
 * The table reads data.parameters. The raw line stays in the store for the
 * connect snapshot and in the message event's own record. Omitting it here
 * keeps a coalesced frame from repeating every raw ephemeris line.
 * @param {object|undefined} record Stored ephemeris record. Missing returns null.
 * @returns {object|null}
 * Side effects: none. The stored record is not mutated.
 * @emits none
 */
function ephemerisDeltaRecord(record) {
  if (!record) return null;
  const copy = { ...record };
  delete copy.raw;
  return copy;
}

const pendingEphemeris = new Map();
let ephemerisTimer = null;

/**
 * Queues one changed ephemeris satellite and flushes them as a single SSE event.
 * Many ONALL ephemerides arrive in one burst. They used to each rebroadcast the
 * whole store. Updates for the same satellite inside the window collapse to the
 * latest. The timer is unref'd so it does not keep the process alive.
 * Defined after broadcast so a test that slices processReceiverLog up to broadcast
 * does not arm this timer. The function declaration is still in scope for the server.
 * @param {object} update name, satelliteId, count, lastSatellite, lastAt, record, satellites.
 * @returns {void}
 * Side effects: pendingEphemeris and a 250 ms timer. That timer calls broadcast.
 * @emits none
 */
function noteEphemeris(update) {
  if (!update || !update.name) return;
  pendingEphemeris.set(`${update.name}:${update.satelliteId || ''}`, update);
  if (ephemerisTimer) return;
  ephemerisTimer = setTimeout(() => {
    ephemerisTimer = null;
    const updates = [...pendingEphemeris.values()];
    pendingEphemeris.clear();
    if (updates.length) broadcast('ephemeris', { updates });
  }, EPHEMERIS_COALESCE_MS);
  if (ephemerisTimer.unref) ephemerisTimer.unref();
}

/**
 * Ends the response with a JSON body and Cache-Control: no-store.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status HTTP status.
 * @param {*} body Passed to JSON.stringify.
 * @returns {void} Returns without writing when res is destroyed or writableEnded.
 * Side effects: writeHead and end. JSON.stringify can throw; this function does not catch it.
 * @emits none
 */
function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Serves one file from the public directory.
 * '/' maps to index.html. Query strings are ignored. A path that escapes PUBLIC_DIR
 * gets 403. ENOENT and ENOTDIR become 404; any other read error becomes 500.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 * Side effects: fs.readFile. Sets Content-Type from CONTENT_TYPES, or
 *   application/octet-stream, and Cache-Control: no-store. Skips the write if the
 *   response is already finished. Does not throw.
 * @emits none
 */
function serveStatic(req, res) {
  const pathname = req.url.split('?')[0];
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);

  const relativePath = path.relative(PUBLIC_DIR, filePath);
  // path.resolve can still land outside PUBLIC_DIR. Reject that before reading.
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  /**
   * Sends the file body, or 404 / 500. Does nothing if the response already finished.
   * @param {NodeJS.ErrnoException|null} err
   * @param {Buffer} data
   * @returns {void}
   * Side effects: writeHead and end. No log.
   * @emits none
   */
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (res.destroyed || res.writableEnded) return;
      const notFound = err.code === 'ENOENT' || err.code === 'ENOTDIR';
      res.writeHead(notFound ? 404 : 500).end(notFound ? 'Not found' : 'Could not read requested file');
      return;
    }
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/**
 * Reads a JSON object body up to 4096 bytes, then calls callback.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {function(object): void} callback Invoked with the parsed object. A throw becomes
 *   a logged 500 'Could not process request'.
 * @returns {void}
 * Side effects: registers data, error, aborted, and end listeners. Oversize bodies,
 *   including Content-Length above 4096, get 413 and the request is resumed. Invalid
 *   JSON or a non-object (including an array) gets 400. A request error gets 400 when
 *   the response is still writable. aborted marks the request handled so end does not
 *   respond. Does not throw.
 * @emits none
 */
function readJsonBody(req, res, callback) {
  const chunks = [];
  let size = 0;
  let responded = false;
  /**
   * Sends one plain-text error and ignores later attempts.
   * @param {number} status
   * @param {string} message Response body.
   * @returns {void}
   * Side effects: writeHead and end, once. No-op if already responded or the response is finished.
   * @emits none
   */
  const badRequest = (status, message) => {
    if (responded || res.destroyed || res.writableEnded) return;
    responded = true;
    res.writeHead(status).end(message);
  };
  const declaredLength = Number(req.headers['content-length']);
  /**
   * Accumulates body chunks until 4096 bytes.
   * @param {Buffer} chunk
   * @returns {void}
   * Side effects: on overflow, 413, clears the chunk list, and req.resume().
   * @emits none
   */
  req.on('data', (chunk) => {
    if (responded) return;
    size += chunk.length;
    // The running total, not only Content-Length, is capped at 4096 bytes.
    if (size > 4096) {
      badRequest(413, 'Request too large');
      chunks.length = 0;
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  /**
   * Turns a request-stream error into 400 when the response can still be written.
   * @param {Error} error
   * @returns {void}
   * Side effects: console.warn and badRequest. No-op when the response is already finished.
   * @emits none
   */
  req.on('error', (error) => {
    if (!res.destroyed && !res.writableEnded) {
      console.warn(`[http] request body failed: ${error.message}`);
      badRequest(400, 'Could not read request body');
    }
  });
  /**
   * Marks the body handled so the end listener does not answer a client that went away.
   * @returns {void}
   * Side effects: sets responded. Does not write.
   * @emits none
   */
  req.on('aborted', () => {
    responded = true;
  });
  // Reject a declared body over 4096 bytes before waiting for the chunks.
  if (Number.isFinite(declaredLength) && declaredLength > 4096) {
    badRequest(413, 'Request too large');
    req.resume();
    return;
  }
  /**
   * Parses the buffered body and runs callback.
   * @returns {void}
   * Side effects: 400 for invalid JSON or a value that is not a plain object. callback
   *   throw is logged and answered with 500. No-op if already responded or the response finished.
   * @emits none
   */
  req.on('end', () => {
    if (responded || res.destroyed || res.writableEnded) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      badRequest(400, 'Invalid JSON');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      badRequest(400, 'Expected a JSON object');
      return;
    }
    try {
      callback(data);
    } catch (error) {
      console.error(`[http] could not process request body: ${error.stack || error.message}`);
      badRequest(500, 'Could not process request');
    }
  });
}

/**
 * The connection fields a client can read and save.
 * @returns {{transport: string, receiverHost: string, receiverPort: number, serialPath: string, serialBaudRate: number}}
 *   Values currently on config.
 * Side effects: none.
 * @emits none
 */
function connectionSettings() {
  return {
    transport: config.transport,
    receiverHost: config.receiverHost,
    receiverPort: config.receiverPort,
    serialPath: config.serialPath,
    serialBaudRate: config.serialBaudRate,
  };
}

/**
 * Writes the current connection fields through config.saveConnectionSettings.
 * @returns {string|null} Null when the save returns. On throw, the string
 *   'Could not save connection settings: ' plus error.message.
 * Side effects: on throw, console.warn with a [config] prefix, and
 *   receiver.setError with that same message. Does not change the receiver transport.
 * @emits none. setError emits the receiver 'status' event.
 */
function persistConnectionSettings() {
  try {
    config.saveConnectionSettings(config.connectionSettingsFile, connectionSettings());
    return null;
  } catch (error) {
    const message = `Could not save connection settings: ${error.message}`;
    console.warn(`[config] ${message}`);
    receiver.setError(new Error(message));
    return message;
  }
}

/**
 * Dispatches one HTTP request. A synchronous throw from handleRequest is logged.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 * Side effects: on throw, 500 'Internal server error' when headers are unsent;
 *   otherwise destroys the response if it is still open. Promise failures inside
 *   routes are handled by those routes, not by this try.
 * @emits none
 */
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (error) {
    console.error(`[http] request failed: ${error.stack || error.message}`);
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Internal server error');
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  }
});
// 15s for headers and 30s for the whole request, from the constants above.
server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;

/**
 * Routes one request. The path is req.url without the query string.
 * GET /api/connection returns connectionSettings. POST /api/disconnect calls
 * receiver.disconnect and answers {disconnected: true}, or 500 if that fails.
 * POST /api/connection validates tcp, serial, or auto, calls receiver.reconfigure,
 * then persistConnectionSettings. A string from persist is answered with 500 and
 * that text. GET /api/serial-ports lists path and manufacturer.
 * GET /events (any method) is the SSE stream: one snapshot frame, then live events,
 * plus a 15s `: ping` keepalive. GET /api/snapshot returns snapshot().
 * GET /api/history returns history.since for a capped minute window and sample limit.
 * Archive routes delegate to the archive object. Anything else is serveStatic.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 * Side effects: the route bodies below. This function itself does not catch throws.
 * @emits none
 */
function handleRequest(req, res) {
  const route = (req.url || '/').split('?')[0];
  if (route === '/api/connection' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(connectionSettings()));
    return;
  }

  if (route === '/api/disconnect' && req.method === 'POST') {
    /**
     * Answers 200 after receiver.disconnect resolves.
     * @returns {void}
     * Side effects: writes {disconnected: true}. disconnect's promise is already fulfilled.
     * @emits none
     */
    Promise.resolve().then(() => receiver.disconnect()).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ disconnected: true }));
    /**
     * Logs a disconnect failure and answers 500 while the response is still writable.
     * @param {Error} error
     * @returns {void}
     * Side effects: console.error. May write 500 'Could not disconnect receiver'.
     * @emits none
     */
    }).catch((error) => {
      console.error(`[http] disconnect failed: ${error.stack || error.message}`);
      if (!res.destroyed && !res.writableEnded) res.writeHead(500).end('Could not disconnect receiver');
    });
    return;
  }

  if (route === '/api/connection' && req.method === 'POST') {
    /**
     * Applies a connection change. Invalid fields answer 400 before reconfigure.
     * @param {object} settings Body from readJsonBody.
     * @returns {void}
     * Side effects: receiver.reconfigure for a valid tcp, serial, or auto body, then
     *   persistConnectionSettings. See the saveError branch for the 500 path.
     * @emits status through reconfigure.
     */
    readJsonBody(req, res, (settings) => {
      /**
       * Validates the TCP host and port from the POST body.
       * @returns {{receiverHost: string, receiverPort: number}|null} Null when the host is
       *   empty or the port is not an integer from 1 to 65535.
       * Side effects: none.
       * @emits none
       */
      const tcpSettings = () => {
        const host = String(settings.receiverHost || '').trim();
        const port = Number(settings.receiverPort);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
        return { receiverHost: host, receiverPort: port };
      };
      /**
       * Validates the serial path and baud from the POST body.
       * @returns {{serialPath: string, serialBaudRate: number}|null} Null when the path is
       *   empty or the baud is not an integer of at least 1.
       * Side effects: none.
       * @emits none
       */
      const serialSettings = () => {
        const serialPath = String(settings.serialPath || '').trim();
        const serialBaudRate = Number(settings.serialBaudRate);
        if (!serialPath || !Number.isInteger(serialBaudRate) || serialBaudRate < 1) return null;
        return { serialPath, serialBaudRate };
      };
      // Each accepted branch reconfigures first. persistConnectionSettings runs after the branch.
      if (settings.transport === 'tcp') {
        const tcp = tcpSettings();
        if (!tcp) {
          res.writeHead(400).end('A valid receiver host and TCP port are required');
          return;
        }
        receiver.reconfigure({ transport: 'tcp', ...tcp });
      } else if (settings.transport === 'serial') {
        const serial = serialSettings();
        if (!serial) {
          res.writeHead(400).end('A serial port and valid baud rate are required');
          return;
        }
        receiver.reconfigure({ transport: 'serial', ...serial });
      } else if (settings.transport === 'auto') {
        const tcp = tcpSettings();
        const serial = serialSettings();
        if (!tcp || !serial) {
          res.writeHead(400).end('Auto mode needs a serial port, baud rate, receiver host and TCP port');
          return;
        }
        receiver.reconfigure({ transport: 'auto', ...serial, ...tcp });
      } else {
        res.writeHead(400).end('Transport must be auto, tcp or serial');
        return;
      }

      // reconfigure has already run. A returned string is sent as the 500 body.
      const saveError = persistConnectionSettings();
      if (saveError) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(saveError);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(connectionSettings()));
    });
    return;
  }

  /**
   * Lists serial ports as {path, manufacturer}.
   * @returns {void}
   * Side effects: SerialPort.list(). 500 JSON {error} on failure. Skips a finished response.
   *   Logs the list error.
   * @emits none
   */
  if (route === '/api/serial-ports' && req.method === 'GET') {
    /**
     * Writes the port list. The map keeps path and manufacturer.
     * @param {object[]} ports
     * @returns {void}
     * Side effects: 200 JSON. No-op if the response is already finished.
     * @emits none
     */
    SerialPort.list().then((ports) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ports.map(({ path: portPath, manufacturer }) => ({ path: portPath, manufacturer }))));
    /**
     * Logs a serial-port listing failure and answers 500 JSON.
     * @param {Error} err
     * @returns {void}
     * Side effects: console.error and a JSON error body when the response is still open.
     * @emits none
     */
    }).catch((err) => {
      console.error(`[http] could not list serial ports: ${err.message}`);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not list serial ports' }));
    });
    return;
  }

  /**
   * Server-Sent Events stream. The method is not checked.
   * Writes `event: snapshot` with snapshot() before the response joins `clients`,
   * so that frame is not delivered through broadcast. Then keeps the socket with
   * `: ping` every 15 seconds. A destroyed response, writableLength above 256 KiB,
   * or a failed ping write removes and destroys that client only.
   * @returns {void}
   * Side effects: SSE headers (text/event-stream, no-cache, keep-alive, X-Accel-Buffering: no),
   *   the snapshot write, clients.add, and a 15s interval cleared on res 'close'.
   *   res 'error' logs, deletes, and destroys the response.
   * @emits none
   */
  if (route === '/events') {
    /**
     * Drops an SSE response that raised an error.
     * @param {Error} error
     * @returns {void}
     * Side effects: console.warn, clients.delete, res.destroy.
     * @emits none
     */
    res.on('error', (error) => {
      console.warn(`[stream] client error: ${error.message}`);
      clients.delete(res);
      res.destroy();
    });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Replay the current snapshot once, then register for later broadcasts.
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);

    /**
     * SSE comment keepalive every 15 seconds. Same 256 KiB ceiling as broadcast.
     * @returns {void}
     * Side effects: writes `: ping`. On backpressure or a write throw, deletes and destroys
     *   this response. Logs a keep-alive write failure.
     * @emits none
     */
    const keepAlive = setInterval(() => {
      // A stuck SSE client is removed rather than queued further.
      if (res.destroyed || res.writableLength > 256 * 1024) {
        clients.delete(res);
        res.destroy();
      } else {
        try {
          res.write(': ping\n\n');
        } catch (error) {
          console.warn(`[stream] closing client after keep-alive failure: ${error.message}`);
          clients.delete(res);
          res.destroy();
        }
      }
    }, 15000);
    /**
     * Stops the keepalive when the SSE client disconnects.
     * @returns {void}
     * Side effects: clearInterval(keepAlive) and clients.delete.
     * @emits none
     */
    res.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  if (route === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  // minutes and limit are capped at the configured retention and sample maximum.
  // A missing or non-positive value falls back to that maximum.
  if (route === '/api/history') {
    const parameters = new URL(req.url, 'http://localhost').searchParams;
    const requested = Number(parameters.get('minutes'));
    const requestedLimit = Number(parameters.get('limit'));
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, config.maxInterferenceSamples) : config.maxInterferenceSamples;
    const minutes = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, config.historyRetentionMinutes)
      : config.historyRetentionMinutes;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history.since(minutes * 60000, Date.now(), limit)));
    return;
  }

  if (route === '/api/archive' && req.method === 'GET') {
    sendJson(res, 200, archive.info());
    return;
  }

  if (route === '/api/archive/load' && req.method === 'POST') {
    /**
     * Starts an archive load. archive.load errors become 400 JSON.
     * @param {object} body Uses root and days.
     * @returns {void}
     * Side effects: sendJson of archive.load, or 400 {error: error.message}.
     * @emits none directly. archive.load may later emit archive status.
     */
    readJsonBody(req, res, (body) => {
      try {
        sendJson(res, 200, archive.load({ root: body.root, days: body.days }));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
    });
    return;
  }

  if (route === '/api/archive/cancel' && req.method === 'POST') {
    sendJson(res, 200, archive.cancel());
    return;
  }

  if (route === '/api/archive/auto' && req.method === 'POST') {
    /**
     * Turns archive auto-refresh on or off. enabled must be a boolean.
     * @param {object} body
     * @returns {void}
     * Side effects: 400 JSON when enabled is not boolean, otherwise archive.setAuto.
     * @emits none directly. setAuto may emit archive status.
     */
    readJsonBody(req, res, (body) => {
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled must be true or false' });
        return;
      }
      sendJson(res, 200, archive.setAuto(body.enabled));
    });
    return;
  }

  if (route === '/api/archive/clear' && req.method === 'POST') {
    sendJson(res, 200, archive.clear());
    return;
  }

  if (route === '/api/archive/interference' && req.method === 'GET') {
    const parameters = new URL(req.url, 'http://localhost').searchParams;
    try {
      sendJson(res, 200, archive.query({
        from: parameters.get('from'), to: parameters.get('to'), buckets: parameters.get('buckets'),
      }));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  serveStatic(req, res);
}

/**
 * Answers a malformed HTTP request on the raw socket.
 * @param {Error} error
 * @param {import('node:net').Socket} socket
 * @returns {void}
 * Side effects: console.warn. When socket.writable, ends with a raw 400 and
 *   Connection: close. Otherwise socket.destroy().
 * @emits none
 */
server.on('clientError', (error, socket) => {
  console.warn(`[http] malformed client request: ${error.message}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});
/**
 * Logs a server error, stops the receiver, and sets process.exitCode to 1.
 * @param {Error} error
 * @returns {void}
 * Side effects: console.error, receiver.stop(), process.exitCode = 1. Does not call process.exit.
 * @emits none. receiver.stop may emit status if closing the port reports an error.
 */
server.on('error', (error) => {
  console.error(`[http] server error: ${error.stack || error.message}`);
  receiver.stop();
  process.exitCode = 1;
});

/**
 * URLs to print when the HTTP server starts listening.
 * 0.0.0.0 is not a useful browser address, so that bind prints
 * http://127.0.0.1:port and then each non-internal IPv4 address from
 * os.networkInterfaces(). A specific WEB_HOST is printed as-is.
 * @param {string} host config.webHost.
 * @param {number|string} port config.webPort.
 * @returns {string[]} Absolute http URLs, localhost first when host is 0.0.0.0.
 * Side effects: may call os.networkInterfaces(). A throw from that call is ignored
 *   and only the localhost URL is returned. Does not log.
 * @emits none
 */
function webListenLines(host, port) {
  if (host !== '0.0.0.0') return [`http://${host}:${port}`];
  const lines = [`http://127.0.0.1:${port}`];
  const seen = new Set(['127.0.0.1']);
  let interfaces = {};
  try {
    interfaces = os.networkInterfaces() || {};
  } catch {
    interfaces = {};
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (!entry.address || seen.has(entry.address)) continue;
      seen.add(entry.address);
      lines.push(`http://${entry.address}:${port}`);
    }
  }
  return lines;
}

/**
 * Logs the listen addresses, starts the receiver, and starts archive auto-refresh.
 * @returns {void}
 * Side effects: one console.log per URL from webListenLines (localhost, then LAN
 *   IPv4 addresses, when bound to 0.0.0.0), history retention, and receiver target.
 *   receiver.start(). archive.startAuto(5000). When archive auto is enabled, logs the
 *   archive root, day count, and refresh minutes.
 * @emits status through receiver.start.
 */
server.listen(config.webPort, config.webHost, () => {
  for (const url of webListenLines(config.webHost, config.webPort)) {
    console.log(`[web] ${url}`);
  }
  console.log(`[history] retaining ${config.historyRetentionMinutes} minutes${config.historyFile ? ` in ${config.historyFile}` : ' (memory only)'}`);
  const serialTarget = `${config.serialPath} @ ${config.serialBaudRate}`;
  const tcpTarget = `${config.receiverHost}:${config.receiverPort}`;
  console.log(`[receiver] connecting to ${config.transport === 'auto' ? `${serialTarget}, falling back to ${tcpTarget}`
    : config.transport === 'serial' ? serialTarget : tcpTarget} ...`);
  receiver.start();
  // Delayed 5000 ms so the receiver connection and first page loads are not competing with the NAS scan.
  archive.startAuto(5000);
  if (archive.settings.auto) {
    console.log(`[archive] keeping the last ${archive.settings.days} day(s) loaded from ${archive.settings.root}, `
      + `refreshed every ${config.archiveRefreshMinutes} min`);
  }
});

// SIGINT and SIGTERM share this flag. A second signal returns immediately.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  /**
   * Shuts down on SIGINT or SIGTERM.
   * @returns {void} Returns immediately when shuttingDown is already set.
   * Side effects: sets shuttingDown, receiver.stop(), archive.stopAuto(), archive.cancel().
   *   Arms a force-exit timer of SHUTDOWN_TIMEOUT_MS (5000 ms). history.flush() then
   *   closes the HTTP server and destroys SSE clients. A flush rejection logs and process.exit(1).
   * @emits none directly.
   */
  process.on(signal, () => {
    // The first signal owns shutdown. Later signals do not start another flush.
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop the receiver, stop archive auto-refresh, and cancel an in-progress archive scan.
    receiver.stop();
    archive.stopAuto();
    archive.cancel();
    /**
     * Force exit after 5000 ms when flush or server.close has not finished.
     * @returns {void}
     * Side effects: console.error. Calls server.closeAllConnections when that function
     *   exists, then process.exit(1).
     * @emits none
     */
    const shutdownTimer = setTimeout(() => {
      console.error(`[shutdown] forcing exit after ${SHUTDOWN_TIMEOUT_MS} ms`);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    /**
     * After history.flush() fulfills, close the HTTP server and drop SSE clients.
     * @returns {void}
     * Side effects: server.close. Its callback clears the force-exit timer and process.exit(0).
     *   The SSE loop destroys every client and clears the set without waiting for that callback.
     * @emits none
     */
    history.flush().then(() => {
      /**
       * Clean exit once the HTTP server has closed.
       * @returns {void}
       * Side effects: clearTimeout(shutdownTimer) and process.exit(0).
       * @emits none
       */
      server.close(() => {
        clearTimeout(shutdownTimer);
        process.exit(0);
      });
      // SSE clients are destroyed when flush resolves, not from the server.close callback.
      for (const client of clients) client.destroy();
      clients.clear();
    /**
     * A failed history flush logs and exits 1.
     * @param {Error} error
     * @returns {void}
     * Side effects: console.error and process.exit(1).
     * @emits none
     */
    }).catch((error) => {
      console.error(`[shutdown] history flush failed: ${error.message}`);
      process.exit(1);
    });
  });
}

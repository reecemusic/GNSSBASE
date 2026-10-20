'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SerialPort } = require('serialport');

const config = require('./config');
const { ReceiverClient } = require('./receiver');
const { decode } = require('./messages');
const { History } = require('./history');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HTTP_HEADERS_TIMEOUT_MS = 15_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Latest record per message type, plus counters and rolling histories. */
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
history.load();
setInterval(() => history.prune(), 60000).unref();
if (config.historyFile) setInterval(() => history.save(), config.historySaveSeconds * 1000).unref();

const receiver = new ReceiverClient(config);

receiver.on('status', (state) => {
  latestStatus = state;
  const target = state.transport === 'serial'
    ? `${state.serialPath} @ ${state.baudRate}`
    : `${state.host}:${state.port}`;
  console.log(`[receiver] ${state.connected ? 'connected to' : 'disconnected from'} ${target}${state.lastError ? ` (${state.lastError})` : ''}`);
  broadcast('status', state);
});

receiver.on('log', (message) => {
  try {
    processReceiverLog(message);
  } catch (error) {
    console.error(`[receiver] could not process log: ${error.stack || error.message}`);
  }
});

function processReceiverLog(message) {
  const record = decode(message);
  const name = record.name;
  store.latest[name] = record;
  store.counts[name] = (store.counts[name] || 0) + 1;

  if (record.kind === 'ephemeris') {
    const entry = store.ephemeris[name] || { count: 0, records: {} };
    entry.count++;
    entry.lastSatellite = record.data ? record.data.satelliteId : '';
    entry.lastAt = record.receivedAt;
    const previous = entry.records[entry.lastSatellite];
    const hasParameters = record.data && record.data.parameters && record.data.parameters.length;
    if (entry.lastSatellite && (hasParameters || !previous)) entry.records[entry.lastSatellite] = record;
    entry.satellites = Object.keys(entry.records);
    store.ephemeris[name] = entry;
  }

  if (name === 'ITDETECTSTATUS') {
    store.itdetectHistory.push(record);
    if (store.itdetectHistory.length > config.historySize) store.itdetectHistory.shift();
    const detections = (record.data && record.data.detections) || [];
    const bySignal = new Map();
    for (const detection of detections) {
      const signalDetections = bySignal.get(detection.signalType) || [];
      signalDetections.push(detection);
      bySignal.set(detection.signalType, signalDetections);
    }
    if (bySignal.size) {
      for (const [signal, signalDetections] of bySignal) {
        history.addInterference(signal, signalDetections);
      }
    } else {
      history.addInterference('ALL', []);
    }
  }

  if (name === 'SATVIS2' && record.data && record.data.system) {
    store.satvisBySystem[record.data.system] = record;
    history.addSatellites(record.data.system, record.data.satellites || []);
  }

  store.rawLog.push({ name, receivedAt: record.receivedAt, format: record.format, crcValid: record.crcValid, raw: record.raw });
  if (store.rawLog.length > config.rawLogSize) store.rawLog.shift();

  broadcast('message', {
    record,
    counts: store.counts,
    ephemeris: record.kind === 'ephemeris' ? store.ephemeris : undefined,
  });
}

function broadcast(event, data) {
  if (!clients.size) return;
  let payload;
  try {
    payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch (error) {
    console.error(`[stream] could not encode ${event} event: ${error.message}`);
    return;
  }
  for (const res of clients) {
    if (res.destroyed || res.writableLength > 256 * 1024) {
      clients.delete(res);
      res.destroy();
    } else {
      try {
        res.write(payload);
      } catch (error) {
        console.warn(`[stream] closing client after write failure: ${error.message}`);
        clients.delete(res);
        res.destroy();
      }
    }
  }
}

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
  };
}

function serveStatic(req, res) {
  const pathname = req.url.split('?')[0];
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);

  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

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

function readJsonBody(req, res, callback) {
  const chunks = [];
  let size = 0;
  let responded = false;
  const badRequest = (status, message) => {
    if (responded || res.destroyed || res.writableEnded) return;
    responded = true;
    res.writeHead(status).end(message);
  };
  const declaredLength = Number(req.headers['content-length']);
  req.on('data', (chunk) => {
    if (responded) return;
    size += chunk.length;
    if (size > 4096) {
      badRequest(413, 'Request too large');
      chunks.length = 0;
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', (error) => {
    if (!res.destroyed && !res.writableEnded) {
      console.warn(`[http] request body failed: ${error.message}`);
      badRequest(400, 'Could not read request body');
    }
  });
  req.on('aborted', () => {
    responded = true;
  });
  if (Number.isFinite(declaredLength) && declaredLength > 4096) {
    badRequest(413, 'Request too large');
    req.resume();
    return;
  }
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

function connectionSettings() {
  return {
    transport: config.transport,
    receiverHost: config.receiverHost,
    receiverPort: config.receiverPort,
    serialPath: config.serialPath,
    serialBaudRate: config.serialBaudRate,
  };
}

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
server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;

function handleRequest(req, res) {
  const route = (req.url || '/').split('?')[0];
  if (route === '/api/connection' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(connectionSettings()));
    return;
  }

  if (route === '/api/disconnect' && req.method === 'POST') {
    Promise.resolve().then(() => receiver.disconnect()).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ disconnected: true }));
    }).catch((error) => {
      console.error(`[http] disconnect failed: ${error.stack || error.message}`);
      if (!res.destroyed && !res.writableEnded) res.writeHead(500).end('Could not disconnect receiver');
    });
    return;
  }

  if (route === '/api/connection' && req.method === 'POST') {
    readJsonBody(req, res, (settings) => {
      const tcpSettings = () => {
        const host = String(settings.receiverHost || '').trim();
        const port = Number(settings.receiverPort);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
        return { receiverHost: host, receiverPort: port };
      };
      const serialSettings = () => {
        const serialPath = String(settings.serialPath || '').trim();
        const serialBaudRate = Number(settings.serialBaudRate);
        if (!serialPath || !Number.isInteger(serialBaudRate) || serialBaudRate < 1) return null;
        return { serialPath, serialBaudRate };
      };
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

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(connectionSettings()));
    });
    return;
  }

  if (route === '/api/serial-ports' && req.method === 'GET') {
    SerialPort.list().then((ports) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ports.map(({ path: portPath, manufacturer }) => ({ path: portPath, manufacturer }))));
    }).catch((err) => {
      console.error(`[http] could not list serial ports: ${err.message}`);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not list serial ports' }));
    });
    return;
  }

  if (route === '/events') {
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
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);

    const keepAlive = setInterval(() => {
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

  serveStatic(req, res);
}

server.on('clientError', (error, socket) => {
  console.warn(`[http] malformed client request: ${error.message}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});
server.on('error', (error) => {
  console.error(`[http] server error: ${error.stack || error.message}`);
  receiver.stop();
  process.exitCode = 1;
});

server.listen(config.webPort, config.webHost, () => {
  console.log(`[web] http://${config.webHost}:${config.webPort}`);
  console.log(`[history] retaining ${config.historyRetentionMinutes} minutes${config.historyFile ? ` in ${config.historyFile}` : ' (memory only)'}`);
  const serialTarget = `${config.serialPath} @ ${config.serialBaudRate}`;
  const tcpTarget = `${config.receiverHost}:${config.receiverPort}`;
  console.log(`[receiver] connecting to ${config.transport === 'auto' ? `${serialTarget}, falling back to ${tcpTarget}`
    : config.transport === 'serial' ? serialTarget : tcpTarget} ...`);
  receiver.start();
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    receiver.stop();
    history.save();
    const shutdownTimer = setTimeout(() => {
      console.error(`[shutdown] forcing exit after ${SHUTDOWN_TIMEOUT_MS} ms`);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    server.close(() => {
      clearTimeout(shutdownTimer);
      process.exit(0);
    });
    for (const client of clients) client.destroy();
    clients.clear();
  });
}

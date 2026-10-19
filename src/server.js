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
  console.log(`[receiver] ${state.connected ? 'connected to' : 'disconnected from'} ${state.host}:${state.port}${state.lastError ? ` (${state.lastError})` : ''}`);
  broadcast('status', state);
});

receiver.on('log', (message) => {
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
});

function broadcast(event, data) {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (res.destroyed || res.writableLength > 256 * 1024) {
      clients.delete(res);
      res.destroy();
    } else {
      res.write(payload);
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
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested));

  // Keep path traversal (`../`) from escaping the public directory.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function readJsonBody(req, res, callback) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) {
      res.writeHead(413).end('Request too large');
      req.destroy();
    }
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400).end('Invalid JSON');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      res.writeHead(400).end('Expected a JSON object');
      return;
    }
    callback(data);
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
  const route = req.url.split('?')[0];

  if (route === '/api/connection' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(connectionSettings()));
    return;
  }

  if (route === '/api/disconnect' && req.method === 'POST') {
    receiver.disconnect().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ disconnected: true }));
    });
    return;
  }

  if (route === '/api/connection' && req.method === 'POST') {
    readJsonBody(req, res, (settings) => {
      if (settings.transport === 'tcp') {
        const host = String(settings.receiverHost || '').trim();
        const port = Number(settings.receiverPort);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
          res.writeHead(400).end('A valid receiver host and TCP port are required');
          return;
        }
        receiver.reconfigure({ transport: 'tcp', receiverHost: host, receiverPort: port });
      } else if (settings.transport === 'serial') {
        const serialPath = String(settings.serialPath || '').trim();
        const serialBaudRate = Number(settings.serialBaudRate);
        if (!serialPath || !Number.isInteger(serialBaudRate) || serialBaudRate < 1) {
          res.writeHead(400).end('A serial port and valid baud rate are required');
          return;
        }
        receiver.reconfigure({ transport: 'serial', serialPath, serialBaudRate });
      } else {
        res.writeHead(400).end('Transport must be tcp or serial');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(connectionSettings()));
    });
    return;
  }

  if (route === '/api/serial-ports' && req.method === 'GET') {
    SerialPort.list().then((ports) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ports.map(({ path: portPath, manufacturer }) => ({ path: portPath, manufacturer }))));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
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
        res.write(': ping\n\n');
      }
    }, 15000);
    req.on('close', () => {
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
});

server.listen(config.webPort, config.webHost, () => {
  console.log(`[web] http://${config.webHost}:${config.webPort}`);
  console.log(`[history] retaining ${config.historyRetentionMinutes} minutes${config.historyFile ? ` in ${config.historyFile}` : ' (memory only)'}`);
  console.log(`[receiver] connecting to ${config.receiverHost}:${config.receiverPort} ...`);
  receiver.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    receiver.stop();
    history.save();
    server.close(() => process.exit(0));
  });
}

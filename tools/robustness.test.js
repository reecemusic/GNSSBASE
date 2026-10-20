'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { ReceiverClient } = require('../src/receiver');
const { History } = require('../src/history');
const { parseAsciiLog, readBinaryLog } = require('../src/novatel');
const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function load(context, start, end) {
  const first = code.indexOf(start);
  const last = code.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing source boundary: ${start}`);
  vm.runInContext(code.slice(first, last), context);
}

test('corrupt and unavailable preferences display errors without preventing startup', () => {
  const notice = {};
  const errors = [];
  const context = vm.createContext({
    document: { getElementById: () => notice },
    localStorage: {
      getItem(key) {
        if (key === 'hiddenSignals') return '{broken';
        if (key === 'timeZone') return 'Invalid/Zone';
        return null;
      },
      setItem() { throw new Error('Storage full'); },
    },
    console: { error: (...args) => errors.push(args) },
  });
  load(context, "'use strict';", '// --- tabs');
  assert.equal(vm.runInContext('state.timeZone', context), 'Asia/Dubai');
  assert.equal(vm.runInContext('state.hiddenSignals.size', context), 0);
  context.writePreference('test', 'value');
  assert.match(notice.textContent, /Could not save preference/);
  assert.equal(notice.hidden, false);
  assert.equal(errors.length, 3);
  context.localStorage.getItem = () => { throw new Error('Access denied'); };
  assert.equal(context.readPreference('test', 'default'), 'default');
});

test('malformed and oversized live events are reported and the next valid event is processed', () => {
  const errors = [];
  const context = vm.createContext({
    MAX_EVENT_CHARS: 100,
    reportClientError: (label, error) => errors.push({ label, error }),
  });
  load(context, 'function handleStreamEvent(', 'function connectStream()');
  let processed = 0;
  for (const data of ['{bad', 'null', '[]', 'x'.repeat(101)]) {
    context.handleStreamEvent('Live data', { data }, () => { processed++; });
  }
  context.handleStreamEvent('Live data', { data: '{}' }, () => { throw new Error('Bad report'); });
  context.handleStreamEvent('Live data', { data: '{}' }, () => { processed++; });
  assert.equal(processed, 1);
  assert.equal(errors.length, 5);
});

test('renderer exceptions are surfaced without preventing subsequent updates', () => {
  const errors = [];
  const context = vm.createContext({ reportClientError: (label, error) => errors.push(error) });
  load(context, 'function renderSafely(', 'function flushUpdates(');
  let rendered = false;
  context.renderSafely('Broken plot', () => { throw new Error('Malformed sample'); });
  context.renderSafely('Healthy plot', () => { rendered = true; });
  assert(rendered);
  assert.equal(errors.length, 1);
});

test('requests reject HTTP errors and time out while waiting for the response body', async () => {
  let timeout;
  let cleared = 0;
  const context = vm.createContext({
    AbortController,
    setTimeout(callback) { timeout = callback; return 1; },
    clearTimeout() { cleared++; },
    fetch: async () => ({ ok: false, status: 503 }),
  });
  load(context, 'async function request(', 'function readHiddenPreference(');
  await assert.rejects(context.request('/api/history', {}, true), /503/);
  context.fetch = async (url, { signal }) => ({
    ok: true,
    json: () => signal.aborted
      ? Promise.reject(new Error('Request aborted'))
      : new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true });
      }),
  });
  const pending = context.request('/api/history', {}, true);
  await Promise.resolve();
  timeout();
  await assert.rejects(pending, /aborted/);
  assert.equal(cleared, 2);
});

test('failed history requests retain the currently visible data and report the failure', async () => {
  const samples = [{ t: Date.now(), signal: 'L1', count: 1 }];
  const errors = [];
  const context = vm.createContext({
    AbortController, Date,
    state: { windowMinutes: 60, interferenceHistory: samples, tracks: { 'GPS:1': [] } },
    document: { hidden: false },
    request: async () => { throw new Error('Server unavailable'); },
    reportClientError: (label, error) => errors.push(error),
    timelineDirty: false, flushUpdates() {},
    MAX_INTERFERENCE_SAMPLES: 10000,
  });
  load(context, 'let historyRequest =', '/** The server cannot serve');
  await context.loadHistory();
  assert.equal(context.state.interferenceHistory, samples);
  assert(Object.hasOwn(context.state.tracks, 'GPS:1'));
  assert.equal(errors.length, 1);
});

test('raw pending records are compact and cannot retain full decoded reports', () => {
  const context = vm.createContext({});
  load(context, 'function rawDisplayRecord(', 'function renderSafely(');
  const record = context.rawDisplayRecord({
    name: 'RANGE', raw: 'x'.repeat(1000000), data: { observations: Array(2048).fill({}) },
  });
  assert(record.raw.length < 16420);
  assert.match(record.raw, /display truncated/);
  assert.equal(record.data, undefined);
});

test('server history limits restored samples and caps browser responses', () => {
  const history = new History({ retentionMs: 3600000, maxInterferenceSamples: 500 });
  history.interference = Array.from({ length: 2000 }, (_, index) => ({
    t: Date.now(), signal: 'L1', count: 1, maxPower: -90, index,
  }));
  history.prune();
  assert.equal(history.interference.length, 500);
  const response = history.since(3600000, Date.now(), 100);
  assert.equal(response.interference.length, 100);
  assert.equal(response.interference[0].index, 1900);
});

test('out-of-range GPS timestamps cannot throw during receiver parsing', () => {
  assert.doesNotThrow(() => {
    const result = parseAsciiLog('%TESTA,1e300,1e300;0');
    assert.equal(result.header.utc, null);
  });
});

test('auto transport tries serial first and falls back to TCP when serial does not connect', () => {
  const ports = [];
  const sockets = [];
  const timers = [];
  class FakePort extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      ports.push(this);
    }
    open(callback) { this.openCallback = callback; }
    write() {}
    close(callback) { this.isOpen = false; if (callback) callback(); }
  }
  const fakeNet = {
    createConnection(options) {
      const socket = Object.assign(new EventEmitter(), {
        options, destroyed: false,
        setKeepAlive() {}, setTimeout() {}, write() {},
        destroy() { this.destroyed = true; },
      });
      sockets.push(socket);
      return socket;
    },
  };
  const context = vm.createContext({
    Buffer, module: { exports: {} },
    console: { warn() {}, log() {}, error() {} },
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    require: (name) => name === 'serialport' ? { SerialPort: FakePort }
      : name === 'node:net' ? fakeNet
        : name === './novatel' ? require('../src/novatel') : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'receiver.js'), 'utf8'), context);
  const receiver = new context.module.exports.ReceiverClient({
    transport: 'auto', serialPath: 'COM11', serialBaudRate: 9600, serialProbeMs: 5000,
    receiverHost: '20.20.20.50', receiverPort: 3001, reconnectDelayMs: 3000, idleTimeoutMs: 30000,
  });

  receiver.start();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].options.path, 'COM11');
  assert.equal(ports[0].options.baudRate, 9600);
  assert.equal(sockets.length, 0, 'Serial is tried before TCP');

  ports[0].openCallback(new Error('File not found'));
  assert.equal(sockets.length, 1, 'A failed serial open falls straight back to TCP');
  assert.equal(sockets[0].options.host, '20.20.20.50');
  assert.equal(receiver.state.transport, 'tcp');
  assert.equal(receiver.state.mode, 'auto');

  sockets[0].emit('close');
  const retry = timers.filter((timer) => !timer.cleared && timer.ms === 3000).pop();
  retry.callback();
  assert.equal(ports.length, 2, 'The next cycle tries serial first again');
  assert.equal(receiver.state.transport, 'serial');

  ports[1].isOpen = true;
  ports[1].openCallback(null);
  assert.equal(receiver.state.connected, true);
  const probe = timers.filter((timer) => !timer.cleared && timer.ms === 5000).pop();
  probe.callback();
  assert.equal(sockets.length, 2, 'A silent serial port falls back to TCP');
  assert.equal(receiver.port, null);
  assert.match(receiver.state.lastError, /No NovAtel logs on COM11 @ 9600/);

  receiver.stop();
  receiver.start();
  ports[2].isOpen = true;
  ports[2].openCallback(null);
  const healthyProbe = timers.filter((timer) => !timer.cleared && timer.ms === 5000).pop();
  ports[2].emit('data', Buffer.from('%ITDETECTSTATUSA,2200,1;0\n'));
  assert(healthyProbe.cleared, 'A decodable log keeps the serial connection');
  assert.equal(sockets.length, 2);
  assert.equal(receiver.state.transport, 'serial');
  receiver.stop();
});

test('receiver isolates valid logs, reports connection state and disconnects cleanly', async () => {
  const receivedCommands = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      receivedCommands.push(chunk.toString('ascii'));
      socket.write('#TESTA,COM1,0,0,FINESTEERING,2200,1.0,00000000,00000000;ok\n');
    });

    test('a failed log handler does not corrupt the following frame', () => {
      const receiver = new ReceiverClient({});
      const logs = [];
      receiver.on('log', (message) => {
        if (message.header.messageName === 'FIRST') throw new Error('Bad log handler');
        logs.push(message.header.messageName);
      });
      receiver.ingest(Buffer.from('%FIRSTA,2200,1;0\n%SECONDA,2200,2;0\n'));
      assert.deepEqual(logs, ['SECOND']);
      assert.match(receiver.state.lastError, /Bad log handler/);
      assert.equal(receiver.buffer.length, 0);
    });

    test('invalid binary header lengths are rejected without unsafe reads', () => {
      const frame = Buffer.alloc(28);
      frame.set([0xaa, 0x44, 0x12, 1]);
      assert.equal(readBinaryLog(frame), null);
    });

    test('failed serial opens release the port and schedule another attempt', () => {
      const ports = [];
      const timers = [];
      class FakePort extends EventEmitter {
        constructor() {
          super();
          ports.push(this);
        }
        open(callback) { this.openCallback = callback; }
      }
      const context = vm.createContext({
        Buffer, console, module: { exports: {} },
        setTimeout(callback) { timers.push(callback); return timers.length; },
        clearTimeout() {},
        require: (name) => name === 'serialport' ? { SerialPort: FakePort }
          : name === './novatel' ? require('../src/novatel') : require(name),
      });
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'receiver.js'), 'utf8'), context);
      const receiver = new context.module.exports.ReceiverClient({
        transport: 'serial', serialPath: 'TEST', serialBaudRate: 115200, reconnectDelayMs: 100,
      });
      receiver.start();
      ports[0].openCallback(new Error('Port unavailable'));
      assert.equal(receiver.port, null);
      assert.match(receiver.state.lastError, /Port unavailable/);
      assert.equal(timers.length, 1);
      timers[0]();
      assert.equal(ports.length, 2);
      receiver.stop();
    });

    test('JSON body errors produce one explicit response without invoking the handler', () => {
      const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
      const context = vm.createContext({ Buffer, console });
      const start = serverCode.indexOf('function readJsonBody(');
      const end = serverCode.indexOf('function connectionSettings()', start);
      vm.runInContext(serverCode.slice(start, end), context);
      for (const [body, status] of [['{bad', 400], ['[]', 400], ['x'.repeat(4097), 413]]) {
        const req = Object.assign(new EventEmitter(), { headers: {}, resume() {} });
        const res = {
          responses: 0,
          writeHead(code) { this.status = code; return this; },
          end() { this.responses++; this.writableEnded = true; },
        };
        let invoked = false;
        context.readJsonBody(req, res, () => { invoked = true; });
        req.emit('data', Buffer.from(body));
        req.emit('data', Buffer.from(' '));
        req.emit('end');
        assert.equal(res.status, status);
        assert.equal(res.responses, 1);
        assert.equal(invoked, false);
      }
    });

    test('history serialization failures are logged rather than escaping the save timer', () => {
      const warnings = [];
      const context = vm.createContext({
        module: { exports: {} }, require,
        console: { warn: (message) => warnings.push(message) },
      });
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'history.js'), 'utf8'), context);
      const history = new context.module.exports.History({
        filePath: 'unused.json', retentionMs: 60000, maxInterferenceSamples: 10,
      });
      const sample = { t: Date.now() };
      sample.circular = sample;
      history.interference.push(sample);
      assert.doesNotThrow(() => history.save());
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /could not save/);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const receiver = new ReceiverClient({
    transport: 'tcp',
    receiverHost: '127.0.0.1',
    receiverPort: server.address().port,
    reconnectDelayMs: 10,
    idleTimeoutMs: 10000,
    ephemerisLogCommands: [],
    sendLogCommands: false,
  });
  try {
    const message = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Receiver did not deliver a test log')), 2000);
      receiver.once('log', (log) => {
        clearTimeout(timeout);
        resolve(log);
      });
    });
    receiver.start();
    const log = await message;
    assert.equal(log.header.messageName, 'TEST');
    assert(receiver.state.connected);
    assert(receivedCommands.some((command) => command.includes('LOG ITDETECTSTATUSA ONTIME 1')));
    await receiver.disconnect();
    assert.equal(receiver.state.connected, false);
    assert.equal(receiver.stopped, true);
  } finally {
    receiver.stop();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test TCP server did not close within 2 seconds')), 2000);
      server.close((error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
      for (const socket of sockets) socket.destroy();
    });
  }
});

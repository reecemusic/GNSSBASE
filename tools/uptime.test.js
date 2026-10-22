/**
 * Always-on behaviour: history durability, the 24 h interference cap, ephemeris
 * bursts on the live stream, archive handles that never close, and log rate limits.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { History, MAX_DETECTIONS_PER_SAMPLE } = require('../src/history');
const { InterferenceArchive } = require('../src/archive');
const { logLimited } = require('../src/loglimit');
const { gpsToMs, currentLeapSeconds, setReceiverLeapSeconds } = require('../src/novatel');

const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const browserCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/**
 * One interference detection used by the history tests.
 * @param {number} power Power in dBm.
 * @returns {object[]} Single-detection list.
 */
function sample(power) {
  return [{ powerDbm: power, centerFrequencyHz: 1.57542e9, bandwidthHz: 1000, type: 'CW' }];
}

/**
 * Evaluates a source slice inside a vm context.
 * @param {string} code Full source text.
 * @param {string} start First source substring. The slice begins at this match.
 * @param {string} end Source substring that ends the slice, exclusive.
 * @param {object} context vm context that receives the slice.
 * @returns {void}
 */
function load(code, start, end, context) {
  const first = code.indexOf(start);
  const last = code.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing source boundary: ${start}`);
  vm.runInContext(code.slice(first, last), context);
}

/** Catches a zeroed history file that disables saving even when the backup is good. */
test('a zeroed history file is recovered from its backup and saving resumes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-zero-'));
  const file = path.join(dir, 'history.json');
  try {
    const history = new History({
      retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
    });
    const now = Date.now();
    history.addInterference('L1', sample(-80), now);
    history.saveSync();
    history.addInterference('L1', sample(-70), now + 1);
    history.saveSync();
    fs.writeFileSync(file, Buffer.alloc(32));
    const loaded = new History({
      retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
    });
    loaded.load();
    assert.equal(loaded.savesDisabled, false);
    assert.ok(loaded.interference.some((item) => item.maxPower === -80));
    assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')));
    loaded.saveSync();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.ok(saved.interference.length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Catches an empty or all-NUL history file that disables saving when there is no backup. */
test('an empty or all-NUL history file starts clean and keeps saving', () => {
  for (const body of ['', Buffer.alloc(48)]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-empty-'));
    const file = path.join(dir, 'history.json');
    try {
      fs.writeFileSync(file, body);
      const history = new History({
        retentionMs: 60000, trackSampleMs: 1, maxInterferenceSamples: 10, filePath: file,
      });
      history.load();
      assert.equal(history.savesDisabled, false, `body length ${body.length}`);
      history.saveSync();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.version, 1);
      const again = new History({
        retentionMs: 60000, trackSampleMs: 1, maxInterferenceSamples: 10, filePath: file,
      });
      again.load();
      assert.equal(again.savesDisabled, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Catches a corrupt history file with no backup that is overwritten. */
test('a corrupt history file with no backup is not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-nobak-'));
  const file = path.join(dir, 'history.json');
  try {
    fs.writeFileSync(file, '{');
    const history = new History({
      retentionMs: 60000, trackSampleMs: 1, maxInterferenceSamples: 10, filePath: file,
    });
    history.load();
    assert.equal(history.savesDisabled, true);
    history.addInterference('L1', sample(-40), Date.now());
    history.saveSync();
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Catches a save that skips fsync, so a power cut can leave a zero-length file. */
test('a history save fsyncs the temp file before renaming it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-fsync-'));
  const file = path.join(dir, 'history.json');
  const real = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (fd) => {
    calls += 1;
    return real(fd);
  };
  try {
    const history = new History({
      retentionMs: 60000, trackSampleMs: 1, maxInterferenceSamples: 10, filePath: file,
    });
    history.addInterference('L1', sample(-55), Date.now());
    history.saveSync();
    assert.ok(calls >= 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).interference[0].maxPower, -55);
    const writesBefore = calls;
    history.saveSync();
    assert.equal(calls, writesBefore, 'an unchanged history is not written again');
  } finally {
    fs.fsyncSync = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Catches a live sample that stores every detection, and a save the next start cannot load. */
test('live detections are capped and a saved history stays under the load limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-budget-'));
  const file = path.join(dir, 'history.json');
  try {
    const history = new History({
      retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 5000,
      filePath: file, maxFileBytes: 6000,
    });
    const detections = Array.from({ length: 40 }, (_, index) => ({
      powerDbm: -90 + index, centerFrequencyHz: 1e9 + index, bandwidthHz: 10, type: 'CW',
    }));
    const now = Date.now();
    history.addInterference('L1', detections, now);
    assert.equal(history.interference[0].count, 40);
    assert.equal(history.interference[0].detections.length, MAX_DETECTIONS_PER_SAMPLE);
    assert.equal(history.interference[0].maxPower, -51);
    for (let index = 0; index < 80; index++) {
      history.addInterference(`L${index % 3}`, [{
        powerDbm: -80, centerFrequencyHz: 1.5e9, bandwidthHz: 1000, type: 'T'.repeat(40),
      }], now - (80 - index) * 11000);
    }
    history.saveSync();
    const size = fs.statSync(file).size;
    assert.ok(size <= 6000, `saved ${size} bytes`);
    const loaded = new History({
      retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 5000, filePath: file,
    });
    loaded.load();
    assert.equal(loaded.savesDisabled, false);
    assert.ok(loaded.interference.length >= 1);
    assert.ok(loaded.interference.every((item) => !item.detections || item.detections.length <= 32));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Catches a 24 h interference run that is trimmed down to the newest few hours. */
test('unchanged interference keeps a 24 h span inside the sample cap', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const history = new History({
    retentionMs: day, trackSampleMs: 20000, maxInterferenceSamples: 1000,
  });
  const start = now - day + 1000;
  history.addInterference('L1', sample(-40), start);
  const step = day / 20000;
  for (let index = 1; index <= 20000; index++) {
    history.addInterference('L1', [], start + Math.round(index * step));
  }
  history.prune(now);
  assert.ok(history.interference.length <= 1000);
  assert.ok(history.interference.length > 10);
  const span = history.interference[history.interference.length - 1].t - history.interference[0].t;
  assert.ok(span > 20 * 60 * 60 * 1000, `span ${span}`);
  assert.ok(history.interference.some((item) => item.count > 0 && item.maxPower === -40));
});

/** Catches a backwards clock step that freezes a sky track. */
test('a backwards clock step still appends a sky-track point', () => {
  const history = new History({
    retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 20000, maxInterferenceSamples: 10,
  });
  history.addSatellites('GPS', [{ prn: 1, elevation: 10, azimuth: 20 }], 1_000_000);
  history.addSatellites('GPS', [{ prn: 1, elevation: 11, azimuth: 21 }], 1_000_000 - 5000);
  const track = history.tracks.get('GPS:1');
  assert.equal(track.length, 2);
  assert.equal(track[1].t, 995000);
  history.addSatellites('GPS', [{ prn: 1, elevation: 12, azimuth: 22 }], 996000);
  assert.equal(history.tracks.get('GPS:1').length, 2);

  const browser = vm.createContext({
    Date, MAX_INTERFERENCE_SAMPLES: 100, MAX_TRACK_SAMPLES: 10, MAX_TRACKS: 512,
    state: { tracks: {}, interferenceHistory: [] }, isValidSkyPosition: () => true, recordSolution() {},
  });
  load(browserCode, 'function recordLiveHistory(', '// Unchanged solutions', browser);
  browser.recordLiveHistory({
    name: 'SATVIS2', crcValid: true, receivedAt: new Date(2_000_000).toISOString(),
    data: { system: 'GPS', satellites: [{ prn: 3, elevation: 10, azimuth: 20 }] },
  });
  browser.recordLiveHistory({
    name: 'SATVIS2', crcValid: true, receivedAt: new Date(1_000_000).toISOString(),
    data: { system: 'GPS', satellites: [{ prn: 3, elevation: 12, azimuth: 22 }] },
  });
  assert.equal(browser.state.tracks['GPS:3'].length, 2);
  assert.equal(browser.state.tracks['GPS:3'][1].t, 1_000_000);
});

/** Catches an ephemeris burst that disconnects a client, or a coalesced frame per satellite. */
test('an ephemeris burst is one frame and does not disconnect a normal or backed-up client', async () => {
  const frames = [];
  const client = {
    writableLength: 0,
    destroyed: false,
    write(payload) {
      this.writableLength += payload.length;
      frames.push(payload);
    },
    destroy() { this.destroyed = true; },
  };
  const slow = {
    writableLength: 300000,
    destroyed: false,
    write() { this.wrote = true; },
    destroy() { this.destroyed = true; },
  };
  const context = vm.createContext({
    clients: new Set([client, slow]),
    console,
    setTimeout,
    clearTimeout,
    EPHEMERIS_COALESCE_MS: 250,
  });
  load(serverCode, 'function broadcast(', 'function sendJson(', context);
  for (let index = 0; index < 200; index++) {
    context.noteEphemeris({
      name: 'GPSEPHEM',
      satelliteId: `S${index}`,
      count: index + 1,
      lastSatellite: `S${index}`,
      lastAt: '2026-10-22T00:00:00.000Z',
      record: { name: 'GPSEPHEM', data: { satelliteId: `S${index}`, parameters: [{ name: 'a', value: index }] } },
      satellites: [`S${index}`],
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ephemerisFrames = frames.filter((frame) => frame.startsWith('event: ephemeris'));
  assert.equal(ephemerisFrames.length, 1);
  const payload = JSON.parse(ephemerisFrames[0].replace(/^event: ephemeris\ndata: /, '').trim());
  assert.equal(payload.updates.length, 200);
  assert.equal(client.destroyed, false);
  assert.equal(slow.destroyed, false);
  assert.equal(slow.wrote, undefined);
  context.broadcast('message', { record: { name: 'BESTPOS' } });
  assert.equal(slow.destroyed, true);
  assert.equal(client.destroyed, false);
});

/** Catches a NAS read that never closes and blocks archive loads forever. */
test('a stuck archive handle ages out so loading can continue', async () => {
  const { EventEmitter } = require('node:events');
  const archive = new InterferenceArchive({
    hungResetMs: 10000, stuckHandleMs: 30, fsTimeoutMs: 20, cacheDir: null, settingsFile: null,
    defaultRoot: path.parse(process.cwd()).root,
  });
  const stream = new EventEmitter();
  stream.closed = false;
  stream.destroy = () => {};
  archive.stream = stream;
  archive.stopStream();
  assert.equal(archive.stuckHandles, 1);
  assert.throws(() => archive.assertAvailable(), /outstanding request/);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(archive.stuckHandles, 0);
  assert.match(archive.autoState.lastError, /did not close and was released/);
  assert.doesNotThrow(() => archive.assertAvailable());
});

/** Catches a repeated failure that prints a line for every message instead of a once-per-minute count. */
test('repeated log lines print once and then a once-per-minute count', async () => {
  const previous = process.env.LOG_SUMMARY_MS;
  process.env.LOG_SUMMARY_MS = '30';
  const lines = [];
  const original = console.warn;
  console.warn = (message) => lines.push(String(message));
  try {
    logLimited('warn', 'uptime-demo', 'first failure');
    logLimited('warn', 'uptime-demo', 'first failure');
    logLimited('warn', 'uptime-demo', 'first failure');
    assert.deepEqual(lines, ['first failure']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /uptime-demo: 2 similar messages in the last minute/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    logLimited('warn', 'uptime-demo', 'first failure');
    assert.equal(lines[2], 'first failure');
  } finally {
    console.warn = original;
    if (previous === undefined) delete process.env.LOG_SUMMARY_MS;
    else process.env.LOG_SUMMARY_MS = previous;
  }
});

/** Catches a hardcoded leap-second offset that ignores the environment and a receiver value. */
test('leap seconds follow the receiver value, then the environment, then 18', () => {
  const previous = process.env.NOVATEL_LEAP_SECONDS;
  const week = 2300;
  const seconds = 1000;
  try {
    delete process.env.NOVATEL_LEAP_SECONDS;
    setReceiverLeapSeconds(18);
    const at18 = gpsToMs(week, seconds);
    process.env.NOVATEL_LEAP_SECONDS = '19';
    // The receiver value still wins over the environment.
    assert.equal(currentLeapSeconds(), 18);
    setReceiverLeapSeconds(null);
    assert.equal(currentLeapSeconds(), 19);
    assert.equal(gpsToMs(week, seconds), at18 - 1000);
    delete process.env.NOVATEL_LEAP_SECONDS;
    assert.equal(currentLeapSeconds(), 18);
    assert.equal(gpsToMs(week, seconds), at18);
  } finally {
    if (previous === undefined) delete process.env.NOVATEL_LEAP_SECONDS;
    else process.env.NOVATEL_LEAP_SECONDS = previous;
    setReceiverLeapSeconds(18);
  }
});

/** Catches a serial rate change that also changes the default command, or a repeated baud warning. */
test('BESTSATS and TRACKSTAT periods are configurable and a slow serial port warns once', () => {
  const { EventEmitter } = require('node:events');
  const warnings = [];
  const writes = [];
  const socket = new EventEmitter();
  socket.write = (command) => writes.push(command);
  socket.setKeepAlive = () => {};
  socket.setTimeout = () => {};
  const context = vm.createContext({
    Buffer, clearTimeout, setTimeout, module: { exports: {} },
    console: { warn(message) { warnings.push(String(message)); }, log() {}, error() {} },
    require: (name) => {
      if (name === 'node:net') return { createConnection: () => socket };
      if (name === 'node:events') return require('node:events');
      if (name === './novatel') return require('../src/novatel');
      if (name === './loglimit') return require('../src/loglimit');
      if (name === 'serialport') return { SerialPort: function SerialPort() {} };
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'receiver.js'), 'utf8'), context);
  const slowed = new context.module.exports.ReceiverClient({
    transport: 'tcp', sendLogCommands: false, ephemerisLogCommands: [],
    bestsatsLogSeconds: 10, trackstatLogSeconds: 30,
  });
  slowed.sendConfiguredCommands(socket);
  assert.deepEqual(writes, [
    'LOG BESTSATSA ONTIME 10\r\n',
    'LOG TRACKSTATA ONTIME 30\r\n',
    'LOG ITDETECTSTATUSA ONTIME 1\r\n',
  ]);
  slowed.onConnected();
  assert.equal(warnings.length, 0);
  const serial = new context.module.exports.ReceiverClient({
    transport: 'serial', serialBaudRate: 9600, serialPath: 'COM11', sendLogCommands: false,
  });
  serial.onConnected();
  serial.onConnected();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /BESTSATS_LOG_SEC/);
  assert.match(warnings[0], /TRACKSTAT_LOG_SEC/);
  assert.match(warnings[0], /9600/);
});

/** Catches a closed EventSource that is never opened again. */
test('a closed live stream is opened again after a backoff', async () => {
  const created = [];
  /**
   * Minimal EventSource. Records listeners and instances.
   */
  class EventSource {
    constructor() {
      created.push(this);
      this.listeners = {};
      this.readyState = 0;
    }

    /**
     * @param {string} name Event name.
     * @param {Function} handler Listener.
     * @returns {void}
     */
    addEventListener(name, handler) { this.listeners[name] = handler; }

    /** @returns {void} */
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    source: null,
    streamRetryMs: 1000,
    streamRetryTimer: null,
    document: { hidden: false },
    connection: { offline: false },
    EventSource,
    setTimeout,
    clearTimeout,
    renderConnectionBar() {},
    handleStreamEvent() {},
    renderStatus() {},
    applySnapshot() {},
    applyPayload() {},
    applyArchiveStatus() {},
    state: { ephemeris: {} },
  });
  load(browserCode, 'function connectStream()', 'function renderStatus(', context);
  context.connectStream();
  assert.equal(created.length, 1);
  created[0].readyState = 0;
  created[0].listeners.error();
  assert.equal(created.length, 1);
  created[0].readyState = 2;
  created[0].listeners.error();
  assert.equal(context.source, null);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  assert.equal(context.connection.offline, true);
});

/** Catches the thread-pool size being set after the server module loads. */
test('the start wrapper sets the libuv pool size before loading the server', () => {
  const start = fs.readFileSync(path.join(__dirname, '..', 'src', 'start.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(start.indexOf('UV_THREADPOOL_SIZE') < start.indexOf("require('./server')"));
  assert.ok(server.indexOf('UV_THREADPOOL_SIZE') < server.indexOf("require('node:fs')"));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'), /src\/start\.js/);
});

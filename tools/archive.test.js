'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const { novatelCrc32, novatelCrc32Buffer } = require('../src/novatel');
const { InterferenceArchive, FileSummary, createItDetectScanner, fileNameTime } = require('../src/archive');

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function gpsTime(t) {
  const gps = t - GPS_EPOCH_MS + 18000;
  return { week: Math.floor(gps / 604800000), ms: gps % 604800000 };
}

function binaryFrame(id, t, body, { antenna = 0, corrupt = false } = {}) {
  const header = Buffer.alloc(28);
  header.set([0xaa, 0x44, 0x12, 28]);
  header.writeUInt16LE(id, 4);
  header[6] = antenna;
  header.writeUInt16LE(body.length, 8);
  const { week, ms } = gpsTime(t);
  header.writeUInt16LE(week, 14);
  header.writeUInt32LE(ms, 16);
  const frame = Buffer.concat([header, body, Buffer.alloc(4)]);
  frame.writeUInt32LE((novatelCrc32Buffer(frame, 0, frame.length - 4) ^ (corrupt ? 1 : 0)) >>> 0, frame.length - 4);
  return frame;
}

function itBody(detections = []) {
  const body = Buffer.alloc(4 + detections.length * 36);
  body.writeUInt32LE(detections.length, 0);
  detections.forEach(({ rf, type = 0, center, bandwidth, power }, index) => {
    const offset = 4 + index * 36;
    body.writeUInt32LE(rf, offset);
    body.writeUInt32LE(type, offset + 4);
    body.writeFloatLE(center, offset + 8);
    body.writeFloatLE(bandwidth, offset + 12);
    body.writeFloatLE(power, offset + 16);
  });
  return body;
}

function asciiLine(t, data = '0', name = 'ITDETECTSTATUSA') {
  const { week, ms } = gpsTime(t);
  const body = `${name},FILE,0,53.0,FINESTEERING,${week},${(ms / 1000).toFixed(3)},02000000,0000,16809;${data}`;
  return Buffer.from(`#${body}*${novatelCrc32(body).toString(16).padStart(8, '0')}\r\n`, 'latin1');
}

function bestposBody(used, type = 16, status = 0, tracked = 30) {
  const body = Buffer.alloc(72);
  body.writeUInt32LE(status, 0);
  body.writeUInt32LE(type, 4);
  body[64] = tracked;
  body[65] = used;
  return body;
}

function bestposAscii(t, used, type = 'SINGLE', status = 'SOL_COMPUTED', name = 'BESTPOSA') {
  return asciiLine(t, `${status},${type},51,-1,100,0,WGS84,1,1,1,"",0,0,30,${used}`, name);
}

function bestsatsAscii(t, statuses, name = 'BESTSATSA') {
  return asciiLine(t, [statuses.length, ...statuses.flatMap((status, index) =>
    ['GPS', index + 1, status, '00000007'])].join(','), name);
}

function bestsatsBody(statuses) {
  const body = Buffer.alloc(4 + statuses.length * 16);
  body.writeUInt32LE(statuses.length, 0);
  statuses.forEach((status, index) => {
    body.writeUInt32LE(index + 1, 8 + index * 16);
    body.writeUInt32LE(status, 12 + index * 16);
    body.writeUInt32LE(7, 16 + index * 16);
  });
  return body;
}

test('BESTSATS ASCII and binary recover GOOD count without inventing fix type or tracked count', () => {
  const start = NOW - 3600000;
  const log = Buffer.concat([
    bestsatsAscii(start, ['GOOD', 'NOTUSED', 'SUPPLEMENTARY', 'GOOD', 'BADHEALTH']),
    binaryFrame(1194, start + 10000, bestsatsBody([0, 17, 26, 0, 1])),
    bestsatsAscii(start + 20000, []),
    binaryFrame(1194, start + 100000, bestsatsBody([17, 1])),
    bestsatsAscii(start + 101000, ['GOOD'], 'BESTSATSA_1'),
    binaryFrame(1194, start + 102000, bestsatsBody([0]), { antenna: 1 }),
    binaryFrame(1194, start + 103000, bestsatsBody([0]), { corrupt: true }),
    binaryFrame(1194, start + 104000, Buffer.alloc(3)),
    asciiLine(start + 105000, '2,GPS,1,GOOD,00000001', 'BESTSATSA'),
  ]);
  const expected = scan(log, log.length);
  assert.equal(expected.bestsatsReports, 4);
  assert.equal(expected.solutionReports, 0);
  assert.equal(expected.crcErrors, 3);
  assert.deepEqual(expected.bestsats, [
    { t: start, end: start + 20000, used: 2, tracked: null, status: null, type: null },
    { t: start + 20000, end: start + 55000, used: 0, tracked: null, status: null, type: null },
    { t: start + 100000, end: start + 135000, used: 0, tracked: null, status: null, type: null },
  ]);
  for (const size of [1, 3, 17, 29, 100, 4096]) assert.deepEqual(scan(log, size), expected, `chunk size ${size}`);
});

test('BESTPOS scanner parses ASCII and binary with receiver times, CRC checks and chunk boundaries', () => {
  const start = NOW - 3600000;
  const log = Buffer.concat([
    binaryFrame(42, start, bestposBody(20)),
    bestposAscii(start + 10000, 20),
    binaryFrame(42, start + 20000, bestposBody(22, 50)),
    bestposAscii(start + 30000, 23, 'NARROW_FLOAT'),
    binaryFrame(42, start + 31000, bestposBody(1), { corrupt: true }),
    binaryFrame(42, start + 32000, bestposBody(2), { antenna: 1 }),
    bestposAscii(start + 33000, 3, 'SINGLE', 'SOL_COMPUTED', 'BESTPOSA_1'),
    binaryFrame(42, start + 34000, Buffer.alloc(8)),
    bestposAscii(start + 100000, 0, 'NONE', 'INSUFFICIENT_OBS'),
    asciiLine(start + 101000, 'SOL_COMPUTED,SINGLE', 'BESTPOSA'),
  ]);
  const expected = scan(log, log.length);
  assert.equal(expected.solutionReports, 5);
  assert.equal(expected.crcErrors, 3, 'bad CRC and truncated BESTPOS bodies are reported');
  assert.equal(expected.reportCount, 0);
  assert.deepEqual(expected.solution, [
    { t: start, end: start + 20000, used: 20, tracked: 30, status: 'SOL_COMPUTED', type: 'SINGLE' },
    { t: start + 20000, end: start + 30000, used: 22, tracked: 30, status: 'SOL_COMPUTED', type: 'NARROW_INT' },
    { t: start + 30000, end: start + 65000, used: 23, tracked: 30, status: 'SOL_COMPUTED', type: 'NARROW_FLOAT' },
    { t: start + 100000, end: start + 135000, used: 0, tracked: 30, status: 'INSUFFICIENT_OBS', type: 'NONE' },
  ]);
  for (const size of [1, 3, 17, 29, 100, 4096]) assert.deepEqual(scan(log, size), expected, `chunk size ${size}`);
});

/** A mixed log: large unrelated binary frames, binary and ASCII ITDETECTSTATUS, and noise. */
function sampleLog(start) {
  const filler = Buffer.alloc(4000, 0xaa); // repeated sync-like bytes inside a skipped frame
  return Buffer.concat([
    Buffer.from('garbage\r\n'),
    binaryFrame(43, start, filler),
    binaryFrame(2065, start, itBody()),
    binaryFrame(2065, start + 500, itBody([{ rf: 2, center: 1575.42, bandwidth: 2, power: -88 }])),
    binaryFrame(2065, start + 600, itBody([{ rf: 2, center: 1575.42, bandwidth: 2, power: -80 }])),
    binaryFrame(2065, start + 700, itBody([{ rf: 3, center: 1227.6, bandwidth: 1, power: -100 }]), { antenna: 1 }),
    binaryFrame(2065, start + 800, itBody(), { corrupt: true }),
    binaryFrame(42, start + 900, Buffer.alloc(72)),
    asciiLine(start + 1000),
    asciiLine(start + 2000, '0', 'ITDETECTSTATUSA_1'),
    asciiLine(start + 3000, '1,L5,SPECTRUMANALYSIS,1176.450,3.000,-95.5,-130.0,0,0,0'),
    binaryFrame(43, start + 3500, filler),
    asciiLine(start + 60000),
  ]);
}

function scan(buffer, chunkSize) {
  const summary = new FileSummary();
  const scanner = createItDetectScanner(summary);
  for (let offset = 0; offset < buffer.length; offset += chunkSize) scanner.push(buffer.subarray(offset, offset + chunkSize));
  return summary.toJSON();
}

test('scanner decodes binary and ASCII ITDETECTSTATUS regardless of chunk boundaries', () => {
  const start = NOW - 3600000;
  const log = sampleLog(start);
  const expected = scan(log, log.length);
  assert.equal(expected.reportCount, 6, 'primary-antenna, CRC-valid reports only');
  assert.equal(expected.crcErrors, 1);
  assert.deepEqual(expected.coverage, [[start, start + 3000], [start + 60000, start + 60000]]);
  assert.deepEqual(expected.samples.map(({ t, signal, count, maxPower }) => ({ t, signal, count, maxPower })), [
    { t: start + 600, signal: 'L1', count: 1, maxPower: -80 },
    { t: start + 3000, signal: 'L5', count: 1, maxPower: -95.5 },
  ], 'detections in the same second keep the strongest; clear reports are coverage only');
  assert(Math.abs(expected.samples[0].detections[0].freq - 1575.42e6) < 1000, 'float32 MHz converted to Hz');
  for (const size of [1, 3, 17, 29, 100, 4096]) {
    assert.deepEqual(scan(log, size), expected, `chunk size ${size}`);
  }
});

test('file names give approximate start times', () => {
  assert.equal(fileNameTime('NMUT23450006R_2026-10-02_00-43-27.LOG'), Date.UTC(2026, 9, 2, 0, 43, 27));
  assert.equal(fileNameTime('other.log'), null);
});

async function waitFor(archive, states) {
  while (!states.includes(archive.status().state)) await once(archive, 'status');
  return archive.status();
}

function makeArchive(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'pwrpak1');
  const write = (doy, name, buffer) => {
    const folder = path.join(root, '2026', doy);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name), buffer);
  };
  const options = {
    defaultRoot: root, cacheDir: path.join(dir, 'cache'), settingsFile: path.join(dir, 'settings.json'),
    now: () => NOW, ...extra,
  };
  return { root, dir, write, options };
}

test('archive loads the requested days from YYYY/DDD folders and reuses its cache', async (t) => {
  const { root, write, options } = makeArchive(t);
  // 2026-10-20 is day 293.
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 2 * 3600000));
  write('292', 'X_2026-10-19_13-00-00.LOG', sampleLog(NOW - 23 * 3600000));
  write('280', 'X_2026-10-07_10-00-00.LOG', sampleLog(NOW - 13 * 86400000));
  write('293', 'notes.txt', Buffer.from('ignored'));

  const archive = new InterferenceArchive(options);
  assert.throws(() => archive.load({ root: 'relative\\path', days: 1 }), /absolute/);
  assert.throws(() => archive.load({ root, days: 0 }), /Days/);
  archive.load({ root, days: 1 });
  let status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.filesTotal, 2, 'the 13-day-old folder is not read');
  assert.equal(status.filesCached, 0);
  assert.equal(status.reports, 12);
  assert.equal(status.samples, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')), { root, days: 1 });

  const result = archive.query({ from: NOW - 86400000, to: NOW, buckets: 100 });
  assert.equal(result.bucketMs, 864000);
  assert.equal(result.samples.length, 4, 'one strongest sample per signal and bucket');
  assert.equal(result.coverage.length, 2, 'coverage gaps shorter than a bucket are merged');

  const reloaded = new InterferenceArchive(options);
  assert.deepEqual(reloaded.settings, { root, days: 1 }, 'settings persist across restarts');
  reloaded.load({});
  status = await waitFor(reloaded, ['ready', 'error']);
  assert.equal(status.filesCached, 2, 'second load reads summaries from the cache');
  assert.deepEqual(reloaded.query({ from: NOW - 86400000, to: NOW, buckets: 100 }), result);

  reloaded.clear();
  assert.equal(reloaded.status().state, 'idle');
  assert.equal(reloaded.status().samples, 0);
});

test('archive reports an unreachable folder and can be cancelled', async (t) => {
  const { root, write, options } = makeArchive(t);
  const archive = new InterferenceArchive(options);
  archive.load({ root: path.join(root, 'missing'), days: 1 });
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'error');
  assert.match(status.message, /not reachable/);

  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 3600000));
  archive.load({ root, days: 1 });
  assert.equal(archive.cancel().state, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(archive.status().state, 'cancelled', 'a cancelled scan does not resume');
});

test('BESTPOS-only archives load, clip long intervals, invalidate old caches and reload from cache', async (t) => {
  const { write, options } = makeArchive(t);
  const start = NOW - 3600000;
  write('293', 'X_2026-10-20_11-00-00.LOG', Buffer.concat([
    bestposAscii(start, 20),
    binaryFrame(42, start + 10000, bestposBody(20)),
    bestposAscii(start + 20000, 22, 'FIXEDPOS'),
    bestposAscii(start + 30000, 22, 'FIXEDPOS'),
  ]));
  const archive = new InterferenceArchive(options);
  archive.load({ days: 1 });
  let status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.reports, 0);
  assert.equal(status.solutionReports, 4);
  assert.equal(status.solutionSamples, 2);
  const query = { from: start + 5000, to: start + 60000, buckets: 100 };
  const result = archive.query(query);
  assert.deepEqual(result.solution.map(({ t, end, used, type }) => ({ t, end, used, type })), [
    { t: start + 5000, end: start + 20000, used: 20, type: 'SINGLE' },
    { t: start + 20000, end: start + 60000, used: 22, type: 'FIXEDPOS' },
  ]);
  archive.load({});
  status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.filesCached, 1);
  assert.deepEqual(archive.query(query), result);

  const zlib = require('node:zlib');
  const cachePath = path.join(options.cacheDir, fs.readdirSync(options.cacheDir)[0]);
  const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath)));
  old.version = 2;
  delete old.solution;
  fs.writeFileSync(cachePath, zlib.gzipSync(JSON.stringify(old)));
  archive.load({});
  status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.filesCached, 0, 'pre-BESTPOS summaries are rescanned');
  assert.deepEqual(archive.query(query), result);
  archive.clear();
  assert.equal(archive.status().solutionSamples, 0);
  assert.deepEqual(archive.query(query).solution, []);
});

test('BESTSATS loads from cache and stays separate from BESTPOS across files and report order', async (t) => {
  const { write, options } = makeArchive(t);
  const start = NOW - 3600000;
  write('293', 'a.LOG', Buffer.concat([
    bestposAscii(start + 10000, 22, 'NARROW_INT'),
    bestsatsAscii(start + 10000, ['GOOD']),
  ]));
  write('293', 'b.LOG', Buffer.concat([
    binaryFrame(1194, start, bestsatsBody([0, 0, 17])),
    bestsatsAscii(start + 20000, ['GOOD', 'GOOD']),
  ]));
  const archive = new InterferenceArchive(options);
  const query = { from: start, to: start + 60000, buckets: 100 };
  archive.load({ days: 1 });
  let status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.bestsatsReports, 3);
  assert.equal(status.solutionReports, 1);
  const result = archive.query(query);
  assert(result.bestsats.length > 0);
  assert.equal(result.solution[0].used, 22);
  assert(result.bestsats.every((sample) => sample.type === null && sample.status === null));
  archive.load({});
  status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.filesCached, 2);
  assert.deepEqual(archive.query(query), result);
  archive.clear();
  assert.equal(archive.status().bestsatsSamples, 0);
  assert.deepEqual(archive.query(query).bestsats, []);
});

test('rapidly changing BESTSATS counts have bounded scan, storage and response sizes', async (t) => {
  const { write, options } = makeArchive(t, { maxSamples: 20 });
  const start = NOW - 3600000;
  const summary = new FileSummary(20);
  const frames = [];
  for (let index = 0; index < 1000; index++) {
    summary.addBestSats(start + index * 1000, index % 25);
    frames.push(binaryFrame(1194, start + index * 1000, bestsatsBody(Array(index % 25).fill(0))));
  }
  assert(summary.toJSON().bestsats.length <= 20);
  write('293', 'a.LOG', Buffer.concat(frames));
  write('293', 'b.LOG', Buffer.concat(frames));
  const archive = new InterferenceArchive(options);
  archive.load({ days: 1 });
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.bestsatsReports, 2000);
  assert(status.bestsatsSamples <= 20);
  assert(archive.query({ from: start, to: NOW, buckets: 10 }).bestsats.length <= 11);
});

test('BESTPOS storage and query sizes stay bounded even with rapidly changing solutions', async (t) => {
  const { write, options } = makeArchive(t, { maxSamples: 20 });
  const start = NOW - 3600000;
  const summary = new FileSummary(20);
  const log = [];
  for (let i = 0; i < 1000; i++) {
    summary.addSolution(start + i * 1000, { satellitesUsed: i % 25, satellitesTracked: 30, positionType: 'SINGLE' });
    log.push(bestposAscii(start + i * 1000, i % 25));
  }
  assert(summary.solution.length <= 20);
  assert(summary.solutionResolutionMs > 1000);
  for (let file = 0; file < 3; file++) {
    write('293', `X_2026-10-20_11-0${file}-00.LOG`, Buffer.concat(log));
  }
  const archive = new InterferenceArchive(options);
  archive.load({ days: 1 });
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.solutionReports, 3000);
  assert(status.solutionSamples <= 20);
  const result = archive.query({ from: start, to: NOW, buckets: 10 });
  assert(result.solution.length <= 11, 'one interval per query bucket, including the end boundary');
  assert(result.solution.every((s) => s.end >= s.t && s.t >= start && s.end <= start + 999000 + 35000),
    'coarsening stays inside the continuous source coverage');
});

test('query downsampling keeps continuous coverage but never fills a missing BESTPOS gap', () => {
  const archive = new InterferenceArchive({ defaultRoot: os.tmpdir() });
  const summary = new FileSummary();
  for (let i = 0; i < 200; i++) {
    if (i >= 60 && i < 150) continue;
    summary.addSolution(i * 1000, { satellitesUsed: i % 25, positionType: 'SINGLE' });
  }
  archive.addSummary(summary.toJSON(), 0, 200000);
  const result = archive.query({ from: 0, to: 10000000, buckets: 10 });
  assert.equal(result.solution.length, 1, 'latest reporting segment per bucket');
  assert.equal(result.solution[0].t, 150000, 'the earlier segment is not joined across the gap');
  assert.equal(result.solution[0].end, 200000);

  const detailed = archive.query({ from: 0, to: 200000, buckets: 10 });
  assert(detailed.solution.every((s) => s.end <= 94000 || s.t >= 150000), 'lost output remains a real gap');
});

test('archive coarsens detection resolution to stay within its sample limit', async (t) => {
  const { root, write, options } = makeArchive(t, { maxSamples: 1000, cacheDir: null });
  const start = NOW - 3 * 3600000;
  const frames = [];
  for (let second = 0; second < 3000; second++) {
    frames.push(binaryFrame(2065, start + second * 1000,
      itBody([{ rf: 2, center: 1575.42, bandwidth: 2, power: -100 + (second % 10) }])));
  }
  write('293', 'X_2026-10-20_09-00-00.LOG', Buffer.concat(frames));
  const archive = new InterferenceArchive(options);
  archive.load({ root, days: 1 });
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.reports, 3000);
  assert(status.samples <= 750);
  assert(status.resolutionMs >= 4000);
  const result = archive.query({ from: start, to: start + 3000000, buckets: 4000 });
  assert.equal(result.bucketMs, status.resolutionMs, 'queries never claim finer detail than is stored');
  assert.equal(Math.max(...result.samples.map((sample) => sample.maxPower)), -91, 'the strongest report survives coarsening');
  assert(result.samples.length <= 750);
});

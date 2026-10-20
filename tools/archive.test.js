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

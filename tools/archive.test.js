/**
 * Locks in the archive scanner and NAS failure modes: binary and ASCII
 * framing, cached summaries, and loads that time out or keep the previous
 * data when the share stalls or returns an error.
 */
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

/**
 * Converts a UTC millisecond timestamp into GPS week and milliseconds-of-week.
 * Adds 18000 ms (18 s) before splitting. A week is 604800000 ms.
 * @param {number} t UTC time in milliseconds.
 * @returns {{week: number, ms: number}} GPS week and milliseconds into that week.
 */
function gpsTime(t) {
  // UTC plus 18 s, then split into GPS week and ms-of-week (604800000 ms).
  const gps = t - GPS_EPOCH_MS + 18000;
  return { week: Math.floor(gps / 604800000), ms: gps % 604800000 };
}

/**
 * Builds one NovAtel binary frame.
 * Header bytes written: sync AA 44 12, header length 28, message id at offset 4,
 * antenna at byte 6, body length at offset 8, GPS week at offset 14, and
 * milliseconds-of-week at offset 16. Other header bytes stay 0.
 * The last four bytes are the CRC32 of everything before them; corrupt flips the low bit.
 * @param {number} id Message id.
 * @param {number} t UTC timestamp passed through gpsTime.
 * @param {Buffer} body Message body.
 * @param {number} [antenna=0] Value written at header byte 6.
 * @param {boolean} [corrupt=false] When true, XOR the CRC with 1.
 * @returns {Buffer} Header, body, and 4-byte CRC.
 */
function binaryFrame(id, t, body, { antenna = 0, corrupt = false } = {}) {
  const header = Buffer.alloc(28);
  // Sync AA 44 12, then header length 28.
  header.set([0xaa, 0x44, 0x12, 28]);
  // Message id, uint16 little-endian at offset 4.
  header.writeUInt16LE(id, 4);
  // Antenna value at byte 6.
  header[6] = antenna;
  // Body length, uint16 little-endian at offset 8.
  header.writeUInt16LE(body.length, 8);
  const { week, ms } = gpsTime(t);
  // GPS week at offset 14 and milliseconds-of-week at offset 16.
  header.writeUInt16LE(week, 14);
  header.writeUInt32LE(ms, 16);
  const frame = Buffer.concat([header, body, Buffer.alloc(4)]);
  // CRC32 of every byte except these four. corrupt flips the low bit.
  frame.writeUInt32LE((novatelCrc32Buffer(frame, 0, frame.length - 4) ^ (corrupt ? 1 : 0)) >>> 0, frame.length - 4);
  return frame;
}

/**
 * Builds an ITDETECTSTATUS binary body: a count, then one 36-byte record per detection.
 * @param {Array<{rf: number, type?: number, center: number, bandwidth: number, power: number}>} [detections] Detection records. type defaults to 0.
 * @returns {Buffer}
 */
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

/**
 * Builds one CRC-terminated ASCII log line. Week and seconds come from gpsTime.
 * @param {number} t UTC timestamp.
 * @param {string} [data='0'] Payload after the semicolon.
 * @param {string} [name='ITDETECTSTATUSA'] Log name.
 * @returns {Buffer} `#` line with an 8-digit CRC of the sentence between `#` and `*`.
 */
function asciiLine(t, data = '0', name = 'ITDETECTSTATUSA') {
  const { week, ms } = gpsTime(t);
  const body = `${name},FILE,0,53.0,FINESTEERING,${week},${(ms / 1000).toFixed(3)},02000000,0000,16809;${data}`;
  // Eight-digit CRC of the sentence between # and *.
  return Buffer.from(`#${body}*${novatelCrc32(body).toString(16).padStart(8, '0')}\r\n`, 'latin1');
}

/**
 * Builds a 72-byte BESTPOS body. Only status, type, tracked, and used are written.
 * @param {number} used Satellites used, byte 65.
 * @param {number} [type=16] Position type at byte 4.
 * @param {number} [status=0] Solution status at byte 0.
 * @param {number} [tracked=30] Satellites tracked, byte 64.
 * @returns {Buffer} 72-byte body. Every other byte stays 0.
 */
function bestposBody(used, type = 16, status = 0, tracked = 30) {
  const body = Buffer.alloc(72);
  body.writeUInt32LE(status, 0);
  body.writeUInt32LE(type, 4);
  body[64] = tracked;
  body[65] = used;
  return body;
}

/**
 * Builds a CRC-terminated BESTPOS ASCII line.
 * @param {number} t UTC timestamp.
 * @param {number} used Satellites used, written as the last field.
 * @param {string} [type='SINGLE'] Position type text.
 * @param {string} [status='SOL_COMPUTED'] Solution status text.
 * @param {string} [name='BESTPOSA'] Log name.
 * @returns {Buffer}
 */
function bestposAscii(t, used, type = 'SINGLE', status = 'SOL_COMPUTED', name = 'BESTPOSA') {
  return asciiLine(t, `${status},${type},51,-1,100,0,WGS84,1,1,1,"",0,0,30,${used}`, name);
}

/**
 * Builds a CRC-terminated BESTSATS ASCII line, one GPS entry per status.
 * @param {number} t UTC timestamp.
 * @param {string[]} statuses Per-satellite status strings. PRNs are 1-based indexes.
 * @param {string} [name='BESTSATSA'] Log name.
 * @returns {Buffer}
 */
function bestsatsAscii(t, statuses, name = 'BESTSATSA') {
  return asciiLine(t, [statuses.length, ...statuses.flatMap((status, index) =>
    ['GPS', index + 1, status, '00000007'])].join(','), name);
}

/**
 * Builds a BESTSATS binary body: uint32 count, then 16-byte records.
 * Each record leaves the system word 0 and writes PRN, status, and mask 7.
 * @param {number[]} statuses Status word per satellite. PRN is the 1-based index.
 * @returns {Buffer}
 */
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

/** Catches a scan that invents fix type or tracked count, or that changes when the same log is split. */
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

/** Catches a scan that stops after a bad BESTSATS or truncated detection instead of keeping the next valid reports. */
test('archive skips malformed decoded records and continues through the following valid reports', () => {
  const start = NOW - 3600000;
  const truncated = Buffer.alloc(4);
  truncated.writeUInt32LE(1);
  const log = Buffer.concat([
    asciiLine(start, '1,GPS,1,GOOD,not-hex', 'BESTSATSA'),
    bestsatsAscii(start + 1000, ['GOOD']),
    binaryFrame(2065, start + 2000, truncated),
    asciiLine(start + 3000, '1,L1'),
    asciiLine(start + 4000, '0'),
  ]);
  const summary = scan(log, 17);
  assert.equal(summary.crcErrors, 3, 'malformed payloads are counted even with valid checksums');
  assert.equal(summary.bestsatsReports, 1);
  assert.equal(summary.reportCount, 1, 'truncated detections cannot become false clear coverage');
  assert.deepEqual(summary.coverage, [[start + 4000, start + 4000]]);
});

/** Catches BESTPOS times, CRC errors, or solution intervals that change when the log is read in small chunks. */
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

/**
 * Mixed log: unrelated binary frames, binary and ASCII ITDETECTSTATUS, and noise.
 * @param {number} start UTC start time in milliseconds.
 * @returns {Buffer} Concatenated frames used by the scanner tests.
 */
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

/**
 * Pushes a buffer through the ITDETECT scanner in fixed-size chunks.
 * @param {Buffer} buffer Log bytes.
 * @param {number} chunkSize Maximum bytes per push.
 * @returns {object} FileSummary JSON.
 */
function scan(buffer, chunkSize) {
  const summary = new FileSummary();
  const scanner = createItDetectScanner(summary);
  for (let offset = 0; offset < buffer.length; offset += chunkSize) scanner.push(buffer.subarray(offset, offset + chunkSize));
  return summary.toJSON();
}

/** Catches ITDETECTSTATUS reports dropped at a chunk boundary, or clear reports stored as detections. */
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

/** Catches a file-name clock that misses the YYYY-MM-DD_HH-mm-ss stamp or accepts an unrelated name. */
test('file names give approximate start times', () => {
  assert.equal(fileNameTime('NMUT23450006R_2026-10-02_00-43-27.LOG'), Date.UTC(2026, 9, 2, 0, 43, 27));
  assert.equal(fileNameTime('other.log'), null);
});

/**
 * Resolves with archive.status() once state is listed, waiting on status events if needed.
 * @param {object} archive InterferenceArchive under test.
 * @param {string[]} states Status states that end the wait.
 * @returns {Promise<object>} Matching status object.
 */
async function waitFor(archive, states) {
  while (!states.includes(archive.status().state)) await once(archive, 'status');
  return archive.status();
}

/**
 * Creates a temporary archive root under os.tmpdir() and removes it when the test ends.
 * @param {object} t Node test context. t.after deletes the temp directory.
 * @param {object} [extra] Extra InterferenceArchive options merged over the temp paths.
 * @returns {{root: string, dir: string, write: Function, options: object}}
 */
function makeArchive(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'pwrpak1');
  /**
   * Writes one log under root/2026/<doy>/, creating the folder if needed.
   * @param {string} doy Day-of-year folder name.
   * @param {string} name File name.
   * @param {Buffer} buffer File contents.
   * @returns {void}
   */
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

/** Catches a load that reads outside the requested days, ignores the cache, or drops saved settings. */
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
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')), { root, days: 1, auto: false });

  const result = archive.query({ from: NOW - 86400000, to: NOW, buckets: 100 });
  assert.equal(result.bucketMs, 864000);
  assert.equal(result.samples.length, 4, 'one strongest sample per signal and bucket');
  assert.equal(result.coverage.length, 2, 'coverage gaps shorter than a bucket are merged');

  const reloaded = new InterferenceArchive(options);
  assert.deepEqual(reloaded.settings, { root, days: 1, auto: false }, 'settings persist across restarts');
  reloaded.load({});
  status = await waitFor(reloaded, ['ready', 'error']);
  assert.equal(status.filesCached, 2, 'second load reads summaries from the cache');
  assert.deepEqual(reloaded.query({ from: NOW - 86400000, to: NOW, buckets: 100 }), result);

  reloaded.clear();
  assert.equal(reloaded.status().state, 'idle');
  assert.equal(reloaded.status().samples, 0);
});

/** Catches a missing root reported as ready, or a cancel that lets the scan continue. */
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

/** Catches BESTPOS intervals that ignore the query window, or an old cache version that is reused. */
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

/** Catches BESTSATS samples merged into BESTPOS, or a cache reload that changes the query. */
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

/** Catches BESTSATS storage or a query that grows without a bound as the used count changes every second. */
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

/** Catches solution storage or a query that grows without a bound, or coarsening that leaves the source span. */
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

/** Catches query downsampling that joins BESTPOS intervals across a gap with no reports. */
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

/** Catches detection storage past the sample limit, or a query that claims finer resolution than was stored. */
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

/** Catches a refresh that hides the loaded archive before the new scan is ready to swap in. */
test('a background refresh keeps the loaded data visible until the new load is swapped in', async (t) => {
  const { root, write, options } = makeArchive(t);
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 2 * 3600000));
  const archive = new InterferenceArchive(options);
  archive.load({ root, days: 1 });
  const first = await waitFor(archive, ['ready', 'error']);
  assert.equal(first.state, 'ready', first.message);
  const query = { from: NOW - 86400000, to: NOW, buckets: 100 };
  const before = archive.query(query);

  write('293', 'X_2026-10-20_11-00-00.LOG', sampleLog(NOW - 3600000));
  archive.start(root, 1, true);
  const during = archive.status();
  assert.equal(during.refreshing, true);
  assert.equal(during.state, 'listing');
  assert.equal(during.generation, first.generation, 'clients keep their data while refreshing');
  assert.equal(during.samples, first.samples);
  assert.equal(during.reports, first.reports);
  assert.deepEqual(archive.query(query), before, 'queries keep serving the previous data');

  const after = await waitFor(archive, ['ready', 'error']);
  assert.equal(after.refreshing, false);
  assert.notEqual(after.generation, first.generation, 'the swapped-in data is a new generation');
  assert.equal(after.filesTotal, 2);
  assert.equal(after.filesCached, 1, 'unchanged hourly files come from the cache');
  assert(after.reports > first.reports);
});

/** Catches a failed or cancelled refresh that drops the archive already loaded. */
test('a failed or cancelled background refresh restores the previous data', async (t) => {
  const { root, write, options } = makeArchive(t);
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 2 * 3600000));
  const archive = new InterferenceArchive(options);
  archive.load({ root, days: 1 });
  const first = await waitFor(archive, ['ready', 'error']);

  archive.start(path.join(root, 'missing'), 1, true);
  await new Promise((resolve) => archive.on('status', function listener(status) {
    if (!status.refreshing) { archive.off('status', listener); resolve(); }
  }));
  let status = archive.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.samples, first.samples);
  assert.equal(status.generation, first.generation);
  assert.match(status.message, /Refresh failed/);
  assert.match(status.auto.lastError, /not reachable/);

  archive.start(root, 1, true);
  status = archive.cancel();
  assert.equal(status.state, 'ready');
  assert.equal(status.refreshing, false);
  assert.equal(status.samples, first.samples);
});

/** Catches a hung fs.access that never fails the load, or an auto tick that starts more NAS work behind it. */
test('NAS calls that hang time out, and automatic refresh waits for them to settle', async (t) => {
  const { root, options } = makeArchive(t, { fsTimeoutMs: 50 });
  fs.mkdirSync(root, { recursive: true });
  const original = fs.promises.access;
  let release;
  fs.promises.access = () => new Promise((resolve) => { release = resolve; });
  t.after(() => { fs.promises.access = original; });
  const archive = new InterferenceArchive(options);
  const started = Date.now();
  archive.load({ root, days: 1 });
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'error');
  assert.match(status.message, /not reachable.*did not respond/);
  assert(Date.now() - started < 2000);
  assert.equal(archive.hung, 1);
  assert.throws(() => archive.load({ root, days: 1 }), /outstanding request/);

  archive.settings.auto = true;
  const generation = archive.generation;
  archive.autoTick();
  assert.equal(archive.generation, generation, 'no new NAS work is started behind a hung call');
  assert.match(archive.status().auto.lastError, /not answered/);
  archive.stopAuto();

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive.hung, 0);
});

/** Catches a cancel that still lists the directory, or a retry that starts before the hung access settles. */
test('a cancelled directory request cannot start more NAS work or be retried until it settles', async (t) => {
  const { root, options } = makeArchive(t);
  let release;
  let listings = 0;
  t.mock.method(fs.promises, 'access', () => new Promise((resolve) => { release = resolve; }));
  t.mock.method(fs.promises, 'readdir', async () => { listings++; return []; });
  const archive = new InterferenceArchive(options);
  archive.load({ root, days: 1 });
  assert.equal(archive.cancel().state, 'cancelled');
  assert.throws(() => archive.load({ root, days: 1 }), /outstanding request/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive.pendingFs, 0);
  assert.equal(listings, 0);
  assert.equal(archive.status().state, 'cancelled');
});

/** Catches a stalled read that waits on destroy, or a late stream error that is left unhandled. */
test('a stalled NAS read times out even when destroy is waiting for Windows, and late errors are handled', async (t) => {
  const { root, write, options } = makeArchive(t, { stallTimeoutMs: 40, cacheDir: null });
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 2 * 3600000));
  const { Readable } = require('node:stream');
  let finishDestroy;
  const stream = new Readable({
    read() {},
    destroy(error, callback) { finishDestroy = callback; },
  });
  t.mock.method(fs, 'createReadStream', () => stream);
  t.after(() => { if (finishDestroy && !stream.closed) finishDestroy(); });
  const archive = new InterferenceArchive(options);
  archive.load({ root, days: 1 });
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'error');
  assert.match(status.message, /no data received/);
  assert.equal(stream.closed, false, 'the operating system still has not closed the handle');
  assert.equal(archive.hung, 1);
  assert.throws(() => archive.load({ root, days: 1 }), /outstanding request/);
  archive.settings.auto = true;
  const generation = archive.generation;
  archive.autoTick();
  archive.stopAuto();
  assert.equal(archive.generation, generation);
  const closed = once(stream, 'close');
  finishDestroy(Object.assign(new Error('NAS disconnected after timeout'), { code: 'EIO' }));
  await assert.rejects(closed, /NAS disconnected/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive.hung, 0);
});

/** Catches an EIO during listing or reading that discards the archive loaded before the refresh. */
test('network errors while listing or reading fail a refresh without discarding the previous archive', async (t) => {
  const { root, write, options } = makeArchive(t, { cacheDir: null });
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 2 * 3600000));
  const archive = new InterferenceArchive(options);
  archive.load({ root, days: 1 });
  const first = await waitFor(archive, ['ready', 'error']);
  assert.equal(first.state, 'ready');
  const query = { from: NOW - 86400000, to: NOW, buckets: 100 };
  const before = archive.query(query);
  const { Readable } = require('node:stream');
  for (const stage of ['listing', 'reading']) {
    const networkError = Object.assign(new Error('NAS connection lost'), { code: 'EIO' });
    const mock = stage === 'listing'
      ? t.mock.method(fs.promises, 'readdir', async () => { throw networkError; })
      : t.mock.method(fs, 'createReadStream', () => new Readable({
        read() { this.destroy(networkError); },
      }));
    archive.start(root, 1, true);
    const status = await waitFor(archive, ['ready', 'error']);
    assert.equal(status.state, 'ready');
    assert.equal(status.generation, first.generation);
    assert.match(status.auto.lastError, /NAS connection lost/);
    assert.deepEqual(archive.query(query), before);
    mock.mock.restore();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

/** Catches a readable stream that never emits data and leaves the load hanging. */
test('a read that stops delivering data is abandoned instead of hanging the load', async (t) => {
  const { root, write, options } = makeArchive(t, { stallTimeoutMs: 80, cacheDir: null });
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 2 * 3600000));
  const archive = new InterferenceArchive(options);
  const { Readable } = require('node:stream');
  const original = fs.createReadStream;
  fs.createReadStream = () => new Readable({ read() {} });
  t.after(() => { fs.createReadStream = original; });
  archive.load({ root, days: 1 });
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'error');
  assert.match(status.message, /no data received/);
});

/** Catches auto mode overlapping a load, forgetting the setting, or staying on after clear. */
test('automatic mode loads, never overlaps a running load, and is turned off by Unload', async (t) => {
  const { root, write, options } = makeArchive(t, { refreshMs: 3600000 });
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 2 * 3600000));
  const archive = new InterferenceArchive(options);
  assert.equal(archive.status().auto.enabled, false);
  archive.load({ root, days: 1 });
  await waitFor(archive, ['ready', 'error']);

  archive.setAuto(true);
  assert.equal(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')).auto, true);
  assert(Number.isFinite(archive.status().auto.nextRunAt));
  archive.stopAuto();
  archive.autoTick();
  assert.equal(archive.status().refreshing, true, 'automatic loads refresh in the background');
  assert(archive.autoTimer, 'the next refresh is scheduled');
  const generation = archive.generation;
  archive.autoTick();
  assert.equal(archive.generation, generation, 'a busy archive is not restarted');
  const status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  assert(Number.isFinite(status.auto.lastRunAt));
  assert.equal(new InterferenceArchive(options).settings.auto, true, 'the choice survives a restart');

  archive.clear();
  assert.equal(archive.status().auto.enabled, false);
  assert.equal(archive.status().auto.nextRunAt, null);
  assert.equal(archive.autoTimer, null);
});

/** Catches abbreviated BESTSATS or BESTPOS blocks that fail when split, or a short block that is accepted. */
test('abbreviated ASCII BESTSATS and BESTPOS (as logged on the NAS) are decoded across chunk boundaries', () => {
  const t = NOW - 3600000;
  const { week, ms } = gpsTime(t);
  /**
   * Abbreviated ASCII header for one log, using GPS week and seconds plus offset.
   * @param {string} name Log name.
   * @param {number} offset Milliseconds added to the header time.
   * @returns {string} Header line ending in CRLF.
   */
  const header = (name, offset) => `<${name} FILE 0 54.0 FINESTEERING ${week} ${((ms + offset) / 1000).toFixed(3)} 02000808 be05 18279\r\n`;
  /**
   * Abbreviated BESTSATS block: header, count, and one GPS row per status.
   * @param {number} offset Milliseconds added to the header time.
   * @param {string[]} statuses Status words.
   * @returns {string} Multi-line abbreviated block.
   */
  const bestsats = (offset, statuses) => header('BESTSATS', offset) + `<     ${statuses.length} \r\n`
    + statuses.map((status, index) => `<                    GPS ${index + 1} ${status} 00000003 \r\n`).join('');
  /**
   * Abbreviated BESTPOS block with a fixed NARROW_INT body.
   * @param {number} offset Milliseconds added to the header time.
   * @returns {string} Header plus one BESTPOS body line.
   */
  const bestpos = (offset) => header('BESTPOS', offset)
    + '<     SOL_COMPUTED NARROW_INT 51.1 -114.0 1064.6 -16.2 WGS84 0.01 0.01 0.02 "0" 1.000 0.000 31 27 27 20 00 21 3f 37\r\n';
  const log = Buffer.concat([
    Buffer.from(bestsats(0, ['GOOD', 'GOOD', 'NOEPHEMERIS', 'GOOD'])),
    binaryFrame(43, t + 500, Buffer.alloc(300, 0x3c)),
    Buffer.from(bestpos(1000)),
    asciiLine(t + 1500),
    Buffer.from('<RANGE FILE 0 54.0 FINESTEERING 1 1.000 0 0 0\r\n<     0\r\n'),
    Buffer.from(bestsats(2000, ['GOOD', 'GOOD'])),
  ]);
  for (const size of [log.length, 7, 64]) {
    const summary = new FileSummary();
    const scanner = createItDetectScanner(summary);
    for (let offset = 0; offset < log.length; offset += size) scanner.push(log.subarray(offset, offset + size));
    scanner.end();
    const json = summary.toJSON();
    assert.equal(json.bestsatsReports, 2, `chunk size ${size}`);
    assert.deepEqual(json.bestsats.map(({ t: start, used }) => ({ start: start - t, used })),
      [{ start: 0, used: 3 }, { start: 2000, used: 2 }], 'the final block is completed at end of file');
    assert.equal(json.solutionReports, 1);
    assert.equal(json.solution[0].used, 27);
    assert.equal(json.solution[0].type, 'NARROW_INT');
    assert.equal(json.reportCount, 1);
    assert.equal(json.crcErrors, 0);
  }

  const truncated = new FileSummary();
  const scanner = createItDetectScanner(truncated);
  scanner.push(Buffer.from(header('BESTSATS', 0) + '<     3 \r\n<   GPS 1 GOOD 00000003 \r\n'));
  scanner.end();
  assert.equal(truncated.toJSON().bestsatsReports, 0, 'a block with missing rows is rejected');
  assert.equal(truncated.toJSON().crcErrors, 1);
});

/** Catches a non-target length past EOF that consumes the ITDETECTSTATUS frame after it. */
test('a carried non-target length that overruns end of file does not swallow the tail', () => {
  const start = NOW - 3600000;
  const detection = binaryFrame(2065, start, itBody([{ rf: 5, center: 1176.45, bandwidth: 3, power: -90 }]));
  const liar = Buffer.alloc(28);
  liar.set([0xaa, 0x44, 0x12, 28]);
  liar.writeUInt16LE(43, 4);
  liar.writeUInt16LE(20000, 8);
  const log = Buffer.concat([liar, detection]);
  for (const size of [log.length, 7, 64]) {
    const summary = new FileSummary();
    const scanner = createItDetectScanner(summary);
    for (let offset = 0; offset < log.length; offset += size) scanner.push(log.subarray(offset, offset + size));
    scanner.end();
    const json = summary.toJSON();
    assert.equal(json.reportCount, 1, `chunk size ${size}`);
    assert.equal(json.samples.length, 1);
    assert.equal(json.samples[0].signal, 'L5');
  }
});

/** Catches a skip that trusts a non-target length when the following bytes are not a sync. */
test('a non-target frame whose length does not land on the next sync is not skipped over', () => {
  const start = NOW - 3600000;
  const detection = binaryFrame(2065, start, itBody([{ rf: 5, center: 1176.45, bandwidth: 3, power: -90 }]));
  const liar = Buffer.alloc(42, 0x11);
  liar.set([0xaa, 0x44, 0x12, 28]);
  liar.writeUInt16LE(43, 4);
  liar.writeUInt16LE(15, 8);
  const log = Buffer.concat([liar, detection]);
  for (const size of [log.length, 1, 7, 64]) {
    const summary = scan(log, size);
    assert.equal(summary.reportCount, 1, `chunk size ${size}`);
    assert.equal(summary.samples.length, 1);
    assert.equal(summary.samples[0].signal, 'L5');
  }
});

/** Catches a cache hit that keeps a null sample instead of rescanning the log. */
test('a cached summary with a null sample is discarded and the file is rescanned', async (t) => {
  const zlib = require('node:zlib');
  const { write, options } = makeArchive(t);
  write('293', 'X_2026-10-20_10-00-00.LOG', sampleLog(NOW - 3600000));
  const archive = new InterferenceArchive(options);
  archive.load({ days: 1 });
  let status = await waitFor(archive, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  const cacheFile = fs.readdirSync(options.cacheDir).find((name) => name.endsWith('.json.gz'));
  const cachePath = path.join(options.cacheDir, cacheFile);
  const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath)));
  parsed.solution.push(null);
  fs.writeFileSync(cachePath, zlib.gzipSync(JSON.stringify(parsed)));
  const again = new InterferenceArchive(options);
  again.load({ days: 1 });
  status = await waitFor(again, ['ready', 'error']);
  assert.equal(status.state, 'ready', status.message);
  assert.equal(status.filesCached, 0);
  assert.ok(status.errors.some((error) => /unusable/i.test(error)));
  assert.ok(status.reports > 0);
});

/** Catches a hung withTimeout that still blocks loads after hungResetMs. */
test('a network call that never settles stops blocking archive loads after hungResetMs', async () => {
  const archive = new InterferenceArchive({
    hungResetMs: 40, fsTimeoutMs: 20, cacheDir: null, settingsFile: null, defaultRoot: path.parse(process.cwd()).root,
  });
  let release;
  const hung = new Promise((resolve) => { release = resolve; });
  await assert.rejects(archive.withTimeout(hung, 'test share'), /did not respond/);
  assert.equal(archive.pendingFs, 1);
  assert.equal(archive.hung, 1);
  assert.throws(() => archive.assertAvailable(), /outstanding request/);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(archive.pendingFs, 0);
  assert.equal(archive.hung, 0);
  assert.doesNotThrow(() => archive.assertAvailable());
  assert.match(archive.autoState.lastError, /marked finished/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive.pendingFs, 0);
  assert.equal(archive.hung, 0);
});

/** Catches a stream marked finished while its handle is still open, so the next scan starts too early. */
test('a released hung read still blocks the next scan until the handle closes', async () => {
  const { EventEmitter } = require('node:events');
  const archive = new InterferenceArchive({
    hungResetMs: 30, fsTimeoutMs: 20, cacheDir: null, settingsFile: null,
    defaultRoot: path.parse(process.cwd()).root, refreshMs: 1000,
  });
  const stream = new EventEmitter();
  stream.closed = false;
  stream.destroy = () => {};
  archive.stream = stream;
  archive.stopStream();
  assert.equal(archive.stuckHandles, 1);
  assert.equal(archive.hung, 1);
  assert.throws(() => archive.assertAvailable(), /outstanding request/);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(archive.hung, 0);
  assert.equal(archive.stuckHandles, 1);
  assert.throws(() => archive.assertAvailable(), /outstanding request/);
  archive.settings.auto = true;
  archive.autoState.lastError = 'A network folder request stayed open and was marked finished so archive loading can continue';
  let started = 0;
  archive.start = () => { started += 1; };
  archive.autoTick();
  archive.stopAuto();
  assert.equal(started, 0);
  assert.match(archive.autoState.lastError, /marked finished/);
  stream.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive.stuckHandles, 0);
  assert.equal(archive.hung, 0);
  assert.doesNotThrow(() => archive.assertAvailable());
});

/** Catches a missing cache file that is not restored from its .bak copy. */
test('archive cache falls back to its backup when the cache file is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-bak-'));
  try {
    const archive = new InterferenceArchive({
      cacheDir: dir, settingsFile: null, defaultRoot: path.parse(dir).root,
    });
    const file = { path: path.join(dir, 'receiver.LOG'), size: 10, mtimeMs: 20 };
    const summary = {
      coverage: [], samples: [], solution: [], solutionReports: 0, solutionResolutionMs: 1000,
      bestsats: [], bestsatsReports: 0, bestsatsResolutionMs: 1000, marker: 1,
    };
    await archive.writeCache(file, summary);
    summary.marker = 2;
    await archive.writeCache(file, summary);
    const cachePath = archive.cachePath(file);
    assert.ok(fs.existsSync(`${cachePath}.bak`));
    fs.rmSync(cachePath);
    const restored = await archive.readCache(file);
    assert.equal(restored.marker, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

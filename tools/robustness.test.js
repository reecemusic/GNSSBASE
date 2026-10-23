/**
 * Locks in robustness of framing, CRC checks, history retention, and connection
 * handling: bad frames stay out of history, incomplete payloads are rejected,
 * and serial, TCP, and file saves fail closed.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { ReceiverClient } = require('../src/receiver');
const { History, MAX_TRACKS, replaceFileSync } = require('../src/history');
const { parseAsciiLog, readBinaryLog, novatelCrc32, decodeItDetectStatusBinary, scaleFrequencyHz, interpretItDetectStatus, saneTimestamp } = require('../src/novatel');
const { decode } = require('../src/messages');
const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/**
 * Evaluates a slice of public/app.js inside a vm context.
 * @param {object} context vm context that receives the slice.
 * @param {string} start First source substring. The slice begins at this match.
 * @param {string} end Source substring that ends the slice, exclusive.
 * @returns {void}
 */
function load(context, start, end) {
  const first = code.indexOf(start);
  const last = code.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing source boundary: ${start}`);
  vm.runInContext(code.slice(first, last), context);
}

/** Catches a parser that treats a missing checksum as valid or a garbled CRC as unchecked. */
test('malformed CRC text is a failure, not an unchecked report', () => {
  const body = 'BESTSATSA,USB1,0,50,FINESTEERING,2441,100,00000000,0000;0';
  const checksum = novatelCrc32(body).toString(16).padStart(8, '0');
  assert.equal(parseAsciiLog(`#${body}*${checksum}`).crcValid, true);
  assert.equal(parseAsciiLog(`#${body}`).crcValid, null);
  for (const malformed of ['', 'garbage', checksum + 'garbage', '0' + checksum, checksum.slice(1)]) {
    assert.equal(parseAsciiLog(`#${body}*${malformed}`).crcValid, false);
  }
});

/** Catches decoders that invent observation or detection counts from a short or blank payload. */
test('RANGE, SATVIS2 and interference decoders reject incomplete payloads instead of inventing counts', () => {
  /**
   * Decodes one ASCII log through the shared message decoder.
   * @param {string} name Message name, such as RANGE or SATVIS2.
   * @param {string[]} fields ASCII field list.
   * @returns {object} Decoded message.
   */
  const ascii = (name, fields) => decode({ format: 'ascii', header: { messageName: name }, fields });
  for (const fields of [[], [''], ['-1'], ['1.5'], ['2049'], ['1', ...Array(9).fill('0')]]) {
    assert.throws(() => ascii('RANGE', fields), /RANGE/);
  }
  assert.equal(ascii('RANGE', ['0']).data.observations.length, 0);
  for (const fields of [
    ['GPS', 'TRUE', 'TRUE', '1', '1', '0', '20', '30'],
    ['GPS', 'UNKNOWN', 'TRUE', '0'], ['GPS', 'TRUE', 'TRUE', ''],
  ]) assert.throws(() => ascii('SATVIS2', fields), /SATVIS2/);
  const sat = ascii('SATVIS2', ['GPS', 'TRUE', 'TRUE', '1', '1', '0', '', '30', '0', '0']);
  assert.equal(sat.data.satellites[0].elevation, null, 'blank elevation is unknown, not the horizon');
  assert.equal(ascii('BESTPOS', ['SOL_COMPUTED', 'SINGLE', '', '']).data.latitude, null);
  for (const fields of [[], [''], ['-1'], ['1'], ['2', 'L1', 'SPECTRUMANALYSIS'], ['L1', '1']]) {
    assert.throws(() => ascii('ITDETECTSTATUS', fields), /ITDETECTSTATUS/);
  }
  assert.equal(ascii('ITDETECTSTATUS', ['0']).data.detectionCount, 0);
  assert.equal(ascii('ITDETECTSTATUS', ['L1', '0']).data.detectionCount, 0);
  const truncated = Buffer.alloc(4);
  truncated.writeUInt32LE(1);
  assert.throws(() => decodeItDetectStatusBinary(Buffer.alloc(3)), /incomplete/);
  assert.throws(() => decodeItDetectStatusBinary(truncated), /incomplete/);
  assert.throws(() => decode({ format: 'binary', header: { messageName: 'RANGE' }, body: truncated }), /incomplete/);
});

/** Catches history that records a CRC-failed or visibility-invalid report, or that drops the next valid clear. */
test('CRC failures and invalid visibility never enter server or browser history', () => {
  const records = [
    { name: 'ITDETECTSTATUS', crcValid: false, data: { detections: [] } },
    { name: 'BESTPOS', crcValid: false, data: { satellitesUsed: 0 } },
    { name: 'SATVIS2', crcValid: false, data: { system: 'GPS', satellites: [{ prn: 1, elevation: 20, azimuth: 30 }] } },
    { name: 'SATVIS2', crcValid: true, data: { system: 'GPS', visibilityValid: false,
      satellites: [{ prn: 1, elevation: 20, azimuth: 30 }] } },
    { name: 'ITDETECTSTATUS', crcValid: null, data: { detections: [{ signalType: 'L1', powerDbm: -80 }] } },
    { name: 'BESTPOS', data: { satellitesUsed: 8 } },
  ];
  const calls = [];
  const browser = vm.createContext({
    MAX_INTERFERENCE_SAMPLES: 40000,
    state: { tracks: {}, interferenceHistory: [] },
    recordSolution: () => calls.push('solution'),
  });
  load(browser, 'function recordLiveHistory(', '// Unchanged solutions');
  records.forEach((record) => browser.recordLiveHistory(record));
  assert.deepEqual(calls, []);
  assert.equal(browser.state.interferenceHistory.length, 0);
  assert.equal(Object.keys(browser.state.tracks).length, 0);
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const context = vm.createContext({
    decode: (record) => record, store: { latest: {}, counts: {}, itdetectHistory: [], satvisBySystem: {}, rawLog: [] },
    config: { historySize: 50, rawLogSize: 200 },
    history: { addSolution: () => calls.push('solution'), addSatellites: () => calls.push('sky'),
      addInterference: () => calls.push('interference') },
    broadcast() {}, console: { warn() {} }, saneTimestamp,
  });
  vm.runInContext(serverCode.slice(serverCode.indexOf('function processReceiverLog('),
    serverCode.indexOf('function broadcast(')), context);
  records.forEach((record) => context.processReceiverLog(record));
  assert.deepEqual(calls, []);
  assert.equal(context.store.rawLog.length, 6, 'bad reports remain available for diagnosis');
  context.processReceiverLog({ name: 'ITDETECTSTATUS', crcValid: true, data: { detections: [] } });
  assert.deepEqual(calls, ['interference'], 'the next valid clear report is retained');
});

/**
 * Catches a banner that ignores a 5 s stall, disconnect grace, or a CRC failure.
 * Also catches a device summary that drops GLONASS or mislabels RESERVED tracking.
 */
test('interference banner ages clear reports, errors after five seconds, and recovers on fresh data', () => {
  const elements = new Map();
  let now = 100000;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    INTERFERENCE_STALE_MS: 5000, liveStatusStartedAt: now,
    connection: { status: { connected: true }, offline: false },
    latestByName: {}, state: { counts: {}, lastDetection: null, testSatellites: [], satelliteViewHistory: [] },
    BANDS: [{ id: 'L1' }, { id: 'L2' }],
    SIGNAL_BANDS: ['L1', 'L2', 'L5'],
    classifyBand: (signal) => signal,
    detectionBands: (signal) => [signal],
    buildSatelliteList: () => context.state.testSatellites,
    signalBand: (_system, status) => status,
    normalisePrn: (_system, prn) => prn,
    formatFrequency: (hz) => `${hz / 1e6} MHz`,
    timeAgo: () => '0s ago',
    formatTimestamp: () => '12:00:00 GMT+4',
    detectionTypeLabel: (type) => `label:${type}`,
    dateFormatter: (options) => ({ format: () => (options.second ? 'CLOCK' : 'DATE') }),
    constellationColor: () => '#fff',
    cell: (row, text, className) => row.insertCell(text, className),
    document: {
      createElement: () => ({ style: {} }),
      createTextNode: (text) => ({ text }),
    },
    $: (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          classList: { toggle() {} },
          rows: [],
          replaceChildren() { this.rows = []; },
          /** @returns {object} A fake row whose insertCell records the cell. Side effects: pushes onto this.rows. Events: none. */
          insertRow() {
            const row = { cells: [], insertCell(text, className) {
              const td = { text, className, append() {} };
              this.cells.push(td);
              return td;
            } };
            this.rows.push(row);
            return row;
          },
        });
      }
      return elements.get(id);
    },
  });
  load(context, 'function interferenceIsLive(', 'function renderCounts(');
  context.renderSatelliteViewPlot = () => {};
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner idle');
  assert.equal(elements.get('it-clock').textContent, 'CLOCK');
  assert.equal(elements.get('it-clock-date').textContent, 'DATE');
  assert.equal(elements.get('it-last-detection').textContent, 'None yet');
  now += 5001;
  context.renderVerdict();
  assert.equal(elements.get('it-verdict').textContent, 'Device status unavailable');
  context.latestByName.ITDETECTSTATUS = {
    crcValid: true, receivedAt: new Date(now).toISOString(), data: { detections: [] },
  };
  context.state.counts.ITDETECTSTATUS = 42;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner clear');
  assert.match(elements.get('it-freshness').textContent, /^Receiving Data.*42 status messages$/);
  now += 5000;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner device-error', '5 seconds without a report is stale');
  assert.match(elements.get('it-freshness').textContent, /Device connection lost.*Last message 5 s ago/);
  assert.match(elements.get('it-detail').textContent, /Interference status is unknown/);

  context.latestByName.ITDETECTSTATUS.receivedAt = new Date(now).toISOString();
  context.state.counts.ITDETECTSTATUS++;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner clear');
  assert.match(elements.get('it-freshness').textContent, /^Receiving Data.*43 status messages$/);
  context.connection.status.connected = false;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner clear', 'device disconnect gets a 5-second grace period');
  assert.match(elements.get('it-freshness').textContent, /^Receiving Data/);
  now += 4999;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner clear');
  now += 1;
  context.renderVerdict();
  assert.equal(elements.get('it-verdict').textContent, 'Device disconnected');
  context.connection.status.connected = true;
  context.latestByName.ITDETECTSTATUS.receivedAt = new Date(now).toISOString();
  context.renderVerdict();
  context.connection.offline = true;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner clear', 'server disconnect gets a 5-second grace period');
  now += 4999;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner clear');
  now += 1;
  context.renderVerdict();
  assert.equal(elements.get('it-verdict').textContent, 'Live server connection lost');
  context.connection.offline = false;
  context.latestByName.ITDETECTSTATUS.receivedAt = new Date(now).toISOString();
  context.latestByName.ITDETECTSTATUS.data.detections = [{ signalType: 'L2' }];
  context.renderVerdict();
  assert.equal(elements.get('it-verdict').textContent, 'Jamming detected on L2');
  context.rememberLastDetection({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: new Date(now).toISOString(),
    data: { detections: [{
      signalType: 'GPSL2', powerDbm: -83.5, bandwidthHz: 2000000, centerFrequencyHz: 1575420000,
    }] },
  });
  context.renderVerdict();
  assert.match(elements.get('it-last-detection').textContent, /GPSL2.*-83\.5 dBm.*2 MHz BW.*Centre frequency 1575\.42 MHz/);
  context.state.testSatellites = [
    { system: 'GPS', prn: '1', inView: true }, { system: 'GPS', prn: '2', inView: true },
    { system: 'GALILEO', prn: '5', inView: true },
  ];
  assert.equal(elements.get('it-last-detection-detail').textContent, '12:00:00 GMT+4 · 0s ago');
  context.state.lastDetection = { at: now, detection: { signalType: 'L2', type: 'STATISTICANALYSIS' } };
  assert.equal(context.lastDetectionSummary(context.state.lastDetection),
    'L2 (label:STATISTICANALYSIS) · power and frequency not reported by this detector');
  /**
   * Packs a tracking-status code into the hex field RANGE observations use.
   * @param {number} code Status code shifted into the tracking-status word.
   * @returns {string} Hex status word.
   */
  const status = (code) => (code << 21).toString(16);
  context.latestByName.RANGE = { data: { observations: [
    { system: 'GPS', prn: 1, trackingStatus: status(0) },
    { system: 'GPS', prn: 1, trackingStatus: status(17) },
    { system: 'GPS', prn: 2, trackingStatus: status(14) },
    { system: 'GPS', prn: 2, trackingStatus: status(0) },
    { system: 'GALILEO', prn: 5, trackingStatus: status(12) },
    { system: 'RESERVED', prn: 3, trackingStatus: status(0) },
  ] } };
  context.renderDeviceSummary();
  const rows = elements.get('satellite-signal-rows').rows.map((row) => row.cells.slice(1).map((td) => td.text));
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    ['2 / 2', 'L1C/A 2 · L2C 1 · L5 1'],
    ['0 / 0', 'Not reported by receiver'],
    ['1 / 1', 'E5a 1'],
    ['0 / 0', 'Not reported by receiver'],
    ['0 / 0', 'Not reported by receiver'],
    ['1 / 0', 'L5 1'],
  ], 'GLONASS is always listed and RESERVED tracking is NavIC');
  assert.equal(elements.get('satellite-total-counts').textContent, '4 / 3');
  assert.equal(elements.get('satellite-view-total').textContent, '4 tracked · 3 in view · 6 signals');
  now += 5000;
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner device-error', 'stale detections are not live either');
  context.latestByName.ITDETECTSTATUS.crcValid = false;
  context.latestByName.ITDETECTSTATUS.receivedAt = new Date(now - 5000).toISOString();
  context.renderVerdict();
  assert.equal(elements.get('it-banner').className, 'banner device-error', 'a CRC failure cannot restore live status');
});

/**
 * Builds a vm context with stubbed DOM helpers and loads the skyplot slices.
 * @returns {object} Context exposing skyplot helpers and the captured element map.
 */
function satelliteContext() {
  const elements = new Map();
  const context = vm.createContext({
    latestByName: {},
    state: { satvis: {}, hiddenSystems: new Set(), showTraces: false },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, {
        textContent: '', hidden: false, children: [],
        classList: { toggle() {} },
        replaceChildren() { this.children = []; },
        append(child) { this.children.push(child); },
      });
      return elements.get(id);
    },
    SKY: { cx: 210, cy: 210, r: 180 },
    skyPosition: () => ({ x: 0, y: 0 }),
    svg: () => ({}),
    buildSatMarker: (sat) => sat,
    renderSkyLegend: (counts) => { context.legendCounts = counts; },
    renderSignalLegend() {},
    signalBreakdown: () => ({}),
    renderSatelliteTable: (sats) => { context.tableSatellites = sats; },
  });
  load(context, 'function isValidSkyPosition(', 'function svg(');
  load(context, 'function buildSatelliteList(', 'function renderSkyLegend(');
  load(context, 'const SATELLITE_SYSTEMS =', 'function sumCounts(');
  load(context, 'function renderSkyplot(', '/** Past positions');
  context.elements = elements;
  return context;
}

/** Catches QZSS totals that drop a used satellite, double-count a signal, or follow the skyplot hide filter. */
test('QZSS tracked totals include used satellites, deduplicate signals and ignore skyplot filters', () => {
  const context = satelliteContext();
  context.state.satvis.QZSS = { data: { visibilityValid: true, satellites: [
    ...[193, 194, 195, 196].map((prn) => ({ prn, elevation: 20, azimuth: 30 })),
    { prn: 193, elevation: 20, azimuth: 30 },
    { prn: 197, elevation: -5, azimuth: 30 },
    { prn: 198, elevation: null, azimuth: 30 },
  ] } };
  context.latestByName.RANGE = { data: { observations: [
    { system: 'QZSS', prn: 193, trackingStatus: '0' },
    { system: 'QZSS', prn: 193, trackingStatus: (17 << 21).toString(16) },
    { system: 'QZSS', prn: 194, trackingStatus: '0' },
  ] } };
  context.latestByName.BESTSATS = { data: { satellites: [
    { system: 'QZSS', prn: 193, status: 'GOOD' },
    { system: 'QZSS', prn: 194, status: 'GOOD' },
  ] } };
  context.renderSkyplot();
  assert.equal(context.trackedSatelliteSummary().get('QZSS').prns.size, 2);
  assert.equal(context.satellitesInViewBySystem().QZSS, 4);
  assert.equal(context.elements.get('sv-tracked').textContent, 2);
  assert.equal(context.elements.get('sv-used').textContent, 2);
  assert.equal(context.legendCounts.QZSS.tracked, 2);
  assert.equal(context.legendCounts.QZSS.visible, 4);
  context.state.hiddenSystems.add('QZSS');
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-tracked').textContent, 2);
  assert.equal(context.elements.get('sv-used').textContent, 2);
  assert.equal(context.elements.get('sky-count').textContent, '(0 plotted)');
  assert.equal(context.satellitesInViewBySystem().QZSS, 4);
});

/** Catches tracking counts that follow BESTSATS exclusions or invent visibility when sky geometry is missing. */
test('tracking remains independent of BESTSATS exclusions and missing sky geometry', () => {
  const context = satelliteContext();
  context.latestByName.RANGE = { data: { observations: [
    { system: 'GLONASS', prn: 55, trackingStatus: '0' },
    { system: 'RESERVED', prn: 3, trackingStatus: '0' },
    { system: 'GPS', prn: 2, trackingStatus: '0' },
  ] } };
  context.latestByName.BESTSATS = { data: { satellites: [
    { system: 'GLONASS', prn: '18-3', status: 'GOOD' },
    { system: 'NAVIC', prn: 3, status: 'BADHEALTH' },
    { system: 'GPS', prn: 2, status: 'NOEPHEMERIS' },
    { system: 'GPS', prn: 4, status: 'NOTUSED' },
  ] } };
  context.latestByName.TRACKSTAT = { data: { observations: [] } };
  context.renderSkyplot();
  const sats = context.buildSatelliteList();
  assert.equal(sats.length, 4, 'GLONASS frequency suffix and RANGE slot offset match one satellite');
  assert.equal(sats.find((sat) => sat.system === 'GLONASS').prn, '18');
  assert.equal(sats.find((sat) => sat.system === 'NAVIC').tracked, true);
  assert.equal(sats.find((sat) => sat.prn === '4').tracked, false, 'BESTSATS alone is not tracking evidence');
  assert.equal(context.elements.get('sv-tracked').textContent, 3);
  assert.equal(context.elements.get('sv-used').textContent, 1);
  assert.equal(context.elements.get('sv-missing').textContent, 0, 'a RANGE observation is not missing despite solution exclusion');
  assert.equal(context.elements.get('sv-unhealthy').textContent, 1);
  assert.equal(context.elements.get('sky-fallback').hidden, false);
  assert.deepEqual(Object.keys(context.satellitesInViewBySystem()), [], 'RANGE and BESTSATS do not invent visibility');
  for (const [system, entry] of context.trackedSatelliteSummary()) {
    assert.equal(sats.filter((sat) => sat.system === system && sat.tracked).length, entry.prns.size);
  }
  context.latestByName = {};
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-tracked').textContent, 0);
  for (const id of ['sv-used', 'sv-missing', 'sv-unhealthy']) {
    assert.equal(context.elements.get(id).textContent, '\u2014', 'missing reports are unknown, not zero');
  }
  assert.equal(context.tableSatellites.length, 0, 'empty data clears the status table');
});

/** Catches counts that keep an invalid PRN, visibility-invalid SATVIS2, or CRC-failed RANGE and BESTSATS. */
test('satellite counts reject invalid IDs, invalid visibility and CRC failures', () => {
  const context = satelliteContext();
  const invalid = [null, undefined, '', ' ', 0, -1, NaN, Infinity, 'abc', '2x', 1.5];
  const observations = invalid.map((prn) => ({ system: 'GPS', prn, trackingStatus: '0' }));
  observations.push({ system: 'GPS', prn: 1, trackingStatus: '0' },
    { system: 'GPS', prn: '01', trackingStatus: '0' },
    { system: 'OTHER', prn: 3, trackingStatus: '0' });
  context.latestByName.RANGE = { data: { observations } };
  context.state.satvis.GPS = { data: { visibilityValid: false,
    satellites: [{ prn: 1, elevation: 20, azimuth: 30 }] } };
  context.state.satvis.QZSS = { crcValid: false, data: {
    satellites: [{ prn: 193, elevation: 20, azimuth: 30 }] } };
  context.latestByName.BESTSATS = { crcValid: false, data: {
    satellites: [{ system: 'GPS', prn: 2, status: 'GOOD' }] } };
  assert.equal(context.buildSatelliteList().length, 1);
  assert.equal(context.trackedSatelliteSummary().get('GPS').prns.size, 1);
  assert.deepEqual(Object.keys(context.satellitesInViewBySystem()), []);
  context.latestByName.RANGE.crcValid = false;
  assert.equal(context.buildSatelliteList().length, 0);
  assert.equal(context.trackedSatelliteSummary().size, 0);
  context.latestByName.RANGE = { data: { observations: [] } };
  assert.equal(context.trackedSatelliteSummary().size, 0);
});

/** Catches a band breakdown that counts every tracked signal, or that still counts after a BESTSATS CRC failure. */
test('used-signal counts use BESTSATS masks rather than every tracked band', () => {
  const context = satelliteContext();
  context.SIGNAL_BANDS = ['L1', 'L2', 'L5', 'Other'];
  load(context, 'function signalBreakdown(', 'function renderSignalLegend(');
  load(context, 'function signalBand(', 'function renderSatelliteTable(');
  const observations = [
    ['GPS', 1, 17], ['QZSS', 193, 17], ['QZSS', 193, 0], ['QZSS', 193, 0],
    ['QZSS', 194, 24], ['SBAS', 131, 6], ['BEIDOU', 3, 7], ['BEIDOU', 4, 9],
    ['RESERVED', 5, 0], ['GLONASS', 55, 1],
  ].map(([system, prn, signal]) => ({ system, prn, trackingStatus: (signal << 21).toString(16) }));
  context.latestByName.RANGE = { data: { observations } };
  context.latestByName.BESTSATS = { data: { satellites: [
    { system: 'GPS', prn: 1, signalMask: '03' },
    { system: 'QZSS', prn: 193, signalMask: '02' },
    { system: 'QZSS', prn: 194, signalMask: '01' },
    { system: 'SBAS', prn: 131, signalMask: '02' },
    { system: 'BEIDOU', prn: 3, signalMask: '08' },
    { system: 'BEIDOU', prn: 4, signalMask: '10' },
    { system: 'NAVIC', prn: 5, signalMask: '04' },
    { system: 'GLONASS', prn: '18-3', signalMask: '02' },
  ] } };
  const used = observations.map((obs) => ({
    system: context.observationSystem(obs), prn: context.normalisePrn(obs.system, obs.prn), state: 'used',
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(context.signalBreakdown(used))),
    { L1: 3, L2: 3, L5: 3, Other: 0 });
  context.latestByName.BESTSATS.crcValid = false;
  assert.deepEqual(JSON.parse(JSON.stringify(context.signalBreakdown(used))),
    { L1: 0, L2: 0, L5: 0, Other: 0 });
});

/** Catches a BESTSATS decoder that accepts a short block, keeps duplicate IDs, or ignores a conflicting status or mask. */
test('BESTSATSA validates exact block sizes, deduplicates IDs and rejects conflicting counts explicitly', () => {
  /**
   * Decodes one BESTSATS ASCII field list.
   * @param {string[]} fields BESTSATS fields, including the leading count.
   * @returns {object} Decoded BESTSATS data.
   */
  const decodeFields = (fields) => decode({
    format: 'ascii', header: { messageName: 'BESTSATS' }, fields, crcValid: true,
  }).data;
  assert.equal(decodeFields(['0']).satellites.length, 0);
  for (const fields of [
    [], [''], ['-1'], ['1.5'], ['2049'], ['0', 'GPS'],
    ['1', 'GPS', '1', 'GOOD'], ['2', 'GPS', '1', 'GOOD', '03'],
    ['1', 'GPS', '0', 'GOOD', '03'], ['1', 'GPS', '2x', 'GOOD', '03'],
    ['1', 'GPS', '1', 'GOOD', 'invalid'], ['1', 'OTHER', '1', 'GOOD', '03'],
    ['1', 'GPS', '1', '', '03'],
  ]) assert.throws(() => decodeFields(fields), /BESTSATS/);
  const duplicate = decodeFields(['2', 'GLONASS', '18-3', 'GOOD', '00000003',
    'GLONASS', '018-3', 'GOOD', '03']);
  assert.equal(duplicate.satellites.length, 1);
  assert.equal(duplicate.satelliteCount, 1);
  for (const [status, mask] of [['NOTUSED', '03'], ['GOOD', '01']]) {
    assert.throws(() => decodeFields(['2', 'GPS', '1', 'GOOD', '03', 'GPS', '01', status, mask]),
      /conflicting duplicate/);
  }
  assert.equal(decodeFields(['1', 'GPS', '1', 'FUTURE_STATUS', '03']).satellites[0].status, 'FUTURE_STATUS');
});

/** Catches a used count padded to match BESTPOS, or a stale or same-epoch mismatch that is hidden. */
test('BESTSATS freshness and same-epoch disagreement are visible without altering receiver counts', () => {
  const context = satelliteContext();
  const now = 100000;
  let clock = now;
  context.Date = class extends Date { static now() { return clock; } };
  const utc = new Date(now).toISOString();
  context.latestByName.BESTSATS = {
    receivedAt: new Date(now - 6000).toISOString(), header: { utc },
    data: { satellites: [{ system: 'GPS', prn: 1, status: 'GOOD', signalMask: '01' }] },
  };
  context.latestByName.BESTPOS = { header: { utc }, data: { satellitesUsed: 2 } };
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-used').textContent, 1, 'do not fabricate identities to match BESTPOS');
  assert.match(context.elements.get('sv-warnings').textContent, /old.*not live/);
  assert.match(context.elements.get('sv-warnings').textContent, /same-epoch BESTPOS reports 2/i);
  assert.doesNotMatch(context.elements.get('sv-status-note').textContent, /WARNING|s old/);
  context.latestByName.BESTPOS.header.utc = new Date(now - 1000).toISOString();
  context.latestByName.BESTSATS.receivedAt = utc;
  context.renderSkyplot();
  assert.doesNotMatch(context.elements.get('sv-warnings').textContent, /old|BESTPOS reports/);
  clock = now + 4999;
  context.renderSkyplot();
  assert.doesNotMatch(context.elements.get('sv-warnings').textContent, /s old/);
  clock = now + 5000;
  context.renderSkyplot();
  assert.match(context.elements.get('sv-warnings').textContent, /5 s old/);
});

/** Catches a split BESTSATSA frame that is emitted early or that drops the valid frame after it. */
test('fragmented and malformed BESTSATSA frames do not corrupt the next valid satellite report', () => {
  const receiver = new ReceiverClient({});
  const records = [];
  receiver.on('log', (message) => records.push(decode(message)));
  const invalid = '%BESTSATSA,2441,100;2,GPS,1,GOOD,01\n';
  const valid = '%BESTSATSA,2441,101;1,QZSS,194,GOOD,03\n';
  receiver.ingest(Buffer.from(invalid + valid.slice(0, 20)));
  assert.equal(records.length, 0);
  assert.match(receiver.state.lastError, /BESTSATS.*incomplete/);
  receiver.ingest(Buffer.from(valid.slice(20)));
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'BESTSATS');
  assert.equal(records[0].data.satellites[0].prn, '194');
  assert.equal(receiver.buffer.length, 0);
});

/** Catches mask totals that count an unselected or repeated band, or that ignore a hidden constellation. */
test('BESTSATS mask counts include only selected solution bands and deduplicate multi-signal bands', () => {
  const context = satelliteContext();
  context.SIGNAL_BANDS = ['L1', 'L2', 'L5', 'Other'];
  load(context, 'function signalBreakdown(', 'function renderSignalLegend(');
  const satellites = [
    { system: 'GPS', prn: '1', state: 'used', signalMask: '01' },
    { system: 'GALILEO', prn: '2', state: 'used', signalMask: '0f' },
    { system: 'BEIDOU', prn: '3', state: 'used', signalMask: '15' },
    { system: 'QZSS', prn: '194', state: 'used', signalMask: '00' },
    { system: 'NAVIC', prn: '5', state: 'tracked', signalMask: '04' },
  ];
  context.latestByName.BESTSATS = { data: { satellites } };
  /**
   * Reads the current signal-band breakdown as plain JSON.
   * @returns {object} Counts keyed by band.
   */
  const counts = () => JSON.parse(JSON.stringify(context.signalBreakdown(satellites)));
  assert.deepEqual(counts(), { L1: 3, L2: 0, L5: 2, Other: 1 });
  context.state.hiddenSystems.add('GALILEO');
  assert.deepEqual(counts(), { L1: 2, L2: 0, L5: 1, Other: 1 });
});

/** Catches a missing BESTSATS report that labels satellites not used, or a CRC-failed BESTPOS used as the count. */
test('missing BESTSATS displays BESTPOS total without inventing per-satellite solution status', () => {
  const context = satelliteContext();
  context.latestByName.BESTPOS = { data: { satellitesUsed: 21, satellitesTracked: 29 } };
  context.latestByName.RANGE = { data: { observations: [
    { system: 'GPS', prn: 26, trackingStatus: '0' },
  ] } };
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-used').textContent, 21);
  assert.equal(context.elements.get('sv-tracked').textContent, 1, 'tracking is derived from RANGE, not BESTPOS');
  assert.equal(context.elements.get('sv-missing').textContent, '\u2014');
  assert.equal(context.elements.get('sv-unhealthy').textContent, '\u2014');
  assert.match(context.elements.get('sv-status-note').textContent, /unavailable.*BESTSATS/);
  assert.equal(context.buildSatelliteList()[0].state, 'unknown', 'unknown usage is not labelled not used');
  context.latestByName.BESTSATS = { format: 'binary', data: null };
  assert.equal(context.satelliteUsageAvailable(), false);
  context.latestByName.BESTSATS = { crcValid: false, data: { satellites: [] } };
  assert.equal(context.satelliteUsageAvailable(), false);
  context.latestByName.BESTPOS.crcValid = false;
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-used').textContent, '\u2014', 'CRC-failed BESTPOS cannot supply a used count');
  context.latestByName.BESTSATS = { data: { satellites: [] } };
  context.latestByName.TRACKSTAT = { data: { observations: [] } };
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-used').textContent, 0, 'a valid empty report is genuinely zero');
  assert.equal(context.elements.get('sv-missing').textContent, 0);
});

/** Catches per-constellation used, not-used, and missing totals that drift from the reference mix. */
test('manufacturer reference counts match per-constellation used, not-used and missing states', () => {
  const context = satelliteContext();
  const reference = {
    GPS: { used: 10, notUsed: 0, missing: 0 },
    GALILEO: { used: 6, notUsed: 2, missing: 0 },
    BEIDOU: { used: 4, notUsed: 5, missing: 1 },
    QZSS: { used: 1, notUsed: 1, missing: 1 },
    NAVIC: { used: 0, notUsed: 0, missing: 2 },
    SBAS: { used: 0, notUsed: 0, missing: 0 },
  };
  const satellites = [];
  const observations = [];
  for (const [system, counts] of Object.entries(reference)) {
    const geometry = [];
    let prn = system === 'QZSS' ? 194 : 1;
    for (const [kind, count] of Object.entries(counts)) {
      for (let index = 0; index < count; index++, prn++) {
        satellites.push({ system, prn, status: kind === 'used' ? 'GOOD' : kind === 'missing' ? 'NA' : 'NOTUSED' });
        geometry.push({ prn, elevation: 20, azimuth: 30 });
        if (kind !== 'missing') observations.push({ system, prn, trackingStatus: '0' });
      }
    }
    context.state.satvis[system] = { data: { visibilityValid: true, satellites: geometry } };
  }
  context.latestByName.RANGE = { data: { observations } };
  context.latestByName.BESTSATS = { data: { satellites } };
  context.latestByName.TRACKSTAT = { data: { cutoff: 5, observations: satellites.map((sat) => ({
    system: sat.system, prn: sat.prn, trackingStatus: '1',
  })) } };
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-used').textContent, 21);
  assert.equal(context.elements.get('sv-tracked').textContent, 29);
  assert.equal(context.elements.get('sv-missing').textContent, 4);
  assert.equal(context.elements.get('sky-count').textContent, '(33 plotted)');
  for (const [system, counts] of Object.entries(reference)) {
    const actual = context.legendCounts[system];
    if (!actual) {
      assert.equal(counts.used + counts.notUsed + counts.missing, 0);
      continue;
    }
    assert.equal(actual.used, counts.used, `${system} used`);
    assert.equal(actual.notUsed, counts.notUsed, `${system} not used`);
    assert.equal(actual.missing, counts.missing, `${system} missing`);
    assert.equal(actual.tracked, counts.used + counts.notUsed, `${system} tracked`);
  }
});

/** Catches a connect that skips or repeats BESTSATS, leaves ITDETECTSTATUS ONCHANGED, sends RANGE while logging is off, or writes UNLOGALL. */
test('serial and configured logging both explicitly request BESTSATS once per connection', () => {
  for (const sendLogCommands of [false, true]) {
    const writes = [];
    const receiver = new ReceiverClient({
      transport: 'serial', sendLogCommands,
      logCommands: ['LOG BESTSATSA ONTIME 1', 'LOG TRACKSTATA ONTIME 1', 'LOG ITDETECTSTATUSA ONCHANGED', 'LOG RANGEA ONTIME 5'],
    });
    receiver.sendConfiguredCommands({ write: (command) => writes.push(command) });
    assert.equal(writes.filter((command) => command === 'LOG BESTSATSA ONTIME 1\r\n').length, 1);
    assert.equal(writes.filter((command) => command.startsWith('LOG TRACKSTAT')).length, 1);
    assert.equal(writes.filter((command) => command === 'LOG ITDETECTSTATUSA ONTIME 1\r\n').length, 1);
    assert.equal(writes.includes('LOG RANGEA ONTIME 5\r\n'), sendLogCommands);
    assert(!writes.some((command) => command.includes('UNLOGALL')));
  }
});

/** Catches TRACKSTAT rows that count idle channels, treat below-cutoff channels as missing, or accept a short channel block. */
test('TRACKSTAT decodes assigned channels and counts unobserved satellites without counting idle channels', () => {
  const fields = ['SOL_COMPUTED', 'SINGLE', '5', '5'];
  /**
   * Builds one TRACKSTAT channel field group.
   * @param {number} prn Satellite PRN or slot.
   * @param {number} system Receiver system code.
   * @param {number} state Channel state word.
   * @returns {string[]} Ten ASCII channel fields.
   */
  const channel = (prn, system, state) => [
    String(prn), '0', ((system << 16) | state).toString(16), '0', '0', '0', '0', '0', 'NA', '0',
  ];
  fields.push(...channel(9, 6, 1), ...channel(9, 6, 1), ...channel(0, 0, 0),
    ...channel(10, 1, 0), ...channel(44, 4, 1));
  const record = decode({ format: 'ascii', header: { messageName: 'TRACKSTAT' }, fields, crcValid: true });
  assert.equal(record.data.observationCount, 5);
  assert.equal(record.data.observations[0].system, 'NAVIC');
  const context = satelliteContext();
  context.latestByName.TRACKSTAT = record;
  context.state.satvis.NAVIC = { data: { visibilityValid: true,
    satellites: [{ prn: 9, elevation: 20, azimuth: 30 }] } };
  context.state.satvis.BEIDOU = { data: { visibilityValid: true,
    satellites: [{ prn: 44, elevation: 20, azimuth: 30 }] } };
  const sats = context.buildSatelliteList();
  assert.equal(sats.length, 2, 'duplicates, idle PRN zero and idle GLONASS channels are excluded');
  assert(sats.every((sat) => sat.state === 'missing' && !sat.tracked));
  context.renderSkyplot();
  assert.equal(context.elements.get('sv-missing').textContent, 2);
  context.latestByName.TRACKSTAT.data.cutoff = 25;
  assert.equal(context.buildSatelliteList().filter((sat) => sat.state === 'missing').length, 0,
    'assigned acquisition channels below the tracking cutoff are not missing');
  context.latestByName.TRACKSTAT.crcValid = false;
  assert(context.buildSatelliteList().every((sat) => sat.state === 'visible'));
  assert.throws(() => decode({
    format: 'ascii', header: { messageName: 'TRACKSTAT' }, fields: fields.slice(0, -1),
  }), /incomplete channel data/);
});

/** Catches history restore that skips a newer detection or overwrites a newer live detection. */
test('last interference detected is seeded from restored history when newer', () => {
  const context = vm.createContext({ state: { lastDetection: { at: 500, detection: {} } } });
  load(context, 'function rememberHistoryDetection(', 'function lastDetectionSummary(');
  context.rememberHistoryDetection([
    { t: 1000, signal: 'GPSL2', count: 2, maxPower: -70, freq: 1227e6, detections: [
      { freq: 1227e6, bandwidth: 1e6, power: -90, type: 'CW' },
      { freq: 1228e6, bandwidth: 2e6, power: -70, type: 'WB' },
    ] },
    { t: 2000, signal: 'ALL', count: 0, detections: [] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.lastDetection)), {
    at: 1000,
    detection: { signalType: 'GPSL2', type: 'WB', powerDbm: -70, bandwidthHz: 2e6, centerFrequencyHz: 1228e6 },
  });
  context.state.lastDetection = { at: 5000, detection: {} };
  context.rememberHistoryDetection([{ t: 1000, signal: 'GPSL2', count: 1, detections: [] }]);
  assert.equal(context.state.lastDetection.at, 5000, 'a newer live detection is kept');
});

/** Catches view history that drops tracked or in-view counts, or a plot that omits the total and constellation lines. */
test('satellite view history stores tracked and in-view counts and renders a horizontal time plot', () => {
  const context = vm.createContext({
    MAX_INTERFERENCE_SAMPLES: 10, SOLUTION_HEARTBEAT_MS: 10000,
    state: { satelliteViewHistory: [{ t: 1000, tracked: { GPS: 1 }, inView: { GPS: 2 } }] },
    trackedSatelliteSummary: () => new Map([['GPS', { prns: new Set(['1', '2']) }]]),
    satellitesInViewBySystem: () => ({ GPS: 2, GALILEO: 1 }),
  });
  load(context, 'function recordSatelliteView(', 'const SATELLITE_VIEW =');
  context.recordSatelliteView({ name: 'RANGE', crcValid: true, receivedAt: new Date(2000).toISOString() });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.satelliteViewHistory[1])), {
    t: 2000, tracked: { GPS: 2 }, inView: { GPS: 2, GALILEO: 1 },
  });
  context.recordSatelliteView({ name: 'RANGE', crcValid: true, receivedAt: new Date(3000).toISOString() });
  assert.equal(context.state.satelliteViewHistory.length, 2, 'unchanged counts are thinned');

  const chart = { children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
  const plotContext = vm.createContext({
    Date,
    state: { satelliteViewHistory: [
      { t: 1000, tracked: { GPS: 2, GALILEO: 1 }, inView: { GPS: 4, GALILEO: 3 } },
      { t: 2000, tracked: { GPS: 3, GALILEO: 2 }, inView: { GPS: 4, GALILEO: 3 } },
    ] },
    $: () => chart,
    timelineViewport: () => ({ start: 0, windowMs: 10000 }),
    timelineAxis: (start, _window, width) => ({
      start, dataEnd: 10000, plotWidth: width, x: (time) => time / 10000 * width,
    }),
    appendTimeAxis() {},
    constellationColor: (system) => system === 'GPS' ? '#00f' : '#0f0',
    svg: (tag, attributes, text) => ({ tag, attributes, text, children: [], append(child) { this.children.push(child); } }),
  });
  load(plotContext, 'const SATELLITE_VIEW =', 'function renderCounts(');
  plotContext.sumCounts = (counts) => Object.values(counts || {}).reduce((sum, count) => sum + count, 0);
  plotContext.renderSatelliteViewPlot();
  const lines = chart.children.filter((element) => element.tag === 'polyline');
  assert.equal(lines.length, 4, 'in-view total, two constellations and tracked total');
  assert.match(lines[0].attributes.class, /satellite-view-in-view/);
  assert.match(lines[3].attributes.class, /satellite-view-total-line/);
  assert(!chart.children.some((element) => element.tag === 'text' && /GPS|GAL/.test(element.text)), 'legend is outside the SVG');
  assert(lines.every((line) => line.attributes.points.includes(',')));
  assert.equal(chart.children.filter((element) => element.tag === 'text' && element.text === '0').length, 1);
});

/** Catches a timeline heading that omits the live-reset control, or repeats it before the next closing div. */
test('wall keeps an always-visible live reset beside the timeline heading', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const headingStart = html.indexOf('<h2 id="timeline-heading">');
  const headingEnd = html.indexOf('</h2>', headingStart);
  const reset = html.indexOf('id="timeline-live"', headingStart);
  assert(headingStart >= 0 && reset > headingStart && reset < headingEnd);
  assert(!html.slice(headingEnd, html.indexOf('</div>', headingEnd)).includes('id="timeline-live"'));
});

/** Catches a live-reset control that leaves a custom pan in place or skips the redraw. */
test('wall live reset clears a custom timeline pan and redraws the live view', () => {
  const handlers = new Map();
  let renders = 0;
  const context = vm.createContext({
    state: { timelineView: { end: 1000, windowMs: 60000 } },
    zoomTimeline() {},
    initTimePlotNavigation() {},
    renderTimeline() { renders++; },
    $: (id) => ({ addEventListener: (event, handler) => handlers.set(id, handler) }),
  });
  load(context, 'function initTimelineControls()', 'function initTimePlotNavigation(');
  context.initTimelineControls();
  handlers.get('timeline-live')();
  assert.equal(context.state.timelineView, null);
  assert.equal(renders, 1);
});

/** Catches startup that throws on broken preferences, or a storage failure that stays silent. */
test('corrupt and unavailable preferences display errors without preventing startup', () => {
  const notice = {};
  const errors = [];
  const context = vm.createContext({
    document: { getElementById: () => notice },
    localStorage: {
      /** @param {string} key @returns {string|null} Broken JSON for hiddenSignals, an invalid zone, otherwise null. Side effects: none. Events: none. */
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

/** Catches a stream handler that accepts bad or oversized JSON, or that stops after one thrown handler. */
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

/** Catches a renderer wrapper that hides an error or blocks the next render. */
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

/** Catches a request helper that treats an HTTP error as success or waits forever on a stalled body. */
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

/** Catches a history reload that clears the visible samples when the request fails. */
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

/** Catches a raw-log row that keeps the full payload or the decoded body. */
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

/** Catches pruning or a capped response that drops the newest samples or cuts off the older half. */
test('server history limits restored samples and caps browser responses', () => {
  const now = Date.now();
  const history = new History({ retentionMs: 3600000, maxInterferenceSamples: 500 });
  history.interference = Array.from({ length: 2000 }, (_, index) => ({
    t: now - (1999 - index) * 1000, signal: 'L1', count: 1, maxPower: -90, index,
  }));
  history.prune(now);
  // A series longer than the cap is bucketed, so the length can be under the cap.
  // The newest sample and an older hour both have to survive.
  assert.ok(history.interference.length <= 500);
  assert.ok(history.interference.length > 100);
  assert.equal(history.interference[history.interference.length - 1].index, 1999);
  assert.ok(history.interference[0].index < 1600);
  const response = history.since(3600000, now, 100);
  assert(response.interference.length <= 100);
  assert.equal(response.interference[response.interference.length - 1].index, 1999, 'newest sample kept');
  assert.deepEqual(response.interference.slice(-50).map((sample) => sample.index),
    Array.from({ length: 50 }, (_, index) => 1950 + index), 'newest half is untouched');
  assert(response.interference[0].index < 1600, 'older samples are downsampled, not cut off');
  assert(response.interference.every((sample, index, all) => index === 0 || sample.t >= all[index - 1].t));
});

/** Catches a long-window response that drops the oldest hours or a detection while capping length. */
test('history responses downsample a long window instead of dropping its oldest hours', () => {
  const now = Date.now();
  const history = new History({ retentionMs: 86400000, maxInterferenceSamples: 100000 });
  for (let index = 0; index < 20000; index++) {
    const t = now - 86400000 + index * 4320;
    history.interference.push({ t, signal: 'L1', count: index === 100 ? 1 : 0, maxPower: index === 100 ? -80 : null });
    history.solution.push({ t, used: index % 30, tracked: 30, status: 'SOL_COMPUTED', type: 'SINGLE' });
  }
  const response = history.since(86400000, now, 2000);
  assert(response.interference.length <= 2000);
  assert(response.interference[0].t < now - 86000000, 'still reaches back about 24 h');
  assert(response.interference.some((sample) => sample.count === 1 && sample.maxPower === -80), 'detections survive');
  assert(response.solution.length <= 2000);
  assert(response.solution[0].t < now - 86000000);
});

/** Catches ASCII parsing that throws when the GPS week or seconds field is outside the finite range. */
test('out-of-range GPS timestamps cannot throw during receiver parsing', () => {
  assert.doesNotThrow(() => {
    const result = parseAsciiLog('%TESTA,1e300,1e300;0');
    assert.equal(result.header.utc, null);
  });
});

/** Catches auto mode that opens TCP before serial, treats a silent or CRC-failed port as healthy, or skips serial on the next cycle. */
test('auto transport tries serial first and falls back to TCP when serial does not connect', () => {
  const ports = [];
  const sockets = [];
  const timers = [];
  /** Serial stand-in. open stores its callback. close marks the port shut and invokes the callback immediately. Emits nothing itself. */
  class FakePort extends EventEmitter {
    /** @param {object} options Path and baud stored on the instance. Side effects: pushes this onto ports. Events: none. */
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
    /** @param {object} options @returns {EventEmitter} A socket with no-op writes. Side effects: pushes the socket onto sockets. Events: none until the test emits them. */
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
        : name === './novatel' ? require('../src/novatel') : name === './loglimit' ? require('../src/loglimit') : require(name),
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
  assert.equal(receiver.state.connected, false, 'An open port is not proof of a live receiver');
  assert.ok(timers.some((timer) => !timer.cleared && timer.ms === 30000), 'serial idle timer is armed after open');
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
  ports[2].emit('data', Buffer.from('%ITDETECTSTATUSA,2200,1;0*00000000\n'));
  assert.ok(!healthyProbe.cleared, 'A CRC-failed log does not satisfy the serial probe');
  assert.equal(receiver.state.connected, false, 'CRC-failed logs cannot establish receiver health');
  const probeBody = 'ITDETECTSTATUSA,2200,1;0';
  ports[2].emit('data', Buffer.from(`%${probeBody}*${novatelCrc32(probeBody).toString(16).padStart(8, '0')}\n`));
  assert(healthyProbe.cleared, 'A CRC-valid log keeps the serial connection');
  assert.equal(receiver.state.connected, true);
  assert.equal(sockets.length, 2);
  assert.equal(receiver.state.transport, 'serial');
  receiver.stop();
});

test('silent receivers recover after a power cycle even when the transport stays open', async (t) => {
  for (const mode of ['serial', 'tcp', 'auto']) {
    await t.test(mode, () => {
      const ports = [];
      const sockets = [];
      const timers = [];
      class FakePort extends EventEmitter {
        constructor() {
          super();
          this.commands = [];
          ports.push(this);
        }
        open(callback) { this.openCallback = callback; }
        write(command) { this.commands.push(command); }
        close(callback) { this.isOpen = false; callback(); }
      }
      const context = vm.createContext({
        Buffer, module: { exports: {} }, console: { warn() {} },
        setTimeout(callback, ms) {
          const timer = { callback, ms, cleared: false };
          timers.push(timer);
          return timer;
        },
        clearTimeout(timer) { if (timer) timer.cleared = true; },
        require: (name) => name === 'serialport' ? { SerialPort: FakePort }
          : name === 'node:net' ? {
            createConnection() {
              const socket = Object.assign(new EventEmitter(), {
                commands: [], destroyed: false,
                setKeepAlive() {}, setTimeout() {},
                write(command) { this.commands.push(command); },
                destroy() { this.destroyed = true; },
              });
              sockets.push(socket);
              return socket;
            },
          } : name === './novatel' ? require('../src/novatel')
            : name === './loglimit' ? { logLimited() {} } : require(name),
      });
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'receiver.js'), 'utf8'), context);
      const receiver = new context.module.exports.ReceiverClient({
        transport: mode, serialPath: 'COM11', serialBaudRate: 9600, serialProbeMs: 5000,
        receiverHost: '127.0.0.1', receiverPort: 3001, reconnectDelayMs: 3000, idleTimeoutMs: 30000,
      });
      const statuses = [];
      receiver.on('status', (status) => statuses.push(status));
      const open = () => {
        const transport = receiver.port || receiver.socket;
        if (receiver.port) {
          transport.isOpen = true;
          transport.openCallback(null);
        } else {
          transport.emit('connect');
        }
        assert.equal(receiver.state.connected, false, 'Opening a port must not claim receiver health');
        return transport;
      };
      const frame = (body) => Buffer.from(`%${body}*${novatelCrc32(body).toString(16).padStart(8, '0')}\n`);
      const report = frame('ITDETECTSTATUSA,2200,1;0');
      const latestTimer = (ms) => timers.filter((timer) => !timer.cleared && timer.ms === ms).pop();
      receiver.start();
      const original = open();
      original.emit('data', report);
      assert.equal(receiver.state.connected, true);
      const firstWatchdog = receiver.logTimer;
      original.emit('data', report);
      assert(firstWatchdog.cleared, 'Fresh logs reset the idle deadline');
      const watchdog = receiver.logTimer;
      original.emit('data', Buffer.from('receiver booting\n%ITDETECTSTATUSA,2200,1;0*invalid\n'));
      assert.equal(receiver.logTimer, watchdog, 'Boot chatter and CRC failures cannot keep a dead stream connected');
      original.emit('data', frame('BESTSATSA,2200,1;0'));
      assert.equal(receiver.logTimer, watchdog, 'Other profile logs cannot mask a lost periodic interference request');
      assert.equal(watchdog.ms, 30000);
      watchdog.callback();
      assert(statuses.some((status) => !status.connected && /No valid ITDETECTSTATUS logs/.test(status.lastError)));
      assert.equal(receiver.state.connected, false);
      if (mode === 'auto') {
        assert.equal(receiver.state.transport, 'tcp', 'Silent USB falls back to TCP');
        assert.equal(original.isOpen, false);
        const fallback = open();
        fallback.emit('data', report);
        assert.equal(receiver.state.connected, true);
        receiver.logTimer.callback();
        assert(fallback.destroyed);
      } else if (mode === 'serial') {
        assert.equal(original.isOpen, false);
      } else {
        assert(original.destroyed);
      }
      assert.equal(receiver.state.phase, 'waiting');
      assert.equal(latestTimer(3000).ms, 3000);
      latestTimer(3000).callback();
      assert.equal(receiver.state.transport, mode === 'tcp' ? 'tcp' : 'serial');
      const recovered = open();
      assert.notEqual(recovered, original);
      assert.equal(recovered.commands.filter((command) => command === 'LOG ITDETECTSTATUSA ONTIME 1\r\n').length, 1,
        'Reconnect restores the periodic interference log lost on reboot');
      assert(recovered.commands.includes('LOG BESTSATSA ONTIME 1\r\n'));
      assert(recovered.commands.includes('LOG TRACKSTATA ONTIME 5\r\n'));
      original.emit('close');
      original.emit('data', report);
      assert.equal(receiver.state.connected, false, 'Late events from an old transport cannot mark the new one connected');
      recovered.emit('data', report);
      assert.equal(receiver.state.connected, true);
      assert.equal(receiver.state.lastError, null);
      const activeWatchdog = receiver.logTimer;
      receiver.disconnect();
      assert(activeWatchdog.cleared, 'Manual disconnect cancels monitoring');
      activeWatchdog.callback();
      assert.equal(receiver.state.phase, 'stopped');
      assert.equal(receiver.state.connected, false);
      assert.equal(receiver.reconnectTimer, null);
      assert.equal(ports.length + sockets.length, mode === 'auto' ? 3 : 2);
    });
  }
});

/** Catches a TCP session that drops the echoed test log, skips the ITDETECTSTATUS command, or stays connected after disconnect. */
test('receiver isolates valid logs, reports connection state and disconnects cleanly', async () => {
  const receivedCommands = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      receivedCommands.push(chunk.toString('ascii'));
      const body = 'TESTA,COM1,0,0,FINESTEERING,2200,1.0,00000000,00000000;ok';
      socket.write(`#${body}*${novatelCrc32(body).toString(16).padStart(8, '0')}\n`);
    });

    /** Catches ingest that drops the next frame after a log listener throws. */
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

    /** Catches readBinaryLog returning a message when the header-length byte is 1. */
    test('invalid binary header lengths are rejected without unsafe reads', () => {
      const frame = Buffer.alloc(28);
      frame.set([0xaa, 0x44, 0x12, 1]);
      assert.equal(readBinaryLog(frame), null);
    });

    /** Catches a failed serial open that keeps the port or never schedules another attempt. */
    test('failed serial opens release the port and schedule another attempt', () => {
      const ports = [];
      const timers = [];
      /** Serial stand-in whose open callback is stored and not invoked here. Side effects: none until the test calls it. Events: none. */
      class FakePort extends EventEmitter {
        /** Side effects: pushes this onto ports. Events: none. */
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
          : name === './novatel' ? require('../src/novatel') : name === './loglimit' ? require('../src/loglimit') : require(name),
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

    /** Catches a JSON body that is answered twice, accepted when invalid or oversized, or passed to the handler. */
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

    /** Catches history.save throwing on a circular sample instead of warning once. */
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
      history.dirty = true;
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

/** Catches a short binary header that leaves the buffer stuck so the following CRC-valid ASCII log is never emitted. */
test('an implausible binary header does not stall the following ASCII log', () => {
  const receiver = new ReceiverClient({ idleTimeoutMs: 30000 });
  const logs = [];
  receiver.on('log', (message) => logs.push(message));
  receiver.ingest(Buffer.from([0xaa, 0x44, 0x12, 0x00]));
  assert.match(receiver.state.lastError, /implausible NovAtel binary header/);
  assert.ok(receiver.buffer.length < 4);
  const body = 'BESTPOSA,2200,1.0;SOL_COMPUTED';
  receiver.ingest(Buffer.from(`#${body}*${novatelCrc32(body).toString(16).padStart(8, '0')}\n`));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].header.messageName, 'BESTPOS');
  assert.equal(logs[0].crcValid, true);
  assert.equal(receiver.state.lastError, null);
  assert.equal(receiver.buffer.length, 0);
});

/** Catches a centre left in MHz, or a kHz bandwidth scaled as if it were MHz. */
test('frequency scaling keeps MHz centers and does not treat kHz bandwidth as MHz', () => {
  assert.equal(scaleFrequencyHz(1176.45, 'center'), 1176.45e6);
  assert.equal(scaleFrequencyHz(1.57542e9, 'center'), 1.57542e9);
  assert.equal(scaleFrequencyHz(500, 'center'), null);
  assert.equal(scaleFrequencyHz(3, 'bandwidth'), 3e6);
  assert.equal(scaleFrequencyHz(20000, 'bandwidth'), 20000);
  const countFirst = interpretItDetectStatus(parseAsciiLog('#ITDETECTSTATUSA,2200,1.0;1,L5,SPECTRUMANALYSIS,1176.450,3.000,-95.5'));
  assert.equal(countFirst.detections[0].centerFrequencyHz, 1176.45e6);
  assert.equal(countFirst.detections[0].bandwidthHz, 3e6);
  const narrow = interpretItDetectStatus(parseAsciiLog('#ITDETECTSTATUSA,2200,1.0;L1,1,SPECTRUMANALYSIS,1575420000,20000,-90'));
  assert.equal(narrow.detections[0].bandwidthHz, 20000);
  assert.equal(narrow.detections[0].centerFrequencyHz, 1575420000);
});

/** Catches RXSTATUS accepting a short word list, or a binary RANGE channel whose system or GLONASS frequency is wrong. */
test('RXSTATUS rejects incomplete words and binary GLONASS channels are signed', () => {
  assert.throws(() => decode({ format: 'ascii', header: { messageName: 'RXSTATUS' }, fields: ['zz', '0', '00000000'] }), /RXSTATUS/);
  assert.throws(() => decode({ format: 'ascii', header: { messageName: 'RXSTATUS' }, fields: ['00000000', '0', '12'] }), /RXSTATUS/);
  assert.throws(() => decode({ format: 'binary', header: { messageName: 'RXSTATUS' }, body: Buffer.alloc(8) }), /incomplete/);
  const body = Buffer.alloc(4 + 44);
  body.writeUInt32LE(1, 0);
  body.writeUInt16LE(12, 4);
  body.writeUInt16LE(9, 6);
  body.writeUInt32LE(1 << 16, 4 + 40);
  const glonass = decode({ format: 'binary', header: { messageName: 'RANGE' }, body });
  assert.equal(glonass.data.observations[0].system, 'GLONASS');
  assert.equal(glonass.data.observations[0].gloFrequency, 2);
  body.writeUInt32LE(0, 4 + 40);
  const gps = decode({ format: 'binary', header: { messageName: 'RANGE' }, body });
  assert.equal(gps.data.observations[0].system, 'GPS');
  assert.equal(gps.data.observations[0].gloFrequency, 9);
});

/** Catches a decode error that replaces the last good BESTSATS or omits the raw-log note. */
test('a decode failure is logged and does not replace the last good record', () => {
  const warnings = [];
  const errors = [];
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const context = vm.createContext({
    /** @param {object} message @returns {object} Throws when message.fail is set. Side effects: none. Events: none. */
    decode(message) {
      if (message.fail) throw new Error('BESTSATS has an invalid observation count');
      return message;
    },
    store: { latest: { BESTSATS: { name: 'BESTSATS', crcValid: true, data: { kept: true } } }, counts: {}, itdetectHistory: [], satvisBySystem: {}, ephemeris: {}, rawLog: [] },
    config: { historySize: 50, rawLogSize: 200 },
    history: { addSolution() {}, addSatellites() {}, addInterference() {} },
    broadcast() {},
    console: { warn(message) { warnings.push(message); }, error(message) { errors.push(message); } },
    receiver: { setError(error) { this.lastError = error.message; } },
    saneTimestamp,
  });
  vm.runInContext(serverCode.slice(serverCode.indexOf('function processReceiverLog('), serverCode.indexOf('function broadcast(')), context);
  context.processReceiverLog({ fail: true, header: { messageName: 'BESTSATS' }, raw: '%BESTSATSA;bad', crcValid: true, format: 'ascii' });
  assert.match(errors[0], /invalid observation count/);
  assert.equal(context.receiver.lastError, 'BESTSATS has an invalid observation count');
  assert.equal(context.store.latest.BESTSATS.data.kept, true);
  assert.match(context.store.rawLog[0].raw, /invalid observation count/);
  assert.equal(context.store.counts.BESTSATS, 1);
});

/** Catches a raw log or live record that keeps a multi-megabyte frame, or an ephemeris map that grows past 128 satellites. */
test('raw storage is truncated and ephemeris and message counts stay capped', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const context = vm.createContext({
    decode: (record) => record,
    store: { latest: {}, counts: {}, itdetectHistory: [], satvisBySystem: {}, ephemeris: {}, rawLog: [] },
    config: { historySize: 50, rawLogSize: 200 },
    history: { addSolution() {}, addSatellites() {}, addInterference() {} },
    broadcast() {},
    console: { warn() {}, error() {} },
    saneTimestamp,
  });
  vm.runInContext(serverCode.slice(serverCode.indexOf('function processReceiverLog('), serverCode.indexOf('function broadcast(')), context);
  const huge = 'R'.repeat(200000);
  context.processReceiverLog({
    name: 'RANGE', crcValid: true, raw: huge, receivedAt: '2026-10-22T00:00:00.000Z', format: 'ascii',
  });
  assert.ok(context.store.rawLog[0].raw.length < 16420);
  assert.match(context.store.rawLog[0].raw, /display truncated/);
  assert.ok(context.store.latest.RANGE.raw.length < 16420);
  for (let index = 0; index < 200; index++) {
    context.processReceiverLog({
      name: 'GPSEPHEM', kind: 'ephemeris', crcValid: true, receivedAt: '2026-10-22T00:00:00.000Z',
      data: { satelliteId: `S${index}`, parameters: [1] },
    });
  }
  assert.equal(Object.keys(context.store.ephemeris.GPSEPHEM.records).length, 128);
  context.processReceiverLog({
    name: 'GPSEPHEM', kind: 'ephemeris', crcValid: true, receivedAt: '2026-10-22T00:00:01.000Z',
    data: { satelliteId: 'S0', parameters: [2] },
  });
  assert.equal(context.store.ephemeris.GPSEPHEM.records.S0.data.parameters[0], 2);
  for (let index = 0; index < 300; index++) {
    context.processReceiverLog({ name: `M${index}`, crcValid: true, receivedAt: '2026-10-22T00:00:00.000Z' });
  }
  assert.equal(Object.keys(context.store.counts).length, 256);
  const before = context.store.counts.M0;
  context.processReceiverLog({ name: 'M0', crcValid: true, receivedAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(context.store.counts.M0, before + 1);
});

/** Catches a track map past 512 entries, or a replace that gives up on the first EPERM. */
test('history keeps at most 512 satellite tracks and replaces a file after EPERM', () => {
  assert.equal(MAX_TRACKS, 512);
  const history = new History({ retentionMs: 3600000, trackSampleMs: 1, maxInterferenceSamples: 10 });
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    for (let prn = 0; prn < 520; prn++) history.addSatellites('GPS', [{ prn, elevation: 10, azimuth: 10 }], prn);
  } finally {
    console.warn = original;
  }
  assert.equal(history.tracks.size, 512);
  assert.equal(warnings.length, 1);

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'replace-'));
  const destination = path.join(dir, 'history.json');
  const temporary = path.join(dir, 'history.json.tmp');
  fs.writeFileSync(destination, 'old');
  fs.writeFileSync(temporary, 'new');
  const rename = fs.renameSync;
  let denied = false;
  fs.renameSync = (from, to) => {
    if (!denied) {
      denied = true;
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return rename(from, to);
  };
  try {
    replaceFileSync(destination, temporary);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'new');
    assert.equal(fs.readFileSync(`${destination}.bak`, 'utf8'), 'old');
  } finally {
    fs.renameSync = rename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(denied, true);
});

/** Catches settings that do not round-trip, a broken file that ignores its backup, retention above 31 days, or an out-of-range WEB_PORT. */
test('connection settings round-trip and retention above 31 days is clamped', () => {
  const config = require('../src/config');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'connection-'));
  const file = path.join(dir, 'connection-settings.json');
  try {
    const settings = { transport: 'serial', receiverHost: '10.1.1.5', receiverPort: 3001, serialPath: 'COM9', serialBaudRate: 115200 };
    config.saveConnectionSettings(file, settings);
    const logs = [];
    const originalLog = console.log;
    console.log = (message) => logs.push(String(message));
    try {
      assert.deepEqual(config.loadConnectionOverrides(file), settings);
    } finally {
      console.log = originalLog;
    }
    assert.match(logs.join('\n'), /using saved connection settings from/);
    assert.match(logs.join('\n'), /COM9/);
    fs.writeFileSync(file, '{');
    assert.equal(config.loadConnectionOverrides(file), null);
    fs.writeFileSync(`${file}.bak`, JSON.stringify(settings));
    assert.deepEqual(config.loadConnectionOverrides(file), settings);
    assert.equal(config.loadConnectionOverrides(''), null);
    assert.throws(() => config.saveConnectionSettings(file, { transport: 'nope' }), /transport/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { spawnSync } = require('node:child_process');
  const root = path.join(__dirname, '..');
  const clamped = spawnSync(process.execPath, ['-e', "process.env.HISTORY_RETENTION_MIN='99999999'; const config = require('./src/config'); if (config.historyRetentionMinutes !== 44640) process.exit(1);"], { cwd: root, encoding: 'utf8' });
  assert.equal(clamped.status, 0, clamped.stderr);
  assert.match(clamped.stderr, /clamping/);
  const invalidPort = spawnSync(process.execPath, ['-e', "process.env.WEB_PORT='999999'; require('./src/config');"], { cwd: root, encoding: 'utf8' });
  assert.notEqual(invalidPort.status, 0);
  assert.match(invalidPort.stderr, /WEB_PORT/);
});

/** Catches invented ephemeris health, a throw on a null MSL height, or raw HTML in the map popup. */
test('missing ephemeris health is unknown, blank height does not throw, and map text is escaped', () => {
  const health = vm.createContext({});
  load(health, 'function ephemerisParameters(', 'function buildEphemerisTable(');
  /**
   * Wraps name/value pairs as the parameter list ephemerisHealth reads.
   * @param {Array<[string, *]>} pairs Parameter names and values.
   * @returns {{parameters: object[]}}
   */
  const data = (pairs) => ({ parameters: pairs.map(([name, value]) => ({ name, value })) });
  assert.equal(health.ephemerisHealth('GLOEPHEMERIS', data([])), null);
  assert.equal(health.ephemerisHealth('GLOEPHEMERIS', data([['health', 1]])), true);
  assert.equal(health.ephemerisHealth('GLOEPHEMERIS', data([['health', 4]])), false);
  assert.equal(health.ephemerisHealth('GALINAVEPHEMERIS', data([['e1Health', 0]])), null);
  assert.equal(health.ephemerisHealth('GALFNAVEPHEMERIS', data([])), null);
  assert.equal(health.ephemerisHealth('NAVICEPHEMERIS', data([['l5Health', 0], ['sHealth', 0]])), null);
  assert.equal(health.ephemerisHealth('GPSEPHEM', data([])), null);
  assert.equal(health.ephemerisHealth('GPSEPHEM', data([['health', 0]])), true);

  const elements = new Map();
  const position = vm.createContext({
    state: { heightDatum: 'ellipsoidal' },
    fmt: (value) => (value === null || value === undefined ? '—' : String(value)),
    heightFor: () => null,
    explainSolution: () => ({ text: 'ok', quality: null }),
    QUALITY_LABEL: {},
    updateMap() {},
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, className: '', classList: { toggle() {} } });
      return elements.get(id);
    },
  });
  load(position, 'function renderBestPos(', 'function escapeHtml(');
  assert.doesNotThrow(() => position.renderBestPos({
    data: { solutionStatus: 'SOL_COMPUTED', positionType: 'SINGLE', undulation: 1.5, heightMsl: null },
  }));
  assert.match(elements.get('pos-undulation').textContent, /MSL —/);

  let popup = '';
  let viewed = false;
  const map = vm.createContext({
    state: { heightDatum: 'msl' },
    map: null, marker: null, accuracyCircle: null,
    fmt: (value) => String(value),
    heightFor: () => 12.5,
    requestAnimationFrame(callback) { callback(); },
    $: (id) => ({ textContent: '', hidden: false, classList: { add() {} }, href: id }),
    L: {
      map() { viewed = true; return { setView() { return this; }, invalidateSize() {} }; },
      tileLayer() { return { addTo() {} }; },
      marker() { return { addTo() { return this; }, bindPopup(html) { popup = html; } }; },
      circle() { return { addTo() {} }; },
    },
  });
  load(map, 'function escapeHtml(', 'function renderBestGnssPos(');
  assert.doesNotThrow(() => map.updateMap({ latitude: 91, longitude: 0, solutionStatus: 'SOL_COMPUTED', positionType: 'SINGLE' }));
  assert.equal(viewed, false);
  map.updateMap({ latitude: 51.5, longitude: -0.1, solutionStatus: '<img>', positionType: 'A&B', satellitesUsed: 8 });
  assert.equal(viewed, true);
  assert.match(popup, /&lt;img&gt;/);
  assert.match(popup, /A&amp;B/);
  assert.doesNotMatch(popup, /<img>/);
});

/** Catches an idle serial port that opens TCP instead of scheduling another serial attempt. */
test('a silent serial port is recycled without falling straight through to TCP', () => {
  const ports = [];
  const timers = [];
  /** Serial stand-in. close invokes its callback immediately with no error. Side effects: recorded in ports. Events: none. */
  class FakePort extends EventEmitter {
    /** @param {object} options @returns {void} Side effects: pushes this onto ports. Events: none. */
    constructor(options) {
      super();
      this.options = options;
      ports.push(this);
    }
    open(callback) { this.openCallback = callback; }
    write() {}
    close(callback) { this.isOpen = false; if (callback) callback(); }
  }
  const context = vm.createContext({
    Buffer, module: { exports: {} },
    console: { warn() {}, log() {}, error() {} },
    setTimeout(callback, ms) { timers.push({ callback, ms, cleared: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    require: (name) => name === 'serialport' ? { SerialPort: FakePort }
      : name === 'node:net' ? { createConnection() { throw new Error('TCP should not be opened'); } }
        : name === './novatel' ? require('../src/novatel') : name === './loglimit' ? require('../src/loglimit') : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'receiver.js'), 'utf8'), context);
  const receiver = new context.module.exports.ReceiverClient({
    transport: 'serial', serialPath: 'COM11', serialBaudRate: 9600, serialProbeMs: 5000,
    receiverHost: '20.20.20.50', receiverPort: 3001, reconnectDelayMs: 3000, idleTimeoutMs: 30000,
  });
  receiver.start();
  ports[0].isOpen = true;
  ports[0].openCallback(null);
  const idle = timers.filter((timer) => !timer.cleared && timer.ms === 30000).pop();
  idle.callback();
  assert.match(receiver.state.lastError, /No data received for 30000 ms/);
  assert.equal(receiver.state.connected, false);
  assert.equal(receiver.port, null);
  assert.ok(timers.some((timer) => !timer.cleared && timer.ms === 3000));
  assert.equal(ports.length, 1);
  receiver.stop();
});

/** Catches a close error from a replaced serial port that overwrites the current port's error. */
test('a close error from a serial port that is no longer current is ignored', () => {
  const ports = [];
  const timers = [];
  /** Serial stand-in that stores the close callback instead of calling it. Side effects: recorded in ports. Events: none. */
  class FakePort extends EventEmitter {
    /** @param {object} options @returns {void} Side effects: pushes this onto ports. Events: none. */
    constructor(options) {
      super();
      this.options = options;
      ports.push(this);
    }
    open(callback) { this.openCallback = callback; }
    write() {}
    /**
     * Records the callback so the test can fire a late error.
     * @param {Function} callback
     * @returns {void}
     * Side effects: sets isOpen false and closeCallback. Events: none.
     */
    close(callback) {
      this.isOpen = false;
      this.closeCallback = callback;
    }
  }
  const context = vm.createContext({
    Buffer, module: { exports: {} },
    console: { warn() {}, log() {}, error() {} },
    setTimeout(callback, ms) { timers.push({ callback, ms, cleared: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    require: (name) => name === 'serialport' ? { SerialPort: FakePort }
      : name === 'node:net' ? { createConnection() { throw new Error('TCP should not be opened'); } }
        : name === './novatel' ? require('../src/novatel') : name === './loglimit' ? require('../src/loglimit') : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'receiver.js'), 'utf8'), context);
  const receiver = new context.module.exports.ReceiverClient({
    transport: 'serial', serialPath: 'COM11', serialBaudRate: 9600, serialProbeMs: 0,
    receiverHost: '20.20.20.50', receiverPort: 3001, reconnectDelayMs: 3000, idleTimeoutMs: 30000,
  });
  receiver.start();
  ports[0].isOpen = true;
  ports[0].openCallback(null);
  const idle = timers.filter((timer) => !timer.cleared && timer.ms === 30000).pop();
  idle.callback();
  const denied = new Error('Access denied');
  denied.code = 'EACCES';
  ports[0].closeCallback(denied);
  assert.match(receiver.state.lastError, /No data received for 30000 ms/);
  const retry = timers.filter((timer) => !timer.cleared && timer.ms === 3000).pop();
  retry.callback();
  ports[1].isOpen = true;
  ports[1].openCallback(null);
  assert.equal(receiver.state.lastError, null);
  ports[0].closeCallback(denied);
  assert.equal(receiver.state.lastError, null);
  receiver.stop();
});

/** Catches history that keeps a GPS time more than 5 min old, more than 2 s ahead, or stuck at the 1980 epoch. */
test('GPS header time is used only when it is recent, at most 2 s ahead, and at most 5 min behind', () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);
  const receivedAt = new Date(now).toISOString();
  assert.equal(saneTimestamp('1980-01-06T00:00:00.000Z', receivedAt, now), now);
  assert.equal(saneTimestamp(new Date(now - 60 * 1000).toISOString(), receivedAt, now), now - 60 * 1000);
  assert.equal(saneTimestamp(new Date(now - 5 * 60 * 1000).toISOString(), receivedAt, now), now - 5 * 60 * 1000);
  assert.equal(saneTimestamp(new Date(now - 5 * 60 * 1000 - 1).toISOString(), receivedAt, now), now);
  assert.equal(saneTimestamp(new Date(now - 10 * 60 * 1000).toISOString(), receivedAt, now), now);
  assert.equal(saneTimestamp(new Date(now + 2000).toISOString(), receivedAt, now), now + 2000);
  assert.equal(saneTimestamp(new Date(now + 2001).toISOString(), receivedAt, now), now);
  assert.equal(saneTimestamp(new Date(now + 5 * 60 * 1000).toISOString(), receivedAt, now), now);
  assert.equal(saneTimestamp(undefined, undefined, now), now);

  const browser = vm.createContext({
    Date, MAX_INTERFERENCE_SAMPLES: 100, MAX_TRACK_SAMPLES: 10, MAX_TRACKS: 512,
    state: { tracks: {}, interferenceHistory: [] }, isValidSkyPosition: () => true, recordSolution() {},
  });
  load(browser, 'function recordLiveHistory(', '// Unchanged solutions');
  const liveReceived = new Date().toISOString();
  browser.recordLiveHistory({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: liveReceived,
    header: { utc: '1980-01-06T00:00:00.000Z' }, data: { detections: [] },
  });
  assert.equal(browser.state.interferenceHistory[0].t, Date.parse(liveReceived));
  const headerUtc = new Date(Date.now() - 60 * 1000).toISOString();
  browser.recordLiveHistory({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: liveReceived,
    header: { utc: headerUtc }, data: { detections: [] },
  });
  assert.equal(browser.state.interferenceHistory[1].t, Date.parse(headerUtc));
  const ahead = new Date(Date.now() + 5000).toISOString();
  browser.recordLiveHistory({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: liveReceived,
    header: { utc: ahead }, data: { detections: [] },
  });
  assert.equal(browser.state.interferenceHistory[2].t, Date.parse(liveReceived));
  const slightAhead = new Date(Date.now() + 1000).toISOString();
  browser.recordLiveHistory({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: liveReceived,
    header: { utc: slightAhead }, data: { detections: [] },
  });
  assert.equal(browser.state.interferenceHistory[3].t, Date.parse(slightAhead));

  const stamps = [];
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const context = vm.createContext({
    decode: (record) => record,
    store: { latest: {}, counts: {}, itdetectHistory: [], satvisBySystem: {}, ephemeris: {}, rawLog: [] },
    config: { historySize: 50, rawLogSize: 200 },
    history: {
      addInterference: (signal, detections, timestamp) => stamps.push(timestamp),
      addSolution() {}, addSatellites() {},
    },
    broadcast() {}, console: { warn() {} }, saneTimestamp,
  });
  vm.runInContext(serverCode.slice(serverCode.indexOf('function processReceiverLog('), serverCode.indexOf('function broadcast(')), context);
  context.processReceiverLog({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: liveReceived,
    header: { utc: '1980-01-06T00:00:00.000Z' },
    data: { detections: [{ signalType: 'L1', powerDbm: -80, centerFrequencyHz: 1, bandwidthHz: 1 }] },
  });
  context.processReceiverLog({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: liveReceived,
    header: { utc: headerUtc },
    data: { detections: [{ signalType: 'L1', powerDbm: -70, centerFrequencyHz: 1, bandwidthHz: 1 }] },
  });
  assert.equal(stamps[0], Date.parse(liveReceived));
  assert.equal(stamps[1], Date.parse(headerUtc));
  context.processReceiverLog({
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: liveReceived,
    header: { utc: new Date(Date.now() + 5000).toISOString() },
    data: { detections: [{ signalType: 'L1', powerDbm: -60, centerFrequencyHz: 1, bandwidthHz: 1 }] },
  });
  assert.equal(stamps[2], Date.parse(liveReceived));
});

/** Catches a snapshot that shows a CRC-failed interference report as the live status. */
test('a snapshot keeps CRC-failed interference out of the live display', () => {
  const latestByName = {};
  const queued = [];
  const context = vm.createContext({
    latestByName,
    state: { counts: {}, ephemeris: {}, itBySignal: {}, itSeen: 0, satvis: {} },
    pendingRaw: [], pendingInterference: [],
    renderStatus() {}, applyArchiveStatus() {},
    applyRecord(record) { if (record && record.crcValid === true) latestByName[record.name] = record; },
    recordSatelliteView() {}, rememberLastDetection() {},
    queueRecord(queue, record) { queued.push(record); },
    $: () => ({ replaceChildren() {} }),
    MAX_IT_ROWS: 50, MAX_RAW_ROWS: 300,
  });
  load(context, 'function applySnapshot(', 'function applyPayload(');
  const valid = {
    name: 'ITDETECTSTATUS', crcValid: true, receivedAt: '2026-10-22T12:00:01.000Z', data: { detections: [] },
  };
  const failed = {
    name: 'ITDETECTSTATUS', crcValid: false, receivedAt: '2026-10-22T12:00:02.000Z',
    data: { detections: [{ signalType: 'L1' }] },
  };
  context.applySnapshot({ latest: { ITDETECTSTATUS: valid }, itdetectHistory: [valid, failed], counts: {} });
  assert.equal(context.latestByName.ITDETECTSTATUS.receivedAt, valid.receivedAt);
  assert.equal(context.latestByName.ITDETECTSTATUS.crcValid, true);
  assert.equal(queued.length, 2);
  const newer = { ...valid, receivedAt: '2026-10-22T12:00:03.000Z', data: { detections: [{ signalType: 'L2' }] } };
  context.applySnapshot({ latest: { ITDETECTSTATUS: valid }, itdetectHistory: [failed, newer], counts: {} });
  assert.equal(context.latestByName.ITDETECTSTATUS.receivedAt, newer.receivedAt);
});

/** Catches a replace that leaves the destination changed when the final rename fails with ENOSPC. */
test('a failed replace restores the previous file and load falls back to the backup', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'replace-restore-'));
  const destination = path.join(dir, 'history.json');
  const temporary = path.join(dir, 'next.json.tmp');
  fs.writeFileSync(destination, 'old');
  fs.writeFileSync(temporary, 'new');
  const rename = fs.renameSync;
  let placing = false;
  fs.renameSync = (from, to) => {
    if (placing && String(from).endsWith('.tmp')) {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    }
    const result = rename(from, to);
    if (String(to).endsWith('.bak')) placing = true;
    return result;
  };
  try {
    assert.throws(() => replaceFileSync(destination, temporary), /disk full/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
  } finally {
    fs.renameSync = rename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Catches a flush that loses a newer sample, a corrupt file with a good backup that
 * stays unsaved, or a deleted file whose backup is not loaded.
 */
test('shutdown flush wins over an older async save, and a corrupt history file is recovered from its backup', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'history-flush-'));
  const file = path.join(dir, 'history.json');
  const history = new History({
    retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
  });
  /**
   * Builds one interference detection used by the history save tests.
   * @param {number} power Power in dBm.
   * @returns {object[]} Single-detection list.
   */
  const sample = (power) => [{ powerDbm: power, centerFrequencyHz: 1.5e9, bandwidthHz: 1000, type: 'CW' }];
  const now = Date.now();
  history.addInterference('L1', sample(-90), now);
  let releaseFirst;
  const originalWrite = fs.promises.writeFile;
  const seen = new Promise((resolve) => {
    fs.promises.writeFile = (...args) => {
      if (!releaseFirst && String(args[0]).startsWith(file)) {
        return new Promise((resolveWrite, rejectWrite) => {
          releaseFirst = () => originalWrite(...args).then(resolveWrite, rejectWrite);
          resolve();
        });
      }
      return originalWrite(...args);
    };
  });
  try {
    const pending = history.save();
    await seen;
    history.addInterference('L1', sample(-70), now + 1);
    const flushing = history.flush();
    releaseFirst();
    await flushing;
    await pending;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.interference.length, 2);
    assert.equal(saved.interference[1].maxPower, -70);
  } finally {
    fs.promises.writeFile = originalWrite;
  }

  history.addInterference('L1', sample(-60), now + 2);
  history.saveSync();
  fs.writeFileSync(file, '{');
  const blocked = new History({
    retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    blocked.load();
  } finally {
    console.warn = originalWarn;
  }
  // A corrupt main file with a good .bak is moved aside and saving resumes.
  assert.equal(blocked.savesDisabled, false);
  assert.ok(blocked.interference.length >= 1);
  const corruptNames = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(corruptNames.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corruptNames[0]), 'utf8'), '{');
  blocked.addInterference('L1', sample(-50), now + 3);
  await blocked.save();
  blocked.saveSync();
  const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(rewritten.interference.some((item) => item.maxPower === -50));
  assert.match(warnings.join('\n'), /saving will resume/);

  fs.rmSync(file);
  const fromBackup = new History({
    retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
  });
  fromBackup.load();
  assert.equal(fromBackup.savesDisabled, false);
  assert.ok(fromBackup.interference.length >= 1);
  await fromBackup.save();
  assert.notEqual(fs.readFileSync(file, 'utf8'), '{');
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Catches a load or save that rewrites a history file whose size is reported as 65 MiB. */
test('an oversize history file is left untouched', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'history-size-'));
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file, '{"version":1}');
  const realStat = fs.statSync;
  fs.statSync = (target, options) => {
    const stat = realStat(target, options);
    if (target === file) {
      return new Proxy(stat, { get: (obj, prop, receiver) => (prop === 'size' ? (65 * 1024 * 1024) : Reflect.get(obj, prop, receiver)) });
    }
    return stat;
  };
  try {
    const history = new History({
      retentionMs: 60000, trackSampleMs: 1, maxInterferenceSamples: 10, filePath: file,
    });
    history.load();
    assert.equal(history.savesDisabled, true);
    history.saveSync();
    assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1}');
  } finally {
    fs.statSync = realStat;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Catches a locked history file that is replaced before it can be read, or a retry that drops the older sample. */
test('a locked history file is retried and then merged without dropping the previous samples', () => {
  /**
   * Builds one interference detection used by the history save tests.
   * @param {number} power Power in dBm.
   * @returns {object[]} Single-detection list.
   */
  const sample = (power) => [{ powerDbm: power, centerFrequencyHz: 1.5e9, bandwidthHz: 1000, type: 'CW' }];
  const realStat = fs.statSync;
  try {
    for (const code of ['EPERM', 'EBUSY', 'EIO']) {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'history-lock-'));
      const file = path.join(dir, 'history.json');
      const history = new History({
        retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
      });
      const now = Date.now();
      history.addInterference('L1', sample(-80), now);
      history.saveSync();
      const original = fs.readFileSync(file, 'utf8');
      let locked = true;
      fs.statSync = (target, options) => {
        if (locked && target === file) {
          const error = new Error('locked');
          error.code = code;
          throw error;
        }
        return realStat(target, options);
      };
      const blocked = new History({
        retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
      });
      blocked.load();
      assert.equal(blocked.savesDisabled, false, code);
      blocked.addInterference('L1', sample(-50), now + 1);
      blocked.saveSync();
      assert.equal(fs.readFileSync(file, 'utf8'), original, code);
      locked = false;
      blocked.saveSync();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.interference.length, 2, code);
      assert.ok(saved.interference.some((item) => item.maxPower === -80), code);
      assert.ok(saved.interference.some((item) => item.maxPower === -50), code);
      fs.statSync = realStat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.statSync = realStat;
  }
});

/** Catches a save that replaces a history file the load could not stat without rereading the copy still on disk. */
test('a history file that disappears is reread before it is replaced', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'history-missing-'));
  const file = path.join(dir, 'history.json');
  const history = new History({
    retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
  });
  history.addInterference('L1', [{ powerDbm: -70, centerFrequencyHz: 1.5e9, bandwidthHz: 1000, type: 'CW' }], Date.now());
  history.saveSync();
  const realStat = fs.statSync;
  let missing = true;
  fs.statSync = (target, options) => {
    if (missing && target === file) {
      const error = new Error('gone');
      error.code = 'ENOENT';
      throw error;
    }
    return realStat(target, options);
  };
  try {
    const reloaded = new History({
      retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
    });
    reloaded.load();
    assert.equal(reloaded.savesDisabled, false);
    assert.equal(reloaded.interference.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).interference[0].maxPower, -70);
    missing = false;
    reloaded.saveSync();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.interference.length, 1);
    assert.equal(saved.interference[0].maxPower, -70);
  } finally {
    fs.statSync = realStat;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Catches a save that overwrites a history file whose version is 2. */
test('a history file with the wrong version is not replaced', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'history-version-'));
  const file = path.join(dir, 'history.json');
  const original = '{"version":2,"interference":[]}';
  fs.writeFileSync(file, original);
  try {
    const history = new History({
      retentionMs: 24 * 60 * 60 * 1000, trackSampleMs: 1, maxInterferenceSamples: 100, filePath: file,
    });
    history.load();
    assert.equal(history.savesDisabled, true);
    history.addInterference('L1', [{ powerDbm: -40, centerFrequencyHz: 1.5e9, bandwidthHz: 1000, type: 'CW' }], Date.now());
    history.saveSync();
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Catches a failed settings save reported as success, or a later save that clears the previous error. */
test('a connection settings save failure is reported instead of a silent success', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(serverCode, /const saveError = persistConnectionSettings\(\)/);
  assert.match(serverCode.slice(serverCode.indexOf('const saveError')), /writeHead\(500/);
  const warnings = [];
  const context = vm.createContext({
    config: {
      connectionSettingsFile: 'settings.json',
      saveConnectionSettings() { throw new Error('disk full'); },
    },
    connectionSettings: () => ({ transport: 'serial' }),
    receiver: { setError(error) { this.lastError = error.message; } },
    console: { warn(message) { warnings.push(String(message)); } },
  });
  vm.runInContext(serverCode.slice(
    serverCode.indexOf('function persistConnectionSettings('),
    serverCode.indexOf('\nconst server ='),
  ), context);
  assert.match(context.persistConnectionSettings(), /disk full/);
  assert.match(context.receiver.lastError, /Could not save connection settings: disk full/);
  assert.match(warnings[0], /Could not save connection settings/);
  context.config.saveConnectionSettings = () => {};
  assert.equal(context.persistConnectionSettings(), null);
  assert.equal(context.receiver.lastError, 'Could not save connection settings: disk full');
});

/** Catches a satellite flush that draws the skyplot and then draws it again from renderRange. */
test('the satellite tab draws the skyplot once per update', () => {
  const calls = [];
  const context = vm.createContext({
    document: { hidden: false, querySelector: () => ({ dataset: { tab: 'satellites' } }) },
    latestByName: { RANGE: { data: { observations: [] } } },
    dirtyRecords: new Set(['RANGE']),
    countsDirty: false, ephemerisDirty: false, timelineDirty: false,
    pendingRaw: [], pendingInterference: [],
    renderSafely: (_label, render) => render(),
    renderSkyplot: () => calls.push('skyplot'),
  });
  context.renderRange = () => { calls.push('range'); context.renderSkyplot(); };
  load(context, 'function flushUpdates(', 'function renderStatus(');
  context.flushUpdates();
  assert.deepEqual(calls, ['range', 'skyplot']);
  const rangeStart = code.indexOf('function renderRange(');
  const rangeSource = code.slice(rangeStart, code.indexOf('\nfunction ', rangeStart + 20));
  assert.equal(rangeSource.match(/renderSkyplot\(/g).length, 1, 'renderRange still draws the skyplot');
  calls.length = 0;
  context.latestByName = {};
  context.dirtyRecords = new Set(['SATVIS2']);
  context.flushUpdates();
  assert.deepEqual(calls, ['skyplot']);
  calls.length = 0;
  context.latestByName = { RANGE: {} };
  context.dirtyRecords = new Set(['RANGE']);
  context.flushUpdates();
  assert.deepEqual(calls, ['skyplot'], 'a RANGE report with no body still draws the skyplot once');
});

/** Catches an unknown satellite drawn with the same ring as a tracked one. */
test('tracked and usage-unknown skyplot markers use different strokes', () => {
  const circles = [];
  const context = vm.createContext({
    skyPosition: () => ({ x: 1, y: 2 }),
    constellationColor: () => '#abc',
    STATE_TEXT: { tracked: 'tracked', unknown: 'unknown' },
    svg(name, attrs) {
      const node = { name, attrs, children: [], append(child) { this.children.push(child); } };
      if (name === 'circle') circles.push(attrs);
      return node;
    },
  });
  load(context, 'function buildSatMarker(', '/** Merges geometry');
  const sat = { system: 'GPS', prn: '1', elevation: 40, azimuth: 10 };
  context.buildSatMarker({ ...sat, state: 'tracked' });
  context.buildSatMarker({ ...sat, state: 'unknown' });
  assert.equal(circles[0].fill, circles[1].fill);
  assert.equal(circles[0].stroke, circles[1].stroke);
  assert.equal(circles[0]['stroke-dasharray'], 'none');
  assert.equal(circles[1]['stroke-dasharray'], '4 2');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(html, /class="key-marker unknown"/);
  assert.match(css, /\.key-marker\.unknown\s*\{[^}]*dashed/);
  assert.doesNotMatch(html, /key-marker tracked[^<]*<\/span>Tracked, usage unknown/);
});

/**
 * OEM7 RANGE/TRACKSTAT bits 21-25 do not define Galileo signal type 0.
 * The simulator status word leaves those bits clear, so the label stays Signal 0.
 */
test('Galileo signal code 0 stays unnamed and documented codes keep their names', () => {
  const context = vm.createContext({});
  load(context, 'const SIGNAL_NAMES = {', 'function signalOrder(');
  const named = [2, 6, 7, 12, 17, 20].map((signal) => context.signalName('GALILEO', (signal << 21).toString(16)));
  assert.deepEqual(named, ['E1', 'E6B', 'E6C', 'E5a', 'E5b', 'E5 AltBOC']);
  const simulator = fs.readFileSync(path.join(__dirname, '..', 'tools', 'simulator.js'), 'utf8');
  assert.match(simulator, /0x08109c04 & ~\(0x7 << 16\)/);
  const word = ((0x08109c04 & ~(0x7 << 16)) | (3 << 16)) >>> 0;
  assert.equal(context.signalCode(word), 0);
  assert.equal(context.signalName('GALILEO', word.toString(16)), 'Signal 0');
});

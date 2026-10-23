/**
 * Locks in the usability behaviour R approved: interference hold, band pills,
 * plain errors, and loopback-only connection changes.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const browserCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

/**
 * Evaluates a source slice in a vm context.
 * @param {string} code Source text.
 * @param {string} start Inclusive start marker.
 * @param {string} end Exclusive end marker.
 * @param {object} context vm context.
 * @returns {void}
 */
function load(code, start, end, context) {
  const first = code.indexOf(start);
  const last = code.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing source boundary: ${start}`);
  vm.runInContext(code.slice(first, last), context);
}

/**
 * Minimal element map used by the banner slice.
 * @returns {{elements: Map, $: Function}}
 */
function elements() {
  const store = new Map();
  const $ = (id) => {
    if (!store.has(id)) {
      store.set(id, {
        className: '',
        textContent: '',
        hidden: false,
        classList: { toggle() {} },
        dataset: {},
        rows: [],
        replaceChildren() { this.rows = []; },
        insertRow() {
          const row = { cells: [], insertCell() { const cell = { append() {} }; this.cells.push(cell); return cell; } };
          this.rows.push(row);
          return row;
        },
      });
    }
    return store.get(id);
  };
  return { elements: store, $ };
}

test('plain errors name the next step and keep the raw code', () => {
  const context = vm.createContext({});
  load(browserCode, 'function plainError(', 'function writePreference(', context);
  const refused = context.plainError('connect ECONNREFUSED 127.0.0.1:3001');
  assert.match(refused.text, /refused the connection/);
  assert.match(refused.raw, /ECONNREFUSED/);
  const missing = context.plainError("ENOENT: /mnt/nas-offline/novatel/pwrpak1");
  assert.match(missing.text, /folder was not found/);
  assert.match(missing.raw, /ENOENT/);
  const ports = context.plainError('Request failed (500) for /api/serial-ports');
  assert.match(ports.text, /Serial ports could not be listed/);
  const remote = context.plainError('Request failed (403) for /api/disconnect');
  assert.match(remote.text, /cannot change the connection/);
});

test('band pills follow the hold, then recent, then clear for N minutes', () => {
  const context = vm.createContext({ interferenceHoldMs: 30000, INTERFERENCE_RECENT_MS: 10 * 60 * 1000 });
  load(browserCode, 'function bandPill(', 'function buildBandCard(', context);
  const now = 1_000_000;
  assert.equal(context.bandPill('unmonitored', 0, null, now).text, 'No data');
  assert.equal(context.bandPill('clear', 0, null, now).text, 'Clear');
  assert.equal(context.bandPill('jammed', 2, now, now).text, '\u26a0 Active');
  assert.equal(context.bandPill('clear', 0, now - 10000, now).status, 'active');
  assert.equal(context.bandPill('clear', 0, now - 6 * 60 * 1000, now).text, 'Recent');
  assert.equal(context.bandPill('clear', 0, now - 12 * 60 * 1000, now).text, 'Clear for 12 min');
});

test('a clear report stays red through the hold, then shows intermittent, and a manual stop is not a fault', () => {
  const dom = elements();
  let now = 100000;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    INTERFERENCE_STALE_MS: 5000,
    interferenceHoldMs: 30000,
    INTERFERENCE_BURST_MS: 5 * 60 * 1000,
    liveStatusStartedAt: now,
    connection: { status: { connected: true }, offline: false },
    latestByName: {},
    state: { counts: { ITDETECTSTATUS: 3 }, lastDetection: null, interferenceHistory: [], testSatellites: [], satelliteViewHistory: [] },
    BANDS: [{ id: 'L1' }, { id: 'L2' }],
    detectionBands: (signal) => [signal],
    buildSatelliteList: () => [],
    timeAgo: () => '0s ago',
    formatTimestamp: () => '13:30',
    detectionTypeLabel: (type) => type,
    dateFormatter: () => ({ format: () => '13:30:00' }),
    constellationColor: () => '#fff',
    cell: (row, text) => row.insertCell(text),
    document: { createElement: () => ({ style: {} }), createTextNode: (text) => ({ text }) },
    $: dom.$,
  });
  load(browserCode, 'function interferenceIsLive(', 'function renderCounts(', context);
  context.renderSatelliteViewPlot = () => {};
  context.latestByName.ITDETECTSTATUS = {
    crcValid: true, receivedAt: new Date(now).toISOString(), data: { detections: [{ signalType: 'L2' }] },
  };
  context.renderVerdict();
  assert.equal(dom.elements.get('it-verdict').textContent, 'Jamming detected on L2');
  now += 2000;
  context.latestByName.ITDETECTSTATUS = {
    crcValid: true, receivedAt: new Date(now).toISOString(), data: { detections: [] },
  };
  context.state.interferenceHistory = [
    { t: now - 1000, count: 1 },
    { t: now, count: 0 },
  ];
  context.renderVerdict();
  assert.equal(dom.elements.get('it-banner').className, 'banner alarm');
  assert.match(dom.elements.get('it-verdict').textContent, /Jamming detected on L2/);
  now += 30000;
  context.latestByName.ITDETECTSTATUS.receivedAt = new Date(now).toISOString();
  context.renderVerdict();
  assert.equal(dom.elements.get('it-banner').className, 'banner intermittent');
  assert.match(dom.elements.get('it-verdict').textContent, /Intermittent interference/);
  assert.match(dom.elements.get('it-verdict').textContent, /% of reports in last 5 min/);
  context.state.interferenceHistory = [];
  context.state.lastJamAt = now - 6 * 60 * 1000;
  context.state.lastDetection = null;
  context.latestByName.ITDETECTSTATUS.receivedAt = new Date(now).toISOString();
  context.renderVerdict();
  assert.equal(dom.elements.get('it-verdict').textContent, 'No interference detected');
  context.connection.status = {
    connected: false, manualStop: { at: now, clientIp: '192.168.1.20' },
  };
  now += 6000;
  context.renderVerdict();
  assert.equal(dom.elements.get('it-banner').className, 'banner manual-stop');
  assert.match(dom.elements.get('it-detail').textContent, /Monitoring stopped manually at 13:30 from 192\.168\.1\.20/);
  assert.doesNotMatch(dom.elements.get('it-verdict').textContent, /Device disconnected/);
});

test('connection changes are refused off-box unless remote control is enabled', () => {
  const context = vm.createContext({ config: { allowRemoteControl: false } });
  load(serverCode, 'function clientAddress(', 'const server = http.createServer', context);
  const local = { socket: { remoteAddress: '127.0.0.1' } };
  const mapped = { socket: { remoteAddress: '::ffff:127.0.0.1' } };
  const v6 = { socket: { remoteAddress: '::1' } };
  const lan = { socket: { remoteAddress: '192.168.1.50' } };
  assert.equal(context.controlAllowed(local), true);
  assert.equal(context.controlAllowed(mapped), true);
  assert.equal(context.controlAllowed(v6), true);
  assert.equal(context.controlAllowed(lan), false);
  const res = { status: 0, body: '', writeHead(code) { this.status = code; return this; }, end(body) { this.body = body; } };
  assert.equal(context.rejectRemoteControl(lan, res), true);
  assert.equal(res.status, 403);
  assert.match(res.body, /only accepted from this computer/);
  context.config.allowRemoteControl = true;
  assert.equal(context.controlAllowed(lan), true);
  assert.equal(context.rejectRemoteControl(lan, res), false);
});

test('position readout goes stale and a fixed RTK solution stays distinct from single', () => {
  const context = vm.createContext({
    latestByName: {},
    POSITION_TYPE_TEXT: {
      NARROW_INT: ['RTK fixed, narrow-lane', 'fixed', '~1 cm'],
      SINGLE: ['Autonomous single-point', 'single', '~1.5 m'],
    },
    positionShortLabel: (type) => (type === 'NARROW_INT' ? 'RTK fixed' : 'Single point'),
  });
  load(browserCode, 'function positionReadout(', 'function setTabDot(', context);
  const now = 500000;
  assert.equal(context.positionReadout(now).text, 'Position: waiting');
  context.latestByName.BESTPOS = {
    receivedAt: new Date(now - 12000).toISOString(),
    data: { solutionStatus: 'SOL_COMPUTED', positionType: 'NARROW_INT', satellitesUsed: 28 },
  };
  assert.match(context.positionReadout(now).text, /stale/);
  assert.equal(context.positionReadout(now).level, 'bad');
  context.latestByName.BESTPOS.receivedAt = new Date(now - 1000).toISOString();
  const fixed = context.positionReadout(now);
  assert.equal(fixed.level, 'ok');
  assert.match(fixed.text, /RTK fixed · 28 sats/);
  context.latestByName.BESTPOS.data.positionType = 'SINGLE';
  assert.equal(context.positionReadout(now).level, 'bad');
});

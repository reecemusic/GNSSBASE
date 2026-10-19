'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { History } = require('../src/history');

const browserCode = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const serverCode = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

test('profile-managed TCP connections request interference reports every second on each connection', () => {
  const { EventEmitter } = require('node:events');
  const writes = [];
  const socket = new EventEmitter();
  socket.setKeepAlive = () => {};
  socket.setTimeout = () => {};
  socket.write = (command) => writes.push(command);
  const context = vm.createContext({
    Buffer, clearTimeout, setTimeout, module: { exports: {} },
    require: (name) => name === 'node:net'
      ? { createConnection: () => socket }
      : name === './novatel' ? require('../src/novatel') : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/receiver.js'), 'utf8'), context);
  const receiver = new context.module.exports.ReceiverClient({
    transport: 'tcp', receiverHost: '127.0.0.1', receiverPort: 3001,
    idleTimeoutMs: 30000, sendLogCommands: false,
    ephemerisLogCommands: ['LOG GPSEPHEMA ONALL'],
  });
  for (let connection = 0; connection < 2; connection++) {
    receiver.connect();
    socket.emit('connect');
  }
  assert.deepEqual(writes, [
    'LOG GPSEPHEMA ONALL\r\n', 'LOG ITDETECTSTATUSA ONTIME 1\r\n',
    'LOG GPSEPHEMA ONALL\r\n', 'LOG ITDETECTSTATUSA ONTIME 1\r\n',
  ]);
  assert(!writes.some((command) => command.includes('UNLOGALL')));
});

function loadFunctions(code, start, end, context) {
  vm.runInContext(code.slice(code.indexOf(start), code.indexOf(end)), context);
}

function historyContext() {
  const context = vm.createContext({
    Date,
    MAX_INTERFERENCE_SAMPLES: 10000,
    MAX_TRACK_SAMPLES: 1081,
    state: { windowMinutes: 60, interferenceHistory: [], tracks: {} },
    isValidSkyPosition: () => true,
  });
  loadFunctions(browserCode, 'function pruneClientHistory()', '// --- interference timeline', context);
  return context;
}

test('browser history stays bounded under sustained input and expires old samples', () => {
  const context = historyContext();
  const now = Date.now();
  context.state.interferenceHistory = Array.from({ length: 100000 }, (_, index) => ({ t: now, index }));
  context.pruneClientHistory();
  assert.equal(context.state.interferenceHistory.length, 10000);
  assert.equal(context.state.interferenceHistory[0].index, 90000);
  for (let index = 0; index < 25000; index++) {
    context.recordLiveHistory({ name: 'ITDETECTSTATUS', data: { detections: [] } });
  }
  assert.equal(context.state.interferenceHistory.length, 10000);
  context.state.interferenceHistory[0].t = now - 7200000;
  context.pruneClientHistory();
  assert.equal(context.state.interferenceHistory.length, 9999);
});

test('satellite history retains its seed and limits loaded tracks', () => {
  const context = historyContext();
  const record = { name: 'SATVIS2', data: { system: 'GPS', satellites: [{ prn: 1, elevation: 20, azimuth: 30 }] } };
  context.recordLiveHistory(record);
  context.pruneClientHistory();
  context.recordLiveHistory(record);
  assert.equal(context.state.tracks['GPS:1'].length, 1);
  context.state.tracks['GPS:1'] = Array.from({ length: 10000 }, () => ({ t: Date.now() }));
  context.pruneClientHistory();
  assert.equal(context.state.tracks['GPS:1'].length, 1081);
});

test('rendering coalesces input, bounds queues and skips inactive panels', () => {
  const renders = [];
  let tab = 'overview';
  const context = vm.createContext({
    document: { hidden: false, querySelector: () => ({ dataset: { tab } }) },
    state: { satvis: {} }, latestByName: {}, dirtyRecords: new Set(),
    countsDirty: false, ephemerisDirty: false, pendingRaw: [], pendingInterference: [],
  });
  for (const name of ['renderCounts', 'renderBestPos', 'renderBestGnssPos', 'renderSkyplot',
    'renderRange', 'renderRxStatus', 'renderVersion', 'renderEphemeris', 'renderItDetect',
    'renderTimeline', 'appendItRow', 'appendRawRow', 'registerFilterOption']) {
    context[name] = () => renders.push(name);
  }
  loadFunctions(browserCode, 'function queueRecord(', 'function renderStatus(', context);
  loadFunctions(browserCode, 'function applyRecord(', '// --- renderers', context);
  for (let index = 0; index < 100000; index++) {
    context.applyRecord({ name: 'BESTPOS', data: { index } });
    context.queueRecord(context.pendingRaw, { name: 'BESTPOS' }, 300);
    context.queueRecord(context.pendingInterference, { name: 'ITDETECTSTATUS' }, 50);
  }
  assert.equal(context.pendingRaw.length, 300);
  assert.equal(context.pendingInterference.length, 50);
  assert.equal(context.dirtyRecords.size, 1);
  context.flushUpdates();
  assert(!renders.includes('renderBestPos'));
  tab = 'position';
  context.flushUpdates(true);
  assert.equal(renders.filter((name) => name === 'renderBestPos').length, 1);
  context.document.hidden = true;
  context.flushUpdates(true);
  assert.equal(renders.filter((name) => name === 'renderBestPos').length, 1);
});

test('slow stream clients are evicted without affecting healthy clients', () => {
  const slow = { writableLength: 300000, destroy() { this.destroyed = true; } };
  const fast = { writableLength: 0, write() { this.wrote = true; } };
  const context = vm.createContext({ clients: new Set([slow, fast]) });
  loadFunctions(serverCode, 'function broadcast(', 'function snapshot(', context);
  context.broadcast('message', { ok: true });
  assert(slow.destroyed);
  assert(fast.wrote);
  assert.equal(context.clients.size, 1);
});

test('receiver identity updates without rendering the hidden health table', () => {
  const header = { textContent: '' };
  const context = vm.createContext({
    $: () => header,
    state: { satvis: {} }, latestByName: {}, dirtyRecords: new Set(),
    registerFilterOption() {},
  });
  loadFunctions(browserCode, 'function applyRecord(', '// --- renderers', context);
  loadFunctions(browserCode, 'function renderVersionSummary(', '// --- interference bands', context);
  context.applyRecord({ name: 'VERSION', data: { components: [{ model: 'PwrPak', softwareVersion: '1', serialNumber: '123' }] } });
  assert(header.textContent.includes('PwrPak'));
  assert(header.textContent.includes('123'));
});

test('server pruning enforces the sample limit on restored history', () => {
  const history = new History({ retentionMs: 3600000, trackSampleMs: 20000, maxInterferenceSamples: 50 });
  history.interference = Array.from({ length: 500 }, (_, index) => ({ t: Date.now(), index }));
  history.prune();
  assert.equal(history.interference.length, 50);
  assert.equal(history.interference[0].index, 450);
});

test('timeline displacement is linear in dBm, bounded, and excludes unknown power', () => {
  const context = vm.createContext({ TIMELINE: { top: 12, minPower: -130, maxPower: -70 } });
  loadFunctions(browserCode, 'function timelinePowerY(', 'function renderTimeline(', context);
  const weak = context.timelinePowerY(-130, 0, 120);
  const medium = context.timelinePowerY(-100, 0, 120);
  const strong = context.timelinePowerY(-70, 0, 120);
  assert(strong < medium && medium < weak);
  assert(Math.abs((weak - medium) - (medium - strong)) < 1e-9);
  assert.equal(context.timelinePowerY(-200, 0, 120), weak);
  assert.equal(context.timelinePowerY(0, 0, 120), strong);
  assert.equal(context.timelinePowerY(null, 0, 120), null);
  assert.equal(context.timelinePowerY(NaN, 0, 120), null);
  assert(Math.abs(context.timelinePowerY(-100, 1, 120) - medium - 120) < 1e-9);
});

test('timeline status bar separates clear, weak, moderate and strong reports', () => {
  const context = vm.createContext({});
  loadFunctions(browserCode, 'function timelineStatus(', 'function timelineMarkers(', context);
  assert.equal(context.timelineStatus({ count: 0, maxPower: null }).className, 'tl-status-clear');
  assert.equal(context.timelineStatus({ count: 1, maxPower: -115 }).className, 'tl-status-weak');
  assert.equal(context.timelineStatus({ count: 1, maxPower: -100 }).className, 'tl-status-moderate');
  assert.equal(context.timelineStatus({ count: 1, maxPower: -90 }).className, 'tl-status-strong');
  assert.equal(context.timelineStatus({ count: 1, maxPower: null }).className, 'tl-status-unknown');
  assert.equal(context.timelineStatus({ count: 1, maxPower: -95 }).className, 'tl-status-moderate');
  assert.equal(context.timelineStatus({ count: 1, maxPower: -110 }).className, 'tl-status-weak');
  assert.equal(context.timelineStatus({ count: 0, maxPower: -80 }).label, 'Clear report');
  assert.equal(context.timelineStatus({ count: 1, maxPower: null }).label, 'Power unknown');
});

test('power lines join detections but break at clear, unknown and missing reports', () => {
  const context = vm.createContext({
    TIMELINE: { top: 12, left: 120, minPower: -130, maxPower: -70 },
    classifyBand: () => 'L1',
  });
  loadFunctions(browserCode, 'function timelinePowerY(', 'function renderTimeline(', context);
  const sample = (t, count = 1, maxPower = -100) => ({ t, count, maxPower, signal: 'L1' });
  const reports = [sample(0), sample(1000, 1, -90), sample(2000, 0), sample(3000),
    sample(4000, 1, null), sample(5000), sample(25000)];
  const markers = context.timelineMarkers(reports, ['L1'], 0, 30000, 300);
  const paths = context.timelineLinePaths(markers, 120);
  assert.equal(paths.length, 2);
  const moderatePath = paths.find((path) => path.className === 'tl-status-moderate');
  const strongPath = paths.find((path) => path.className === 'tl-status-strong');
  assert.equal((moderatePath.d.match(/M/g) || []).length, 4);
  assert.equal((moderatePath.d.match(/L/g) || []).length, 0);
  assert.equal((strongPath.d.match(/M/g) || []).length, 1);
  assert.equal((strongPath.d.match(/L/g) || []).length, 1);
  const dense = Array.from({ length: 10000 }, (_, index) => sample(index, 1, index % 2 ? -80 : -110));
  const bounded = context.timelineMarkers(dense, ['L1'], 0, 10000, 100);
  assert.equal(bounded.size, 100);
  assert([...bounded.values()].every((marker) => marker.sample.maxPower === -80));
  const subpixelGap = [sample(0), sample(10, 0), sample(20), sample(1000)];
  const gapPaths = context.timelineLinePaths(context.timelineMarkers(subpixelGap, ['L1'], 0, 10000, 100), 120);
  assert.equal((gapPaths.find((path) => path.className === 'tl-status-moderate').d.match(/M/g) || []).length, 2);
});

test('timeline zoom and pan stay within retained history and can follow live time', () => {
  const context = vm.createContext({ state: { windowMinutes: 60 }, renderTimeline() {} });
  loadFunctions(browserCode, 'function timelineViewport(', 'function initTimelineControls(', context);
  const now = Date.now();
  assert.equal(context.timelineViewport(now).windowMs, 3600000);
  context.setTimelineViewport(60000, now - 120000, now);
  assert.equal(context.timelineViewport(now).end, now - 120000);
  context.setTimelineViewport(1, now + 10000, now);
  assert.equal(context.timelineViewport(now).windowMs, 10000);
  assert.equal(context.timelineViewport(now).end, now);
  context.setTimelineViewport(60000, now - 7200000, now);
  assert.equal(context.timelineViewport(now).start, now - 3600000);
  context.setTimelineViewport(60000, null, now);
  assert.equal(context.timelineViewport(now + 1000).end, now + 1000);
  context.state.timelineView = null;
  context.zoomTimeline(0.5);
  assert.equal(context.state.timelineView.windowMs, 1800000);
});

test('timeline controls support wheel zoom, dragging, cursor inspection and live reset', () => {
  const elements = new Map();
  const element = () => ({
    handlers: {}, children: [], style: {}, attributes: {}, textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 488 }),
    viewBox: { baseVal: { width: 900, height: 488 } },
    setPointerCapture() {},
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const context = vm.createContext({
    state: {
      windowMinutes: 60, timeZone: 'Asia/Dubai',
      interferenceHistory: [{ t: Date.now() - 1800000, signal: 'L1', count: 1, maxPower: -88.25 }],
    },
    $: get, classifyBand: () => 'L1', renderSpectrumPlots() {},
    svg: (tag, attrs, text) => Object.assign(element(), { tag, attributes: attrs, textContent: text }),
    powerColour: () => '#ff5f56',
    formatWindow: (minutes) => `${minutes} min`,
  });
  loadFunctions(browserCode, 'const TIMELINE =', 'function timelineViewport(', context);
  loadFunctions(browserCode, 'function timelineViewport(', 'const SPECTRUM_PLOTS =', context);
  loadFunctions(browserCode, 'function timelineTimeLabel(', 'function powerColour(', context);
  loadFunctions(browserCode, 'function formatTimestamp(', 'function initTimeZone(', context);
  context.initTimelineControls();
  context.renderTimeline();
  const chart = get('timeline');
  const labels = chart.children.filter((child) => child.tag === 'text').map((child) => child.textContent);
  for (const band of ['L1', 'L2', 'L5']) {
    assert(labels.includes(`${band} · Power (dBm)`));
  }
  assert.equal(labels.filter((label) => label === 'Status').length, 3);
  assert.equal(labels.filter((label) => label.includes('Interference status')).length, 0);
  for (const label of ['-130', '-110', '-90', '-70']) {
    assert(labels.includes(label));
  }
  assert.equal(chart.children.filter((child) => child.attributes.class === 'tl-status-lane').length, 3);
  const powerPoint = chart.children.find((child) => child.attributes.class === 'tl-status-strong tl-power-point');
  const statusPoint = chart.children.find((child) => child.attributes.class === 'tl-status-strong tl-status-marker');
  const powerTrace = chart.children.find((child) => child.tag === 'path');
  assert.equal(powerTrace.attributes.class, 'tl-status-strong tl-power-line');
  assert(powerPoint.attributes.cy < statusPoint.attributes.y);
  get('timeline-zoom-in').handlers.click();
  assert.equal(context.state.timelineView.windowMs, 1800000);
  let prevented = false;
  chart.handlers.wheel({ clientX: 489, clientY: 50, deltaY: -1, preventDefault() { prevented = true; } });
  assert(prevented);
  assert.equal(context.state.timelineView.windowMs, 1440000);
  const beforeDrag = context.state.timelineView.end;
  chart.handlers.pointerdown({ button: 0, pointerId: 1, clientX: 200, clientY: 50 });
  chart.handlers.pointermove({ pointerId: 1, clientX: 300, clientY: 50 });
  chart.handlers.pointerup({});
  assert(context.state.timelineView.end < beforeDrag);
  get('timeline-live').handlers.click();
  assert.equal(context.state.timelineView, null);
  get('timeline-cursor').handlers.click();
  assert.equal(get('timeline-cursor').attributes['aria-pressed'], 'true');
  const sample = context.state.interferenceHistory[0];
  const view = context.timelineViewport();
  const x = 168 + (sample.t - view.start) / view.windowMs * 716;
  chart.handlers.click({ clientX: x, clientY: 60 });
  assert.equal(context.state.timelineSelection.sample.maxPower, -88.25);
  assert.match(get('timeline-inspection').textContent, /-88.25 dBm/);
  assert.match(get('timeline-inspection').textContent, /GMT\+4/);
  assert(chart.children.some((child) => child.attributes.class === 'tl-cursor-line'));
  chart.handlers.click({ clientX: x, clientY: 202 });
  assert.equal(context.state.timelineSelection.sample.maxPower, -88.25);
  assert.equal(context.timelineStatusY(1, 180) - context.timelineStatusY(0, 180), 180);
  assert(context.timelineStatusY(0, 180) > context.timelinePowerY(-130, 0, 180));
  assert(context.timelineStatusY(0, 180) < 32 + 180 - 12);
  for (const [count, maxPower, expected] of [
    [1, null, /Power unknown/], [0, null, /Clear report \(no measured power\)/],
  ]) {
    context.state.interferenceHistory[0] = { ...sample, count, maxPower };
    context.renderTimeline();
    chart.handlers.click({ clientX: x, clientY: 60 });
    assert.match(get('timeline-inspection').textContent, expected);
    assert(!get('timeline-inspection').textContent.includes('null dBm'));
  }
  context.state.interferenceHistory[0] = sample;
  context.renderTimeline();
  chart.handlers.click({ clientX: x, clientY: 60 });
  chart.handlers.click({ clientX: 100, clientY: 60 });
  assert.match(get('timeline-inspection').textContent, /No report near this position/);
  context.state.timeZone = 'UTC';
  context.renderTimeline();
  assert.match(get('timeline-inspection').textContent, /GMT/);
  assert(!get('timeline-inspection').textContent.includes('GMT+4'));
  get('timeline-live').handlers.click();
  assert.equal(context.state.timelineSelection, null);
  assert.equal(get('timeline-mode').textContent, 'Live');
});

test('selected time zone formats UAE rollover, UTC and daylight saving consistently', () => {
  const context = vm.createContext({ state: { timeZone: 'Asia/Dubai' } });
  loadFunctions(browserCode, 'function timelineTimeLabel(', 'function powerColour(', context);
  loadFunctions(browserCode, 'function formatTime(record)', 'function initTimeZone(', context);
  const timestamp = '2026-10-19T22:30:15.125Z';
  assert.equal(context.timelineTimeLabel(Date.parse(timestamp), 3600000), '02:30');
  assert.equal(context.timelineTimeLabel(Date.parse(timestamp), 10000), '02:30:15');
  assert.match(context.formatTimestamp(timestamp, true), /20\/10\/2026/);
  assert.match(context.formatTimestamp(timestamp, true), /02:30:15\.125 GMT\+4/);
  assert.match(context.formatTime({ header: { utc: timestamp } }), /02:30:15 GMT\+4/);
  context.state.timeZone = 'UTC';
  assert.equal(context.timelineTimeLabel(Date.parse(timestamp), 3600000), '22:30');
  context.state.timeZone = 'America/New_York';
  assert.match(context.formatTimestamp('2026-07-01T12:00:00Z'), /08:00:00 GMT-4/);
  assert.match(context.formatTimestamp('2026-12-01T12:00:00Z'), /07:00:00 GMT-5/);
});

test('time zone selector defaults to UAE and persists changes', () => {
  assert.match(browserCode, /timeZone: localStorage.getItem\('timeZone'\) \|\| 'Asia\/Dubai'/);
  const select = {
    options: [{ value: 'Asia/Dubai' }, { value: 'UTC' }],
    append(option) { this.options.push(option); },
    addEventListener(name, handler) { this.change = handler; },
  };
  const saved = {};
  const row = { dataset: { timestamp: '2026-10-19T12:00:00Z' } };
  const context = vm.createContext({
    state: { timeZone: 'Asia/Dubai' }, latestByName: {},
    $: () => select, localStorage: { setItem: (key, value) => { saved[key] = value; } },
    document: { createElement: () => ({}), querySelectorAll: () => [row] },
    renderCounts() {}, renderEphemeris() {}, renderTimeline() {},
  });
  loadFunctions(browserCode, 'function formatTimestamp(', '// Refresh elapsed-time', context);
  context.initTimeZone();
  assert.equal(select.value, 'Asia/Dubai');
  select.value = 'UTC';
  select.change();
  assert.equal(saved.timeZone, 'UTC');
  assert.equal(context.state.timeZone, 'UTC');
  assert.match(row.textContent, /12:00:00 GMT/);
});

test('GNSS frequency plots share the timeline window and show horizontal allocations and timed detections', () => {
  const element = () => ({
    children: [], style: { properties: {}, setProperty(name, value) { this.properties[name] = value; } },
    attributes: {}, handlers: {}, className: '', textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    getBoundingClientRect: () => ({ width: 900 }),
  });
  const container = element();
  const now = 1060000;
  const saved = {};
  let renders = 0;
  const context = vm.createContext({
    TIMELINE: { left: 68, right: 12 },
    state: {
      hiddenSignals: new Set(),
      interferenceHistory: [
        {
          t: 1030000, signal: 'B3', count: 1, maxPower: -85,
          detections: [{ freq: 1270e6, bandwidth: 18e6, power: -85 }],
        },
        {
          t: 1030000, signal: 'L5', count: 1, maxPower: -85,
          detections: [{ freq: 1176.45e6, bandwidth: 20.46e6, power: -85 }],
        },
        {
          t: 1060001, signal: 'L5', count: 1, maxPower: -85,
          detections: [{ freq: 1176.45e6, bandwidth: 20.46e6, power: -85 }],
        },
      ],
    },
    $: () => container,
    document: { createElement: () => element(), createTextNode: (text) => ({ textContent: text }) },
    svg: (tag, attributes = {}, text) => Object.assign(element(), { tag, attributes, textContent: text || '' }),
    utcLabel: (timestamp) => `t${timestamp}`,
    initTimePlotNavigation() {},
    localStorage: { setItem: (key, value) => { saved[key] = value; } },
    renderTimeline() { renders++; context.renderSpectrumPlots(1000000, now, 60000); },
  });
  loadFunctions(browserCode, 'const SPECTRUM_PLOTS =', 'function utcLabel(', context);
  context.renderSpectrumPlots(1000000, now, 60000);

  const sections = container.children.filter((child) => child.className === 'spectrum-chart');
  assert.deepEqual(sections.map((section) => section.children[0].textContent), [
    'L1 / E1 / B1 / G1', 'L2 / G2 / B3', 'L5 / E5 / B2',
  ]);
  const buttons = sections.flatMap((section) => section.children[1].children);
  const legendNames = buttons.map((item) => item.children[1]?.textContent);
  assert(legendNames.includes('GPS L1 C/A'));
  assert(legendNames.includes('GPS L1C'));
  assert(legendNames.includes('Galileo E1'));
  const legendColor = (name) => buttons.find((item) => item.children[1]?.textContent === name)
    .style.properties['--signal-color'];
  for (const section of sections) {
    const colors = section.children[1].children.map((button) => button.style.properties['--signal-color']);
    assert.equal(new Set(colors).size, colors.length, 'Each signal in a plot has a unique colour');
  }
  assert.match(sections[1].children[0].children[0].textContent, /1 hit/);
  assert(sections[1].children.find((child) => child.tag === 'svg').children
    .some((child) => child.attributes.class === 'spectrum-detection'));
  const l5Chart = sections[2].children.find((child) => child.tag === 'svg');
  const detection = l5Chart.children.find((child) => child.attributes.class === 'spectrum-detection');
  assert.equal(detection.attributes.x, 476);
  assert(detection.attributes.height > 3);
  assert.equal(detection.attributes.width, 4);
  assert.match(detection.children[0].textContent, /1176\.450 MHz, 20\.460 MHz bandwidth/);
  const allocation = l5Chart.children.find((child) => child.attributes.class === 'spectrum-signal'
    && child.children[0].textContent.startsWith('GPS L5C:'));
  assert.equal(allocation.attributes.x, 68);
  assert.equal(allocation.attributes.width, 820);
  assert.equal(allocation.attributes.fill, legendColor('GPS L5C'));
  assert(allocation.attributes.height < allocation.attributes.width);
  const timeLabels = l5Chart.children.filter((child) => child.attributes.class === 'spectrum-axis');
  assert.equal(timeLabels[0].textContent, 't1000000');
  assert.equal(timeLabels[timeLabels.length - 1].textContent, `t${now}`);
  assert(sections[2].children[0].children[0].textContent.includes('1 hit'));
  const centreLines = l5Chart.children.filter((child) => child.attributes.class === 'spectrum-centre-line');
  assert.equal(centreLines.length, 6);
  const gpsCentre = centreLines.find((line) => line.children[0].textContent.startsWith('GPS L5C centre:'));
  assert.equal(gpsCentre.attributes.x1, 68);
  assert.equal(gpsCentre.attributes.x2, 888);
  assert(Math.abs(gpsCentre.attributes.y1 - (18 + (1215 - 1176.45) / 51 * 220)) < 1e-9);
  assert.equal(gpsCentre.attributes.y1, gpsCentre.attributes.y2);
  assert.equal(gpsCentre.attributes.stroke, legendColor('GPS L5C'));
  assert.equal(gpsCentre.attributes['stroke-dasharray'], '6 34');
  assert.match(gpsCentre.children[0].textContent, /1176\.450 MHz/);
  const sharedCentres = centreLines.filter((line) => line.attributes.y1 === gpsCentre.attributes.y1);
  assert.equal(sharedCentres.length, 4);
  assert.equal(new Set(sharedCentres.map((line) => line.attributes['stroke-dashoffset'])).size, 4);
  const l5Stripes = l5Chart.children.filter((child) => child.attributes.class === 'spectrum-signal');
  for (let i = 0; i < l5Stripes.length; i++) {
    for (let j = i + 1; j < l5Stripes.length; j++) {
      const a = l5Stripes[i].attributes;
      const b = l5Stripes[j].attributes;
      assert(Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) < 1e-9, 'Stripes must not obscure each other');
    }
  }
  const toggle = buttons.find((button) => button.children[1]?.textContent === 'GPS L5C');
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  toggle.handlers.click();
  assert(context.state.hiddenSignals.has('GPS L5C'));
  assert.deepEqual(JSON.parse(saved.hiddenSignals), ['GPS L5C']);
  assert.equal(toggle.attributes['aria-pressed'], 'false');
  assert(!l5Chart.children.some((child) => child.children[0]?.textContent.startsWith('GPS L5C:')));
  assert(l5Chart.children.some((child) => child.attributes.class === 'spectrum-detection'));
  assert.equal(sections[2].children.find((child) => child.tag === 'svg'), l5Chart, 'Keep the SVG during drag and toggles');
  toggle.handlers.click();
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  assert.equal(renders, 2);
  for (const button of buttons) {
    if (button.attributes['aria-pressed'] === 'true') button.handlers.click();
  }
  assert(l5Chart.children.some((child) => child.attributes.class === 'spectrum-detection'));
  assert(!l5Chart.children.some((child) => child.attributes.class === 'spectrum-signal'));
  assert(!l5Chart.children.some((child) => child.attributes.class === 'spectrum-centre-line'));
  context.renderSpectrumPlots(1040000, now, 20000);
  assert(!l5Chart.children.some((child) => child.attributes.class === 'spectrum-detection'));
});

test('linked plot navigation clamps history and zoom and handles drag cancellation', () => {
  const now = Date.now();
  let renders = 0;
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      handlers: {}, viewBox: { baseVal: { width: 900 } }, classList: { add() {}, remove() {} },
      getBoundingClientRect: () => ({ left: 0, width: 900 }),
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setPointerCapture(id) { this.capture = id; },
      hasPointerCapture(id) { return this.capture === id; },
      releasePointerCapture() { this.capture = null; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    state: { windowMinutes: 60 }, TIMELINE: { left: 68, right: 12 },
    $: get, renderTimeline() { renders++; },
  });
  loadFunctions(browserCode, 'function timelineViewport(', 'function timelinePowerY(', context);
  context.initTimelineControls();
  const chart = get('frequency');
  context.initTimePlotNavigation(chart);
  get('timeline-zoom-in').handlers.click();
  assert.equal(context.timelineViewport().windowMs, 1800000);
  const before = context.timelineViewport();
  const anchor = before.start + before.windowMs / 4;
  let prevented = false;
  chart.handlers.wheel({ clientX: 273, deltaY: -1, preventDefault() { prevented = true; } });
  assert(prevented);
  const after = context.timelineViewport();
  assert.equal(after.windowMs, 1440000);
  assert.equal(after.start + after.windowMs / 4, anchor);
  const originalEnd = after.end;
  chart.handlers.pointerdown({ button: 0, clientX: 273, pointerId: 7 });
  chart.handlers.pointermove({ clientX: 355, pointerId: 7 });
  assert.equal(context.timelineViewport().end, originalEnd - after.windowMs / 10);
  chart.handlers.pointercancel({ pointerId: 7 });
  const cancelledEnd = context.timelineViewport().end;
  chart.handlers.pointermove({ clientX: 400, pointerId: 7 });
  assert.equal(context.timelineViewport().end, cancelledEnd);
  assert.equal(chart.capture, null);
  for (let i = 0; i < 20; i++) get('timeline-zoom-in').handlers.click();
  assert.equal(context.timelineViewport().windowMs, 10000);
  context.setTimelineView(now + 3600000, 60000);
  assert.equal(context.timelineViewport().end, now);
  context.setTimelineView(now - 7200000, 60000);
  assert.equal(context.timelineViewport().start, now - 3600000);
  for (let i = 0; i < 20; i++) get('timeline-zoom-out').handlers.click();
  assert.equal(context.timelineViewport().windowMs, 3600000);
  get('timeline-live').handlers.click();
  assert.equal(context.state.timelineView, null);
  assert(renders > 0);
});

test('power chart plots measured power only, preserves gaps and shares its exact viewport', () => {
  const now = Date.now();
  const element = (tag, attributes = {}, textContent = '') => ({
    tag, attributes, textContent, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect: () => ({ width: 900 }),
  });
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element('svg'));
    return elements.get(id);
  };
  let spectrumView;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    state: {
      windowMinutes: 60,
      timelineView: { end: now, windowMs: 60000 },
      interferenceHistory: [
        { t: now - 60001, signal: 'L1', count: 1, maxPower: -80 },
        { t: now - 50000, signal: 'L1', count: 1, maxPower: -120 },
        { t: now - 45000, signal: 'L1', count: 1, maxPower: -90 },
        { t: now - 44999, signal: 'ALL', count: 0, maxPower: null },
        { t: now - 44000, signal: 'L1', count: 1, maxPower: -85 },
        { t: now - 40000, signal: 'ALL', count: 0, maxPower: null },
        { t: now - 35000, signal: 'L1', count: 1, maxPower: -100 },
        { t: now - 30000, signal: 'L1', count: 1, maxPower: null },
        { t: now - 25000, signal: 'L1', count: 1, maxPower: -80 },
        { t: now - 5000, signal: 'L1', count: 1, maxPower: -70 },
        { t: now + 1, signal: 'L1', count: 1, maxPower: -80 },
      ],
    },
    $: get, svg: element,
    classifyBand: (signal) => signal,
    renderSpectrumPlots(...view) { spectrumView = view; },
    utcLabel: (time) => `t${time}`,
  });
  loadFunctions(browserCode, 'const TIMELINE =', 'const SPECTRUM_PLOTS =', context);
  loadFunctions(browserCode, 'function powerColour(', 'function formatWindow(', context);
  context.renderTimeline();
  assert.deepEqual(spectrumView, [now - 60000, now, 60000]);
  const chart = get('timeline');
  const points = chart.children.filter((child) => child.tag === 'circle');
  assert.equal(points.length, 6, 'Clear, unknown, expired and future reports are not measured points');
  const lines = chart.children.filter((child) => child.attributes.class === 'tl-power-line');
  assert.equal(lines.length, 1, 'Clear, unknown and long gaps break the trace, even when clear is merged into a pixel');
  assert.equal(lines[0].attributes.x1, points[0].attributes.cx);
  assert.equal(lines[0].attributes.x2, points[1].attributes.cx);
  assert(points[0].attributes.cy > points[1].attributes.cy);
  assert.equal(get('timeline-mode').textContent, 'Historical view');
  const titles = chart.children.flatMap((child) => child.children.map((title) => title.textContent));
  assert(titles.some((title) => title.includes('Clear (no measured power)')));
  assert(titles.some((title) => title.includes('Power unknown')));
});

test('clicking a timeline report zooms in with that report centered', () => {
  const context = vm.createContext({ state: { windowMinutes: 60 }, renderTimeline() {} });
  loadFunctions(browserCode, 'function timelineViewport(', 'function initTimelineControls(', context);
  const now = Date.now();
  context.zoomTimelineToReport(now - 1800000);
  const view = context.timelineViewport(now);
  assert.equal(view.windowMs, 1800000);
  assert.equal(view.start + view.windowMs / 2, now - 1800000);
});

test('wall display does not treat stale or disconnected interference data as live', () => {
  const context = vm.createContext({ state: { receiverConnected: true, streamConnected: true } });
  loadFunctions(browserCode, 'function interferenceIsLive(', 'function renderVerdict(', context);
  const now = Date.now();
  const record = { receivedAt: new Date(now).toISOString() };
  assert.equal(context.interferenceIsLive(record, now), true);
  assert.equal(context.interferenceIsLive(record, now + 3000), true);
  assert.equal(context.interferenceIsLive(record, now + 3001), false);
  assert.equal(context.interferenceIsLive(null, now), false);
  assert.equal(context.interferenceIsLive({ receivedAt: 'invalid' }, now), false);
  context.state.receiverConnected = false;
  assert.equal(context.interferenceIsLive(record, now), false);
  context.state.receiverConnected = true;
  context.state.streamConnected = false;
  assert.equal(context.interferenceIsLive(record, now), false);
});

test('band status sits below power over time and above frequency overlays', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert(html.indexOf('id="timeline"') < html.indexOf('Current band status'));
  assert(html.indexOf('Current band status') < html.indexOf('id="bands"'));
  assert(html.indexOf('id="bands"') < html.indexOf('id="spectrum-plots"'));
});

test('every band remains visible without data, when clear and during detections', () => {
  const cards = [];
  const context = vm.createContext({
    latestByName: {},
    $: () => ({ replaceChildren: () => { cards.length = 0; }, append: (card) => cards.push(card) }),
    bandStats: () => ({}),
    renderVerdict() {},
    buildBandCard: (band, group, detections, status) => ({ dataset: {}, band: band.id, title: band.title, status }),
  });
  loadFunctions(browserCode, 'const BANDS =', '/** Maps an ITDETECTSTATUS', context);
  loadFunctions(browserCode, 'function classifyBand(', '/** Detection rate, peak power', context);
  const expected = ['L1', 'L2', 'L5', 'L6', 'SBAS', 'SBAND', 'LBAND', 'OTHER'];
  context.renderBands();
  assert.deepEqual(cards.map((card) => card.band), expected);
  assert.deepEqual(cards.map((card) => card.title), [
    'L1 / E1 / B1 / G1', 'L2 / G2', 'L5 / E5 / B2', 'L6 / E6 / B3',
    'SBAS', 'S-Band', 'L-Band', 'Unclassified',
  ]);
  assert(cards.every((card) => card.status === 'unmonitored'));
  context.latestByName.ITDETECTSTATUS = { data: { detections: [] } };
  context.renderBands();
  assert.deepEqual(cards.map((card) => card.band), expected);
  assert(cards.every((card) => card.status === 'clear'));
  for (const signal of ['L1', 'L2', 'L5', 'L6', 'SBAS', 'SBAND', 'TERRASTAR', 'UNKNOWN']) {
    context.latestByName.ITDETECTSTATUS.data.detections = [{ signalType: signal, powerDbm: -85 }];
    context.renderBands();
    assert.deepEqual(cards.map((card) => card.band), expected);
    assert.equal(cards.filter((card) => card.status === 'jammed').length, 1);
  }
});

test('all-band clear reports contribute to statistics for every band', () => {
  const now = Date.now();
  const context = vm.createContext({
    state: {
      windowMinutes: 60,
      interferenceHistory: [
        { t: now - 7200000, signal: 'ALL', count: 0, maxPower: null },
        { t: now - 1000, signal: 'E5a', count: 1, maxPower: -85 },
        { t: now, signal: 'ALL', count: 0, maxPower: null },
      ],
    },
  });
  loadFunctions(browserCode, 'const BANDS =', '/** Maps an ITDETECTSTATUS', context);
  loadFunctions(browserCode, 'function classifyBand(', 'function renderBands()', context);
  loadFunctions(browserCode, 'function bandStats(', 'function buildBandCard(', context);
  const stats = context.bandStats(now);
  assert.deepEqual(Object.keys(stats).sort(), ['L1', 'L2', 'L5', 'L6', 'LBAND', 'OTHER', 'SBAND', 'SBAS'].sort());
  for (const [band, entry] of Object.entries(stats)) {
    assert.equal(entry.samples, band === 'L5' ? 2 : 1);
    assert.equal(entry.hits, band === 'L5' ? 1 : 0);
    assert.equal(entry.peak, band === 'L5' ? -85 : null);
  }
});

test('all band cards remain in the same order through clear, detection and stale reports', () => {
  const cards = [];
  const container = {
    querySelectorAll: () => [],
    replaceChildren: () => { cards.length = 0; },
    append: (card) => cards.push(card),
  };
  const context = vm.createContext({
    state: {}, latestByName: {},
    $: (id) => id === 'bands' ? container : { classList: { toggle() {} } },
    bandStats: () => ({}),
    interferenceIsLive: () => true,
    renderVerdict() {},
    buildBandCard: (band, group, detections, status) => ({
      dataset: {}, status, querySelector: () => ({}),
    }),
  });
  loadFunctions(browserCode, 'const BANDS =', '/** Maps an ITDETECTSTATUS', context);
  loadFunctions(browserCode, 'function classifyBand(', '/** Detection rate, peak power', context);
  const expected = ['L1', 'L2', 'L5', 'L6', 'SBAS', 'SBAND', 'LBAND', 'OTHER'];
  context.latestByName.ITDETECTSTATUS = { data: { detections: [] } };
  context.renderBands();
  assert.deepEqual(cards.map((card) => card.dataset.band), expected);
  assert(cards.every((card) => card.status === 'clear'));
  context.latestByName.ITDETECTSTATUS.data.detections = [{ signalType: 'TERRASTAR', powerDbm: -85 }];
  context.renderBands();
  assert.deepEqual(cards.map((card) => card.dataset.band), expected);
  assert.equal(cards.find((card) => card.dataset.band === 'LBAND').status, 'jammed');
  context.latestByName.ITDETECTSTATUS.data.detections = [];
  context.renderBands();
  assert.deepEqual(cards.map((card) => card.dataset.band), expected);
  assert(cards.every((card) => card.status === 'clear'));
  context.interferenceIsLive = () => false;
  context.renderBands();
  assert.deepEqual(cards.map((card) => card.dataset.band), expected);
  assert(cards.every((card) => card.status === 'unmonitored'));
});

test('unchanged clear reports refresh live history, time and counters without repeating recent rows', () => {
  const context = historyContext();
  const handlers = {};
  const rows = [];
  const elements = {
    'it-log': {
      children: rows,
      get firstElementChild() { return rows[0]; },
      prepend(row) { rows.unshift(row); },
    },
    'it-time': {}, 'it-total': {},
  };
  let timelineRenders = 0;
  Object.assign(context, {
    source: null, MAX_IT_ROWS: 50, MAX_RAW_ROWS: 300,
    latestByName: {}, dirtyRecords: new Set(),
    countsDirty: false, ephemerisDirty: false, pendingRaw: [], pendingInterference: [],
    document: {
      hidden: false,
      querySelector: () => ({ dataset: { tab: 'interference' } }),
      createElement: () => ({ dataset: {}, append() {} }),
    },
    EventSource: class { addEventListener(name, handler) { handlers[name] = handler; } },
    $: (id) => elements[id],
    formatTime: (record) => record.receivedAt,
    registerFilterOption() {}, renderBands() {},
    renderTimeline() { timelineRenders++; },
  });
  context.state.receiverConnected = true;
  context.state.streamConnected = true;
  loadFunctions(browserCode, 'function connectStream()', 'function renderStatus(', context);
  loadFunctions(browserCode, 'function applyRecord(', '// --- renderers', context);
  loadFunctions(browserCode, 'function renderItDetect(', '// --- interference bands', context);
  loadFunctions(browserCode, 'let lastItReportHadDetections', 'function appendRawRow(record)', context);
  loadFunctions(browserCode, 'function interferenceIsLive(', 'function renderVerdict(', context);
  context.connectStream();
  for (let count = 1; count <= 10; count++) {
    const record = {
      name: 'ITDETECTSTATUS', crcValid: true,
      receivedAt: new Date(Date.now() - (10 - count) * 1000).toISOString(),
      data: { detectionCount: 0, detections: [] },
    };
    handlers.message({ data: JSON.stringify({ record, counts: { ITDETECTSTATUS: count } }) });
    context.flushUpdates();
    assert.equal(elements['it-total'].textContent, count);
    assert.equal(elements['it-time'].textContent, record.receivedAt);
    assert.equal(context.state.interferenceHistory.length, count);
    assert.equal(context.interferenceIsLive(context.latestByName.ITDETECTSTATUS, Date.parse(record.receivedAt)), true);
    assert.equal(rows.length, 0);
  }
  assert.equal(timelineRenders, 10);
});

test('recent status reports show clear only after detections and suppress repeated clear rows', () => {
  const rows = [];
  const log = {
    children: rows,
    get firstElementChild() { return rows[0]; },
    get lastElementChild() { return rows[rows.length - 1]; },
    prepend(row) { rows.unshift(row); },
  };
  const context = vm.createContext({
    MAX_IT_ROWS: 10,
    document: { createElement: () => ({ dataset: {}, children: [], append(...children) { this.children.push(...children); } }) },
    $: () => log,
    formatTime: () => '12:00:00',
    detectionTypeLabel: () => 'Detection',
    describeDetection: () => 'details',
  });
  loadFunctions(browserCode, 'let lastItReportHadDetections', 'function appendRawRow(record)', context);

  const clear = { name: 'ITDETECTSTATUS', crcValid: true, data: { detectionCount: 0, detections: [] } };
  context.appendItRow(clear);
  context.appendItRow(clear);
  assert.equal(rows.length, 0);

  context.appendItRow({ ...clear, crcValid: false });
  context.appendItRow({ ...clear, crcValid: false });
  assert.equal(rows.length, 0);

  context.appendItRow({ name: 'ITDETECTSTATUS', crcValid: true, data: { detectionCount: 1, detections: [{ signalType: 'L1' }] } });
  context.appendItRow({ ...clear, crcValid: false });
  context.appendItRow({ ...clear, crcValid: false });
  assert.equal(rows.length, 1);
  context.appendItRow(clear);
  context.appendItRow(clear);
  assert.equal(rows.length, 2);
  assert(rows[0].children[1].children[0].textContent.startsWith('0 detections'));

  context.appendItRow(clear);
  assert.equal(rows.length, 2);

  context.appendItRow({ name: 'ITDETECTSTATUS', crcValid: true, data: { detectionCount: 2, detections: [{ signalType: 'L1' }, { signalType: 'L2' }] } });
  context.appendItRow(clear);
  assert.equal(rows.length, 4);
  context.appendItRow({ data: null });
  context.appendItRow(clear);
  assert.equal(rows.length, 4);

  context.appendItRow({ name: 'ITDETECTSTATUS', crcValid: false, data: { detectionCount: 1, detections: [{ signalType: 'L1' }] } });
  context.appendItRow(clear);
  assert.equal(rows.length, 5, 'CRC-failed detections must not create a valid clear transition');
  const listLength = rows.length;
  for (let i = 0; i < 100; i++) context.appendItRow(clear);
  assert.equal(rows.length, listLength);
});
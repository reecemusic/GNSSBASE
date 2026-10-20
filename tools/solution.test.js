'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { History, SOLUTION_HEARTBEAT_MS } = require('../src/history');

const browserCode = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function loadFunctions(code, start, end, context) {
  const first = code.indexOf(start);
  const last = code.indexOf(end, first);
  assert(first >= 0 && last > first, `slice ${start} .. ${end} not found`);
  vm.runInContext(code.slice(first, last), context);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const bestpos = (used, type = 'SINGLE', status = 'SOL_COMPUTED') => ({
  solutionStatus: status, positionType: type, satellitesUsed: used, satellitesTracked: 30,
});

test('server solution history keeps changes plus a heartbeat and survives save/load', (t) => {
  const file = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'solution-')), 'history.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const history = new History({ retentionMs: 3600000, trackSampleMs: 20000, maxInterferenceSamples: 1000, filePath: file });
  const start = Date.now() - 120000;
  for (let second = 0; second < 60; second++) {
    history.addSolution(bestpos(second < 30 ? 20 : 22), start + second * 1000);
  }
  history.addSolution(bestpos(22, 'NONE', 'INSUFFICIENT_OBS'), start + 60000);
  history.addSolution({ solutionStatus: 'SOL_COMPUTED' }, start + 61000);
  history.addSolution(null, start + 62000);
  const times = history.solution.map((s) => (s.t - start) / 1000);
  assert.deepEqual(times, [0, 10, 20, 30, 40, 50, 60], 'one sample per heartbeat until something changes');
  assert.equal(SOLUTION_HEARTBEAT_MS, 10000);
  assert.deepEqual(history.solution[6], {
    t: start + 60000, used: 22, tracked: 30, status: 'INSUFFICIENT_OBS', type: 'NONE',
  });
  assert.equal(history.since(3600000).solution.length, 7);

  history.save();
  const restored = new History({ retentionMs: 3600000, trackSampleMs: 20000, maxInterferenceSamples: 1000, filePath: file });
  restored.load();
  assert.deepEqual(restored.solution, history.solution);

  const capped = new History({ retentionMs: 3600000, maxInterferenceSamples: 5 });
  for (let i = 0; i < 20; i++) capped.addSolution(bestpos(i), Date.now() + i);
  assert.equal(capped.solution.length, 5);
  assert.equal(capped.solution[0].used, 15);
});

test('browser solution runs merge repeats, break on lost output and map fix tiers', () => {
  const context = vm.createContext({
    POSITION_TYPE_TEXT: { SINGLE: ['', 'single'], FIXEDPOS: ['', 'fixed'], NARROW_FLOAT: ['', 'float'], WAAS: ['', 'diff'] },
  });
  loadFunctions(browserCode, 'const SOLUTION_HOLD_MS =', 'function drawSolutionTimeline(', context);
  const sample = (t, used, type = 'SINGLE', status = 'SOL_COMPUTED') => ({ t, used, tracked: 30, status, type });
  const samples = [
    sample(0, 18), sample(10000, 18), sample(20000, 19),
    // 60 s silence: the 19 run must stop SOLUTION_HOLD_MS after its last sample.
    sample(80000, 19), sample(90000, null), sample(100000, 21),
  ];
  const runs = context.solutionRuns(samples, 5000, 200000, (s) => s.used);
  assert.deepEqual(plain(runs.map((r) => [r.start, r.end, r.value])), [
    [5000, 20000, 18], [20000, 55000, 19], [80000, 90000, 19], [100000, 135000, 21],
  ]);
  const clipped = context.solutionRuns(samples, 85000, 110000, (s) => s.used);
  assert.deepEqual(plain(clipped.map((r) => [r.start, r.end, r.value])), [[85000, 90000, 19], [100000, 110000, 21]]);

  assert.equal(context.fixTier(sample(0, 10, 'FIXEDPOS')), 4);
  assert.equal(context.fixTier(sample(0, 10, 'NARROW_FLOAT')), 3);
  assert.equal(context.fixTier(sample(0, 10, 'WAAS')), 2);
  assert.equal(context.fixTier(sample(0, 10, 'SINGLE')), 1);
  assert.equal(context.fixTier(sample(0, 10, 'FIXEDPOS', 'INSUFFICIENT_OBS')), 0, 'an invalid solution is no fix');
  assert.equal(context.fixTier(sample(0, 10, null)), 0);
  assert.equal(context.fixTier(sample(0, 10, 'SOMETHING_NEW')), 1, 'unknown computed types count as single');
});

test('browser records live BESTPOS with the same thinning and history merge as the server', () => {
  const context = vm.createContext({
    Date, MAX_INTERFERENCE_SAMPLES: 10000, MAX_TRACK_SAMPLES: 1081, MAX_TRACKS: 512,
    state: { windowMinutes: 60, interferenceHistory: [], tracks: {}, solutionHistory: [] },
    isValidSkyPosition: () => true,
  });
  loadFunctions(browserCode, 'function pruneClientHistory()', '// --- interference timeline', context);
  const now = Date.now();
  context.recordSolution(bestpos(20), now);
  context.recordSolution(bestpos(20), now + 5000);
  context.recordSolution(bestpos(20), now + 10000);
  context.recordSolution(bestpos(20, 'FIXEDPOS'), now + 11000);
  assert.deepEqual(plain(context.state.solutionHistory.map((s) => [s.t - now, s.used, s.type])),
    [[0, 20, 'SINGLE'], [10000, 20, 'SINGLE'], [11000, 20, 'FIXEDPOS']]);
  context.recordLiveHistory({ name: 'BESTPOS', data: bestpos(7) });
  assert.equal(context.state.solutionHistory.at(-1).used, 7);
  assert.equal(context.solutionSample({ t: 5, used: 300, type: 'SINGLE' }, 5).used, null, 'counts are bounded');
  assert.equal(context.solutionSample({ status: 'SOL_COMPUTED' }, 5), null, 'samples need a count or a type');
  context.state.solutionHistory[0].t = now - 7200000;
  context.pruneClientHistory();
  assert.equal(context.state.solutionHistory.length, 3);
});

test('browser merges historic BESTPOS intervals with local precedence and archive visibility', () => {
  const context = vm.createContext({
    state: {
      solutionHistory: [{ t: 60000, used: 25, tracked: 30, type: 'SINGLE', status: 'SOL_COMPUTED' }],
      archive: { shown: true, data: { solution: [
        { t: 0, end: 120000, used: 20, tracked: 30, type: 'NARROW_INT', status: 'SOL_COMPUTED' },
        { t: 180000, end: 200000, used: 0, tracked: 30, type: 'NONE', status: 'INSUFFICIENT_OBS' },
      ] } },
    },
  });
  loadFunctions(browserCode, 'const SOLUTION_HOLD_MS =', 'function drawSolutionTimeline(', context);
  const samples = context.timelineSolutionSamples(10000, 210000);
  const runs = context.solutionRuns(samples, 10000, 210000, (s) => s.used);
  assert.deepEqual(plain(runs.map((r) => [r.start, r.end, r.value, Boolean(r.first.archive)])), [
    [10000, 60000, 20, true],
    [60000, 95000, 25, false],
    [95000, 120000, 20, true],
    [180000, 200000, 0, true],
  ], 'long archive intervals survive zoom, resume after live coverage and preserve gaps');
  assert.equal(context.liveSolution(190000), null, 'archive samples never appear as current values');
  context.state.archive.shown = false;
  assert.equal(context.timelineSolutionSamples(10000, 210000).length, 1);
  context.state.archive.shown = true;
  context.state.archive.data = null;
  assert.equal(context.timelineSolutionSamples(10000, 210000).length, 1);
});

test('timeline geometry keeps the band rows and adds two solution rows above the axis', () => {
  const context = vm.createContext({});
  loadFunctions(browserCode, 'const TIMELINE =', 'const TIMELINE_BANDS', context);
  const { TIMELINE, TIMELINE_SOLUTION_ROWS } = vm.runInContext('({ TIMELINE, TIMELINE_SOLUTION_ROWS })', context);
  const bands = (TIMELINE.height - TIMELINE.top - TIMELINE.bottom - TIMELINE_SOLUTION_ROWS * TIMELINE.solutionRow) / 3;
  assert.equal(bands, 142, 'band rows keep their previous height');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, new RegExp(`id="timeline" viewBox="0 0 900 ${TIMELINE.height}"`));
});

test('BESTSATS counts fill gaps only, with BESTPOS precedence and no fabricated fix', () => {
  const context = vm.createContext({
    state: {
      solutionHistory: [{ t: 80000, used: 25, tracked: 30, type: 'SINGLE', status: 'SOL_COMPUTED' }],
      archive: { shown: true, data: {
        solution: [{ t: 20000, end: 60000, used: 22, tracked: 30, type: 'NARROW_INT', status: 'SOL_COMPUTED' }],
        bestsats: [{ t: 0, end: 150000, used: 18, tracked: null, type: null, status: null }],
      } },
    },
  });
  loadFunctions(browserCode, 'const SOLUTION_HOLD_MS =', 'function drawSolutionTimeline(', context);
  const samples = context.timelineSolutionSamples(0, 160000);
  assert.deepEqual(plain(context.solutionRuns(samples, 0, 160000, (s) => s.used)
    .map((run) => [run.start, run.end, run.value])), [
    [0, 20000, 18], [20000, 60000, 22], [60000, 80000, 18], [80000, 115000, 25], [115000, 150000, 18],
  ]);
  const fixes = context.solutionRuns(samples, 0, 160000, (s) => s.type || null);
  assert.deepEqual(plain(fixes.map((run) => [run.start, run.end, run.value])), [
    [20000, 60000, 'NARROW_INT'], [80000, 115000, 'SINGLE'],
  ]);
  context.state.archive.shown = false;
  assert.equal(context.timelineSolutionSamples(0, 160000).length, 1);
});

test('a report with interference in one band shows clear status in the other bands', () => {
  const context = vm.createContext({
    classifyBand: (signal) => (/L2/.test(signal) ? 'L2' : /L5/.test(signal) ? 'L5' : /L1/.test(signal) ? 'L1' : 'OTHER'),
  });
  loadFunctions(browserCode, 'const TIMELINE_REPORT_MS =', 'function formatSpan(', context);
  const samples = [
    { t: 0, signal: 'ALL', count: 0, maxPower: null },
    { t: 1000, signal: 'GPSL2C', count: 1, maxPower: -90 },
    { t: 2000, signal: 'GPSL2C', count: 1, maxPower: -88 },
    { t: 2001, signal: 'GALE6', count: 1, maxPower: -100 },
    { t: 3000, signal: 'GPSL1CA', count: 1, maxPower: -95 },
    { t: 3000, signal: 'GPSL2C', count: 2, maxPower: -85 },
  ];
  const summary = (band) => plain(context.timelineBandSamples(samples, band).map((s) => [s.t, s.count]));
  assert.deepEqual(summary('L1'), [[0, 0], [1000, 0], [2000, 0], [3000, 1]]);
  assert.deepEqual(summary('L2'), [[0, 0], [1000, 1], [2000, 1], [3000, 2]]);
  assert.deepEqual(summary('L5'), [[0, 0], [1000, 0], [2000, 0], [3000, 0]], 'one clear sample per report');
});

function fakeSvg() {
  const element = (tag, attributes = {}, textContent = '') => ({
    tag, attributes: { ...attributes }, textContent, children: [],
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  return element;
}

test('BESTSATS-only plot shows satellite count and unavailable fix instead of a no-fix classification', () => {
  const svg = fakeSvg();
  const context = vm.createContext({
    svg, Date, TIMELINE: { left: 168, right: 72, solutionRow: 90 }, appendYLabel() {},
    formatTimestamp: String,
    state: { solutionHistory: [], archive: { shown: true, data: {
      bestsats: [{ t: 0, end: 30000, used: 18, tracked: null, type: null, status: null }], solution: [],
    } } },
  });
  loadFunctions(browserCode, 'const SOLUTION_HOLD_MS =', 'const SPECTRUM_PLOTS =', context);
  const chart = svg('svg');
  context.drawSolutionTimeline(chart, { start: 0, dataEnd: 60000, x: (t) => t / 100 }, 0, 900);
  assert(chart.children.some((el) => el.attributes.class === 'tl-sats-area'));
  assert(!chart.children.some((el) => el.attributes.class === 'tl-fix-bar'));
  assert(chart.children.some((el) => el.textContent === 'Fix type unavailable: BESTSATS does not report it'));
});

test('live solution readouts show the current count and fix type, roll on change and go stale', () => {
  const svg = fakeSvg();
  let now = 1_000_000;
  const context = vm.createContext({
    svg, state: { solutionHistory: [] }, formatTimestamp: String,
    POSITION_TYPE_TEXT: { SINGLE: ['', 'single'], NARROW_FLOAT: ['', 'float'] },
    Date: class extends Date { static now() { return now; } },
  });
  loadFunctions(browserCode, 'const TIMELINE =', 'function timelineViewport(', context);
  loadFunctions(browserCode, 'const SOLUTION_HOLD_MS =', 'function drawSolutionTimeline(', context);
  const draw = () => {
    const chart = svg('svg');
    context.drawSolutionLive(chart, 0, 90, now);
    const texts = chart.children.filter((child) => child.tag === 'text');
    return Object.fromEntries(['tl-live-value', 'tl-live-fix'].map((name) => [name,
      texts.find((child) => child.attributes.class.split(' ')[0] === name)]));
  };
  let live = draw();
  assert.equal(live['tl-live-value'].textContent, '—');
  assert.match(live['tl-live-value'].attributes.class, /stale/);

  context.state.solutionHistory.push({ t: now, used: 22, tracked: 30, status: 'SOL_COMPUTED', type: 'SINGLE' });
  live = draw();
  assert.equal(live['tl-live-value'].textContent, '22');
  assert.equal(live['tl-live-fix'].textContent, 'SINGLE');
  assert.equal(live['tl-live-fix'].attributes.fill, '#8c94a4');

  now += 1000;
  context.state.solutionHistory.push({ t: now, used: 19, tracked: 30, status: 'SOL_COMPUTED', type: 'NARROW_FLOAT' });
  live = draw();
  assert.match(live['tl-live-value'].attributes.class, /tl-roll-down/, 'a falling count rolls down');
  assert.match(live['tl-live-fix'].attributes.class, /tl-roll-up/);
  assert.equal(live['tl-live-fix'].attributes.lengthAdjust, 'spacingAndGlyphs', 'long type names are fitted');
  now += 200;
  assert.match(draw()['tl-live-value'].attributes.style, /animation-delay:-200ms/, 're-renders resume the roll');
  now += 1000;
  assert.doesNotMatch(draw()['tl-live-value'].attributes.class, /roll/);

  now += 36000;
  live = draw();
  assert.equal(live['tl-live-value'].textContent, '—', 'stale BESTPOS is not shown as live');
  assert.equal(live['tl-live-fix'].textContent, '—');
});

test('y-axis labels are duplicated in the right margin', () => {
  const svg = fakeSvg();
  const context = vm.createContext({ svg });
  loadFunctions(browserCode, 'const TIMELINE =', 'function timelineViewport(', context);
  loadFunctions(browserCode, 'function appendYLabel(', 'function renderTimeline(', context);
  const chart = svg('svg');
  context.appendYLabel(chart, 50, '-90', 900);
  const [leftLabel, rightLabel] = chart.children;
  assert.equal(leftLabel.attributes.x, 168 - 8);
  assert.equal(rightLabel.attributes.x, 900 - 72 + 8);
  assert.equal(rightLabel.attributes.class, 'tl-label tl-label-right');
  assert.equal(rightLabel.textContent, '-90');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /\.tl-label\.tl-label-right, \.spectrum-label\.spectrum-label-right \{ text-anchor: start; \}/);
});

test('historic archive panel sits at the top of the interference tab', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const tab = html.indexOf('id="tab-interference"');
  assert(tab < html.indexOf('id="archive-panel"'));
  assert(html.indexOf('id="archive-panel"') < html.indexOf('id="it-banner"'));
});

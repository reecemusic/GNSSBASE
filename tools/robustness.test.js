'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { History } = require('../src/history');
const { parseAsciiLog } = require('../src/novatel');
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
    json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Request aborted')));
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

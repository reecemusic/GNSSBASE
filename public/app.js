'use strict';

/**
 * Browser client for the GNSS monitor page.
 * It renders the existing page, holds live state, opens an EventSource to /events,
 * and draws the skyplot, interference timeline, and archive view.
 * It emits no Node events.
 */

const $ = (id) => document.getElementById(id);
const MAX_RAW_ROWS = 300;
const MAX_IT_ROWS = 50;
// Hard cap for interference, solution, and satellite-view samples.
// A burst shorter than two hours keeps the newest samples (a ring). A longer span
// keeps the newest half as-is and merges older samples into time buckets, so a 24 h
// chart keeps its shape instead of storing every 1 Hz point. The live edge matches
// the server history response: same bucket rule, same "keep a detection" choice.
const MAX_INTERFERENCE_SAMPLES = 40000;
const HISTORY_REQUEST_LIMIT = 15000;
const MAX_TRACK_SAMPLES = 1081;
const MAX_TRACKS = 512;
const MAX_EVENT_CHARS = 8 * 1024 * 1024;
const INTERFERENCE_STALE_MS = 5000;
const liveStatusStartedAt = Date.now();
const dirtyRecords = new Set();
const pendingRaw = [];
const pendingInterference = [];
let countsDirty = false;
let ephemerisDirty = false;
let timelineDirty = false;
let lastErrorNotice = '';
/** Hides #client-error after a few minutes when nothing clears it sooner. */
let clientErrorTimer = null;
/** EventSource reconnect delay after readyState CLOSED. Doubles up to 30 s and resets on open. */
let streamRetryMs = 1000;
let streamRetryTimer = null;

/**
 * Shows a display failure in #client-error and logs each distinct message once.
 * @param {string} context What failed.
 * @param {*} error Error or other thrown value.
 * @returns {void}
 * Side effects: DOM text on #client-error, console.error, and lastErrorNotice. events: none.
 */
function reportClientError(context, error) {
  // Writes #client-error and console.error once per distinct message. Does not dispatch an event.
  const message = `${context}: ${error instanceof Error ? error.message : String(error)}`;
  const notice = $('client-error');
  if (notice) {
    notice.hidden = false;
    notice.textContent = `${message}. Use Retry display to reload current data.`;
  }
  if (lastErrorNotice !== message) console.error(message, error);
  lastErrorNotice = message;
  // A one-off failure used to stay on the wall until someone pressed Retry.
  // The next successful snapshot also hides it. This timer covers a wall that
  // does not get another snapshot. No styling is changed. Sliced startup tests
  // have no setTimeout; the notice still shows, and Retry or a snapshot clears it.
  if (typeof setTimeout === 'function') {
    if (clientErrorTimer) clearTimeout(clientErrorTimer);
    clientErrorTimer = setTimeout(() => {
      clientErrorTimer = null;
      clearClientError();
    }, 3 * 60 * 1000);
  }
}

/**
 * Hides #client-error and forgets the last message so a later failure is logged again.
 * Called after a successful snapshot or history fetch, by the few-minute timer, and
 * by Retry display. Does nothing when the element is missing.
 * @returns {void}
 * Side effects: #client-error hidden, lastErrorNotice cleared, clientErrorTimer cleared. events: none.
 */
function clearClientError() {
  const notice = $('client-error');
  if (notice) notice.hidden = true;
  lastErrorNotice = '';
  if (clientErrorTimer) {
    clearTimeout(clientErrorTimer);
    clientErrorTimer = null;
  }
}

/**
 * Reads one localStorage preference and parses it when the key is present.
 * @param {string} key Storage key.
 * @param {*} fallback Used when the key is missing or reading throws.
 * @param {Function} [parse] Maps the stored string to a value. Defaults to identity.
 * @returns {*}
 * Side effects: localStorage read. On failure, reportClientError and the fallback. events: none.
 */
function readPreference(key, fallback, parse = (value) => value) {
  // localStorage getItem. A missing key returns fallback. A throw from storage or parse is reported and fallback is returned.
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : parse(value);
  } catch (error) {
    reportClientError(`Could not read preference ${key}`, error);
    return fallback;
  }
}

/**
 * Writes one localStorage preference.
 * @param {string} key Storage key.
 * @param {string} value Value passed to setItem.
 * @returns {void}
 * Side effects: localStorage write. On failure, reportClientError. events: none.
 */
function writePreference(key, value) {
  // localStorage setItem. A throw is reported and otherwise ignored.
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    reportClientError(`Could not save preference ${key}`, error);
  }
}

/**
 * Fetches a URL and aborts after 15 seconds, also honouring options.signal.
 * @param {string} url Request URL.
 * @param {object} [options] Fetch options.
 * @param {boolean} [json] When true, resolve with the parsed body.
 * @returns {Promise<Response|*>}
 * Side effects: network fetch and a timer. Throws when the response is not ok. events: none.
 */
async function request(url, options = {}, json = false) {
  const controller = new AbortController();
  /** Aborts this request's controller. No params. Returns undefined. Side effects: aborts the fetch. Events: none. */
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`);
    return json ? await response.json() : response;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Loads a set of hidden names from a JSON array of at most 512 strings.
 * @param {string} key Storage key.
 * @returns {Set<string>}
 * Side effects: readPreference reports a client error and an empty set is used when the value is missing or invalid. events: none.
 */
function readHiddenPreference(key) {
  return new Set(readPreference(key, [], (value) => {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 512 || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('Expected a list of names');
    }
    return parsed;
  }));
}

const state = {
  counts: {},
  ephemeris: {},
  itBySignal: {},
  satvis: {},
  satelliteViewHistory: [],
  lastDetection: null,
  hiddenSystems: readHiddenPreference('hiddenSystems'),
  hiddenSignals: readHiddenPreference('hiddenSignals'),
  timeZone: readPreference('timeZone', 'Asia/Dubai', (zone) => {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  }),
  itSeen: 0,
  paused: false,
  filter: '',
  heightDatum: readPreference('heightDatum', 'msl') === 'ellipsoidal' ? 'ellipsoidal' : 'msl',
  ephemerisConstellation: readPreference('ephemerisConstellation', ''),
  wall: false,
};

// --- tabs -------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
    // Leaflet mis-sizes tiles when the container was display:none at creation.
    if (tab.dataset.tab === 'position' && map) map.invalidateSize();
    flushUpdates(true);
  });
});

$('pause').addEventListener('click', (event) => {
  state.paused = !state.paused;
  event.target.textContent = state.paused ? 'Resume' : 'Pause';
});

$('height-toggle').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-datum]');
  if (!button) return;
  state.heightDatum = button.dataset.datum;
  writePreference('heightDatum', state.heightDatum);
  syncHeightToggle();
  if (latestByName.BESTPOS) renderBestPos(latestByName.BESTPOS);
  if (latestByName.BESTGNSSPOS) renderBestGnssPos(latestByName.BESTGNSSPOS);
});

/**
 * Marks the active height-datum button and copies that label onto both height captions.
 * @returns {void}
 * Side effects: DOM class and text on the height toggle and the two height labels. events: none.
 */
function syncHeightToggle() {
  for (const button of $('height-toggle').children) {
    button.classList.toggle('active', button.dataset.datum === state.heightDatum);
  }
  const label = state.heightDatum === 'ellipsoidal' ? 'Height (ellipsoidal)' : 'Height (MSL)';
  $('pos-hgt-label').textContent = label;
  $('gnss-hgt-label').textContent = label;
}

/** BESTPOS reports height above mean sea level; ellipsoidal = MSL + geoid undulation. */
function heightFor(d) {
  if (!Number.isFinite(d.heightMsl)) return null;
  if (state.heightDatum !== 'ellipsoidal') return d.heightMsl;
  return Number.isFinite(d.undulation) ? d.heightMsl + d.undulation : null;
}
$('clear').addEventListener('click', () => $('raw-log').replaceChildren());
$('raw-filter').addEventListener('change', (event) => {
  state.filter = event.target.value;
  applyRawFilter();
});

const connectionForm = $('connection-form');
const connectionTransport = $('connection-transport');
const serialPathSelect = $('serial-path');
// Latest receiver status plus local UI state used to colour the connection bar.
const connection = { status: null, offline: false, dirty: false, busy: null };
let connectionCountdown = null;

connectionTransport.addEventListener('change', () => {
  updateConnectionFields();
  if (connectionTransport.value !== 'tcp') refreshSerialPorts();
});

for (const eventName of ['input', 'change']) {
  connectionForm.addEventListener(eventName, (event) => {
    if (!event.target.matches('input, select')) return;
    connection.dirty = true;
    renderConnectionBar();
  });
}

$('disconnect').addEventListener('click', async () => {
  const message = $('connection-message');
  connection.busy = 'disconnect';
  renderConnectionBar();
  message.textContent = '';
  try {
    const response = await request('/api/disconnect', { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
  } catch (error) {
    message.textContent = `Disconnect failed: ${error.message}`;
  } finally {
    connection.busy = null;
    renderConnectionBar();
  }
});

connectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('connection-message');
  const transport = connectionTransport.value;
  const serial = {
    serialPath: serialPathSelect.value,
    serialBaudRate: Number($('serial-baud-rate').value),
  };
  const tcp = {
    receiverHost: $('receiver-host').value,
    receiverPort: Number($('receiver-port').value),
  };
  const settings = transport === 'serial' ? { transport, ...serial }
    : transport === 'tcp' ? { transport, ...tcp }
      : { transport: 'auto', ...serial, ...tcp };

  connection.busy = 'connect';
  renderConnectionBar();
  message.textContent = '';
  try {
    const response = await request('/api/connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error(await response.text());
    connection.dirty = false;
  } catch (error) {
    message.textContent = `Could not apply settings: ${error.message}`;
  } finally {
    connection.busy = null;
    renderConnectionBar();
  }
});

/**
 * Shows the TCP fields, the serial fields, or both, from the transport select.
 * @returns {void}
 * Side effects: hidden on #tcp-fields and #serial-fields. events: none.
 */
function updateConnectionFields() {
  const transport = connectionTransport.value;
  $('tcp-fields').hidden = transport === 'serial';
  $('serial-fields').hidden = transport === 'tcp';
}

/**
 * Phase used by the connection bar: offline, connecting, connected, or the status phase.
 * @returns {string}
 * Side effects: none. events: none.
 */
function connectionPhase() {
  const status = connection.status;
  if (connection.offline) return 'offline';
  if (!status) return 'connecting';
  if (status.connected) return 'connected';
  return status.phase || 'waiting';
}

/**
 * Formats the serial path and baud, or the TCP host and port, for a status object.
 * @param {object} status Receiver status.
 * @param {string} [transport] Override; defaults to status.transport.
 * @returns {string}
 * Side effects: none. events: none.
 */
function connectionTarget(status, transport = status.transport) {
  return transport === 'serial'
    ? `USB serial ${status.serialPath} @ ${status.baudRate} baud`
    : `TCP ${status.host}:${status.port}`;
}

/** Colours the connection bar and sets button labels/emphasis for the current phase. */
function renderConnectionBar() {
  const status = connection.status;
  const phase = connectionPhase();
  const auto = status?.mode === 'auto';
  const visualPhase = phase === 'offline' ? phase
    : connection.busy === 'disconnect' ? 'disconnecting'
      : connection.busy === 'connect' ? 'connecting' : phase;
  let title;
  let detail;
  if (phase === 'offline') {
    title = 'Monitor server unreachable';
    detail = 'This page lost contact with the local server — retrying…';
  } else if (phase === 'connected') {
    title = 'Connected';
    detail = `Receiving receiver logs via ${connectionTarget(status)}`
      + (auto && status.transport === 'tcp' ? ' · USB serial unavailable, using TCP fallback' : '')
      + (status.lastError ? ` · ${status.lastError}` : '');
  } else if (phase === 'stopped') {
    title = 'Disconnected';
    detail = 'Receiver connection closed. Press Connect to start.';
  } else if (!status) {
    title = 'Connecting…';
    detail = 'Waiting for the monitor server';
  } else if (phase === 'connecting') {
    title = 'Connecting…';
    detail = `Trying ${connectionTarget(status)}`
      + (auto && status.transport === 'serial' ? `, then ${connectionTarget(status, 'tcp')}` : '');
  } else {
    const seconds = Number.isFinite(status.retryAt) ? Math.max(0, Math.ceil((status.retryAt - Date.now()) / 1000)) : null;
    title = 'Not connected — retrying';
    detail = `${status.lastError || `Lost ${connectionTarget(status)}`}`
      + (seconds !== null ? ` · next attempt in ${seconds} s` : '');
  }

  if (phase !== 'offline' && connection.busy) {
    title = connection.busy === 'disconnect' ? 'Disconnecting…' : 'Applying connection settings…';
    detail = 'Waiting for the monitor server to confirm the request.';
  }
  if (connection.dirty) detail += ' · Settings changed — press Apply & reconnect to use them.';

  connectionForm.className = `connection-bar conn-${visualPhase}`;
  connectionForm.setAttribute('aria-busy', String(connection.busy !== null));
  $('status').className = `status ${visualPhase}`;
  $('status-text').textContent = title;
  $('status').title = detail;
  $('connection-state-title').textContent = title;
  $('connection-state-detail').textContent = detail;

  for (const fields of [$('serial-fields'), $('tcp-fields')]) {
    const active = status && status.transport === fields.dataset.transport;
    fields.classList.toggle('in-use', Boolean(active) && visualPhase === 'connected');
    fields.classList.toggle('trying', Boolean(active) && (visualPhase === 'connecting' || visualPhase === 'waiting'));
  }

  const connect = $('connect');
  const disconnect = $('disconnect');
  connect.disabled = phase === 'offline' || !status || connection.busy !== null;
  disconnect.disabled = phase === 'offline' || !status || connection.busy !== null || phase === 'stopped';
  connect.textContent = connection.busy === 'connect' ? 'Applying…'
    : connection.dirty ? 'Apply & reconnect'
      : phase === 'connected' ? 'Reconnect'
        : phase === 'stopped' ? 'Connect'
          : 'Retry now';
  connect.dataset.emphasis = connection.dirty ? 'apply' : phase === 'connected' ? 'neutral' : 'go';
  disconnect.textContent = connection.busy === 'disconnect' ? 'Disconnecting…'
    : phase === 'connected' ? 'Disconnect'
      : phase === 'stopped' ? 'Disconnected'
        : 'Stop trying';

  const counting = phase === 'waiting' && Number.isFinite(status?.retryAt);
  if (counting && !connectionCountdown) connectionCountdown = setInterval(renderConnectionBar, 1000);
  if (!counting && connectionCountdown) {
    clearInterval(connectionCountdown);
    connectionCountdown = null;
  }
}

/**
 * GET /api/serial-ports and rebuilds the serial-path select, keeping the selected path.
 * @param {string} [selectedPath] Option to select. Defaults to the current select value.
 * @returns {Promise<void>}
 * Side effects: network and DOM on the select and #connection-message. Failures set the message text. events: none.
 */
async function refreshSerialPorts(selectedPath = serialPathSelect.value) {
  const message = $('connection-message');
  try {
    const ports = await request('/api/serial-ports', {}, true);
    serialPathSelect.replaceChildren();
    for (const port of ports) {
      const option = document.createElement('option');
      option.value = port.path;
      option.textContent = port.manufacturer ? `${port.path} - ${port.manufacturer}` : port.path;
      serialPathSelect.append(option);
    }
    if (!ports.some((port) => port.path === selectedPath)) {
      const option = document.createElement('option');
      option.value = selectedPath || 'COM11';
      option.textContent = `${option.value} (not detected)`;
      serialPathSelect.append(option);
    }
    serialPathSelect.value = selectedPath || 'COM11';
    if (ports.length === 0) message.textContent = 'No serial ports detected';
  } catch (error) {
    message.textContent = error.message;
  }
}

/**
 * GET /api/connection and fills the connection form, then refreshes serial ports.
 * @returns {Promise<void>}
 * Side effects: network and DOM form fields. Failures set #connection-message. events: none.
 */
async function loadConnectionSettings() {
  try {
    const settings = await request('/api/connection', {}, true);
    connectionTransport.value = settings.transport;
    $('receiver-host').value = settings.receiverHost;
    $('receiver-port').value = settings.receiverPort;
    $('serial-baud-rate').value = settings.serialBaudRate;
    updateConnectionFields();
    await refreshSerialPorts(settings.serialPath);
  } catch (error) {
    $('connection-message').textContent = error.message;
  }
}

renderConnectionBar();
loadConnectionSettings();

// --- stream -----------------------------------------------------------------

let source = null;

/**
 * Parses one EventSource message and passes the object to handler.
 * @param {string} context Label passed to reportClientError.
 * @param {MessageEvent} event Event whose data is JSON text.
 * @param {Function} handler Called with the parsed object.
 * @returns {void}
 * Side effects: reportClientError when the text is over the size limit, JSON is invalid, the value is not a plain object, or handler throws. events: none.
 */
function handleStreamEvent(context, event, handler) {
  // Parses event.data as JSON and runs handler only for a plain object. Oversize text and bad JSON are reported and skipped.
  try {
    if (event.data.length > MAX_EVENT_CHARS) throw new Error('Live event exceeds the display size limit');
    const data = JSON.parse(event.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a data object');
    handler(data);
  } catch (error) {
    reportClientError(context, error);
  }
}

/**
 * Opens an EventSource on /events when the tab is visible and no source is already open.
 * @returns {void}
 * Side effects: network SSE. Listens for status, snapshot, message, ephemeris, archive, open, and error. error marks the page offline and redraws the bar. When readyState is CLOSED (2) the source cannot reconnect itself, so it is dropped and scheduleStreamReconnect arms a backoff. A hidden tab is skipped; the visibility listener closes the source and calls this again when the tab is shown. events: none.
 */
function connectStream() {
  // No second connection, and no connection while the tab is hidden. A pending backoff is left for scheduleStreamReconnect.
  if (source || document.hidden) return;
  source = new EventSource('/events');
  // SSE names listened for: status, snapshot, message, ephemeris, and archive. Also the EventSource open and error events.
  source.addEventListener('status', (event) => handleStreamEvent('Receiver status', event, renderStatus));
  source.addEventListener('snapshot', (event) => handleStreamEvent('Loading live snapshot', event, applySnapshot));
  source.addEventListener('message', (event) => handleStreamEvent('Reading live report', event, applyPayload));
  source.addEventListener('ephemeris', (event) => handleStreamEvent('Ephemeris', event, applyEphemerisUpdates));
  source.addEventListener('archive', (event) => handleStreamEvent('Archive status', event, applyArchiveStatus));
  source.addEventListener('open', () => {
    connection.offline = false;
    streamRetryMs = 1000;
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
    }
    renderConnectionBar();
  });
  // error marks the page offline. CONNECTING (0) still retries inside this EventSource.
  // CLOSED (2) does not. Drop it and open a new one after a backoff.
  source.addEventListener('error', () => {
    connection.offline = true;
    renderConnectionBar();
    if (source && source.readyState === 2) {
      source.close();
      source = null;
      scheduleStreamReconnect();
    }
  });
}

/**
 * Opens /events again after the stream was closed.
 * The delay starts at 1 s and doubles up to 30 s. A hidden tab, an open source,
 * or a timer that is already armed does nothing. open resets the delay.
 * @returns {void}
 * Side effects: streamRetryTimer and streamRetryMs. The timer calls connectStream. events: none.
 */
function scheduleStreamReconnect() {
  if (document.hidden || source || streamRetryTimer) return;
  const delay = streamRetryMs;
  streamRetryMs = Math.min(streamRetryMs * 2, 30000);
  streamRetryTimer = setTimeout(() => {
    streamRetryTimer = null;
    connectStream();
  }, delay);
}

/**
 * Replaces counters, ephemeris, satvis, latest reports, and the raw and interference logs from a snapshot.
 * @param {object} snap Snapshot object from the snapshot SSE event.
 * @returns {void}
 * Side effects: state, latestByName, pending queues, DOM logs, and dirty flags. History copies ITDETECTSTATUS onto latestByName only when crcValid === true, receivedAt is set, and no report is stored yet or this receivedAt is later. events: none.
 */
function applySnapshot(snap) {
  if (snap.status) renderStatus(snap.status);
  if (snap.archive) applyArchiveStatus(snap.archive);
  state.counts = snap.counts || {};
  state.ephemeris = snap.ephemeris || {};
  state.itBySignal = snap.itdetectBySignal || {};
  state.itSeen = state.counts.ITDETECTSTATUS || 0;
  for (const key of Object.keys(latestByName)) delete latestByName[key];
  state.satvis = {};

  pendingRaw.length = 0;
  pendingInterference.length = 0;
  Object.values(snap.latest || {}).forEach(applyRecord);
  state.satvis = {};
  for (const record of Object.values(snap.satvisBySystem || {})) {
    if (record?.crcValid === true && record.data?.system) state.satvis[record.data.system] = record;
  }
  const latestSatelliteReport = Object.values(snap.latest || {})
    .filter((record) => ['RANGE', 'SATVIS2', 'BESTSATS', 'TRACKSTAT'].includes(record.name)
      && Number.isFinite(Date.parse(record.receivedAt)))
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0];
  if (latestSatelliteReport) recordSatelliteView(latestSatelliteReport);
  $('it-log').replaceChildren();
  lastItReportHadDetections = false;
  (snap.itdetectHistory || []).forEach((record) => {
    rememberLastDetection(record);
    // Copied onto latestByName only when crcValid === true, receivedAt is set, and either nothing is stored yet or this receivedAt is later.
    if (record.crcValid === true && record.receivedAt && (!latestByName.ITDETECTSTATUS
      || Date.parse(record.receivedAt) > Date.parse(latestByName.ITDETECTSTATUS.receivedAt))) {
      latestByName.ITDETECTSTATUS = record;
    }
  });
  (snap.itdetectHistory || []).slice(-MAX_IT_ROWS).forEach((record) => queueRecord(pendingInterference, record, MAX_IT_ROWS));
  $('raw-log').replaceChildren();
  (snap.rawLog || []).slice(-MAX_RAW_ROWS).forEach((record) => queueRecord(pendingRaw, record, MAX_RAW_ROWS));
  countsDirty = ephemerisDirty = timelineDirty = true;
  // A snapshot arrived, so the previous client-error notice is stale. Retry still hides it too.
  // Sliced tests do not define clearClientError; hiding the stub element is enough there.
  if (typeof clearClientError === 'function') clearClientError();
  else {
    const clientNotice = $('client-error');
    if (clientNotice) clientNotice.hidden = true;
  }
}

/**
 * Applies one live report to counts, history, latestByName, and the raw and interference queues.
 * @param {object} payload Object with record, counts, and optional ephemeris.
 * @returns {void}
 * Side effects: state and queues. validateRecord and recordLiveHistory may throw. events: none.
 */
/**
 * Merges coalesced ephemeris deltas into state.ephemeris.
 * The connect snapshot still replaces the whole map. Later frames carry only the
 * satellites that changed, under payload.updates. A full payload.ephemeris object,
 * if one is ever sent, is still applied by applyPayload.
 * @param {object} payload Object with an updates array.
 * @returns {void}
 * Side effects: state.ephemeris and ephemerisDirty. events: none.
 */
function applyEphemerisUpdates(payload) {
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  for (const update of updates) {
    if (!update || typeof update.name !== 'string' || !update.name) continue;
    const entry = state.ephemeris[update.name] || (state.ephemeris[update.name] = { count: 0, records: {}, satellites: [] });
    if (Number.isFinite(update.count)) entry.count = update.count;
    entry.lastSatellite = update.lastSatellite;
    entry.lastAt = update.lastAt;
    if (update.satelliteId && update.record) entry.records[update.satelliteId] = update.record;
    entry.satellites = Array.isArray(update.satellites) ? update.satellites : Object.keys(entry.records);
  }
  if (updates.length) ephemerisDirty = true;
}

function applyPayload(payload) {
  validateRecord(payload.record);
  state.counts = payload.counts;
  if (payload.ephemeris) state.ephemeris = payload.ephemeris;
  recordLiveHistory(payload.record);
  applyRecord(payload.record);
  if (['RANGE', 'SATVIS2', 'BESTSATS', 'TRACKSTAT'].includes(payload.record.name)) recordSatelliteView(payload.record);
  if (payload.record.name === 'ITDETECTSTATUS') {
    rememberLastDetection(payload.record);
    state.itSeen = state.counts.ITDETECTSTATUS || 0;
    queueRecord(pendingInterference, payload.record, MAX_IT_ROWS);
    timelineDirty = true;
  }
  if (payload.record.name === 'BESTPOS') timelineDirty = true;
  if (!state.paused) queueRecord(pendingRaw, rawDisplayRecord(payload.record), MAX_RAW_ROWS);
  countsDirty = true;
  if (payload.ephemeris) ephemerisDirty = true;
}

/**
 * Appends a record and drops the oldest entries past limit.
 * @param {Array} queue Queue mutated in place.
 * @param {object} record Record to append.
 * @param {number} limit Maximum length kept.
 * @returns {void}
 * Side effects: mutates queue. events: none.
 */
function queueRecord(queue, record, limit) {
  queue.push(record);
  if (queue.length > limit) queue.splice(0, queue.length - limit);
}

/**
 * Copies the fields shown in the raw log and truncates raw text past 16384 characters.
 * @param {object} record Source report.
 * @returns {object}
 * Side effects: none. events: none.
 */
function rawDisplayRecord(record) {
  const text = String(record.raw ?? '');
  return {
    name: record.name, format: record.format, crcValid: record.crcValid, receivedAt: record.receivedAt,
    raw: text.length > 16384 ? `${text.slice(0, 16384)} [display truncated]` : text,
  };
}

/**
 * Runs a renderer and reports a throw without letting it stop later updates.
 * @param {string} label Context passed to reportClientError.
 * @param {Function} render Callback.
 * @returns {void}
 * Side effects: reportClientError when render throws. events: none.
 */
function renderSafely(label, render) {
  try {
    render();
  } catch (error) {
    reportClientError(label, error);
  }
}

/**
 * Renders the active tab when it is dirty, or always when force is set.
 * @param {boolean} [force] Draw the active tab even if its dirty flag is clear.
 * @returns {void}
 * Side effects: DOM via the tab renderers. Clears that tab dirty flag and dirtyRecords. Returns immediately when the tab is hidden. events: none.
 */
function flushUpdates(force = false) {
  if (document.hidden) return;
  const tab = document.querySelector('.tab.active')?.dataset.tab;
  const renderers = {
    overview: () => { if (force || countsDirty) renderCounts(); },
    position: () => {
      if (latestByName.BESTPOS) renderBestPos(latestByName.BESTPOS);
      if (latestByName.BESTGNSSPOS) renderBestGnssPos(latestByName.BESTGNSSPOS);
    },
    // renderRange redraws the skyplot. A call here as well painted it twice.
    satellites: () => {
      if (latestByName.RANGE && latestByName.RANGE.data) renderRange(latestByName.RANGE);
      else renderSkyplot();
    },
    ephemeris: () => { if (force || ephemerisDirty) renderEphemeris(); },
    interference: () => {
      if (latestByName.ITDETECTSTATUS) renderItDetect(latestByName.ITDETECTSTATUS);
      for (const record of pendingInterference.splice(0)) renderSafely('Rendering interference report', () => appendItRow(record));
      if (force || timelineDirty) renderTimeline();
    },
    health: () => {
      if (latestByName.RXSTATUS) renderRxStatus(latestByName.RXSTATUS);
      if (latestByName.VERSION) renderVersion(latestByName.VERSION);
    },
    raw: () => {
      for (const record of pendingRaw.splice(0)) renderSafely('Rendering raw report', () => appendRawRow(record));
    },
  };
  const relevant = {
    overview: countsDirty,
    position: dirtyRecords.has('BESTPOS') || dirtyRecords.has('BESTGNSSPOS'),
    satellites: ['RANGE', 'SATVIS2', 'BESTSATS', 'TRACKSTAT', 'BESTPOS'].some((name) => dirtyRecords.has(name)),
    ephemeris: ephemerisDirty,
    interference: timelineDirty || dirtyRecords.has('ITDETECTSTATUS') || pendingInterference.length,
    health: dirtyRecords.has('RXSTATUS') || dirtyRecords.has('VERSION'),
    raw: pendingRaw.length,
  };
  if (force || relevant[tab]) {
    if (renderers[tab]) renderSafely(`Rendering ${tab}`, renderers[tab]);
  }
  if (tab === 'overview') countsDirty = false;
  if (tab === 'ephemeris') ephemerisDirty = false;
  if (tab === 'interference') timelineDirty = false;
  dirtyRecords.clear();
}

/**
 * Stores receiver status, clears the offline flag, and redraws the connection bar.
 * @param {object} status Status object from the status SSE event or a snapshot.
 * @returns {void}
 * Side effects: connection.status, connection.offline, and the connection-bar DOM. May start or stop the retry countdown timer. events: none.
 */
function renderStatus(status) {
  connection.status = status;
  connection.offline = false;
  renderConnectionBar();
}

/**
 * Stores a CRC-valid report on latestByName. An error or any other crcValid only registers the raw-log name.
 * @param {object} record Decoded report.
 * @returns {void}
 * Side effects: validateRecord may throw. On success, latestByName, dirtyRecords, satvis, last detection, the version line, and the raw filter. events: none.
 */
function applyRecord(record) {
  validateRecord(record);
  // Not stored when record.error is set or crcValid is not exactly true. The raw-log filter still learns the name.
  if (record.error || record.crcValid !== true) {
    registerFilterOption(record.name);
    return;
  }
  // The raw log already keeps a 16 KiB display copy. The live record must not pin the rest.
  if (typeof record.raw === 'string' && record.raw.length > 16384) {
    record.raw = `${record.raw.slice(0, 16384)} [display truncated]`;
  }
  latestByName[record.name] = record;
  dirtyRecords.add(record.name);
  if (record.name === 'SATVIS2' && record.data) state.satvis[record.data.system] = record;
  if (record.name === 'ITDETECTSTATUS') rememberLastDetection(record);
  if (record.name === 'VERSION') renderVersionSummary(record);
  registerFilterOption(record.name);
}

/**
 * Rejects a report with a bad name, non-object data, a 257th message type, or an oversized detections, satellites, observations, or components array.
 * @param {object} record Report to check.
 * @returns {void}
 * Side effects: none. Throws instead of storing the report. events: none.
 */
function validateRecord(record) {
  // Rejected: missing record, or a name that is not 1-64 characters of A-Z, digits, and underscores.
  if (!record || typeof record.name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(record.name)) {
    throw new Error('Report has an invalid message name');
  }
  // Rejected: data that is present but not a plain object. null and undefined are allowed.
  if (record.data !== undefined && record.data !== null && (typeof record.data !== 'object' || Array.isArray(record.data))) {
    throw new Error(`${record.name} has invalid report data`);
  }
  // Rejected: a new message name when 256 distinct types are already stored.
  if (Object.keys(latestByName).length >= 256 && !Object.hasOwn(latestByName, record.name)) {
    throw new Error('Too many distinct message types');
  }
  // Rejected: a detections, satellites, observations, or components value that is not an array of at most 2048 objects.
  for (const key of ['detections', 'satellites', 'observations', 'components']) {
    const values = record.data?.[key];
    if (values !== undefined && (!Array.isArray(values) || values.length > 2048
      || values.some((value) => !value || typeof value !== 'object'))) {
      throw new Error(`${record.name} has invalid or oversized ${key}`);
    }
  }
}

// --- renderers --------------------------------------------------------------

// --- solution status / position type explanations ---------------------------

const SOLUTION_STATUS_TEXT = {
  SOL_COMPUTED: 'Solution computed and valid',
  INSUFFICIENT_OBS: 'Not enough observations to compute a solution',
  NO_CONVERGENCE: 'Solution did not converge',
  SINGULARITY: 'Singularity in the solution matrix',
  COV_TRACE: 'Covariance trace exceeded the limit — position too uncertain',
  TEST_DIST: 'Distance test failed — solution moved too far from the last position',
  COLD_START: 'Still converging from a cold start',
  V_H_LIMIT: 'Velocity or height export limit exceeded',
  VARIANCE: 'Variance exceeds the configured limit',
  RESIDUALS: 'Measurement residuals are too large',
  INTEGRITY_WARNING: 'Integrity warning raised',
  PENDING: 'Fixed position is being validated',
  INVALID_FIX: 'The fixed position is invalid',
  UNAUTHORIZED: 'Feature is not authorised on this receiver',
  INVALID_RATE: 'Requested rate is not supported',
};

/** [description, quality tier, typical accuracy] */
const POSITION_TYPE_TEXT = {
  NONE: ['No position available', 'none', ''],
  FIXEDPOS: ['Position fixed by the FIX POSITION command', 'fixed', 'as entered'],
  FIXEDHEIGHT: ['Height fixed by the FIX HEIGHT command', 'diff', ''],
  DOPPLER_VELOCITY: ['Velocity derived from Doppler', 'none', ''],
  SINGLE: ['Autonomous single-point — no corrections applied', 'single', '~1.5 m'],
  PSRDIFF: ['Pseudorange differential using base corrections', 'diff', '~0.4–1 m'],
  WAAS: ['SBAS-corrected (WAAS/EGNOS/MSAS)', 'diff', '~0.6 m'],
  PROPAGATED: ['Propagated from a previous solution — corrections have aged out', 'single', 'degrading'],
  L1_FLOAT: ['RTK float on L1 — ambiguities not yet resolved', 'float', '~20 cm'],
  NARROW_FLOAT: ['RTK float, narrow-lane — ambiguities not yet resolved', 'float', '~10–30 cm'],
  L1_INT: ['RTK fixed on L1 — integer ambiguities resolved', 'fixed', '~2 cm'],
  NARROW_INT: ['RTK fixed, narrow-lane integer ambiguities resolved — highest precision', 'fixed', '~1 cm + 1 ppm'],
  RTK_DIRECT_INS: ['RTK fixed, seeded directly from the INS', 'fixed', '~1 cm'],
  INS_SBAS: ['INS solution aligned to an SBAS position', 'diff', ''],
  INS_PSRSP: ['INS solution aligned to a single-point position', 'single', ''],
  INS_PSRDIFF: ['INS solution aligned to a differential position', 'diff', ''],
  INS_RTKFLOAT: ['INS solution aligned to an RTK float position', 'float', ''],
  INS_RTKFIXED: ['INS solution aligned to an RTK fixed position', 'fixed', ''],
  PPP_CONVERGING: ['PPP still converging', 'float', 'decimetre, improving'],
  PPP: ['Precise Point Positioning, converged', 'fixed', '~4 cm'],
  PPP_BASIC_CONVERGING: ['Basic PPP still converging', 'float', ''],
  PPP_BASIC: ['Basic PPP, converged', 'diff', '~30 cm'],
  OPERATIONAL: ['ALIGN baseline is operational', 'fixed', ''],
  WARNING: ['ALIGN baseline quality is degraded', 'float', ''],
  OUT_OF_BOUNDS: ['ALIGN baseline is out of bounds', 'none', ''],
};

const QUALITY_LABEL = {
  fixed: 'Centimetre — RTK fixed',
  float: 'Decimetre — RTK float',
  diff: 'Sub-metre — differential',
  single: 'Metre — autonomous',
  none: 'No usable fix',
};

/**
 * Looks up solution-status text and the position-type quality tier.
 * @param {string} solutionStatus Receiver solution status.
 * @param {string} positionType Receiver position type.
 * @returns {object}
 * Side effects: none. Returns text and quality (quality is null when the type is unknown). events: none.
 */
function explainSolution(solutionStatus, positionType) {
  const status = SOLUTION_STATUS_TEXT[solutionStatus] || solutionStatus || '';
  const type = POSITION_TYPE_TEXT[positionType];
  if (!type) return { text: status, quality: null };
  const accuracy = type[2] ? ` (${type[2]})` : '';
  return { text: `${status}. ${type[0]}${accuracy}.`, quality: type[1] };
}

/**
 * Fills the BESTPOS fields and updates the map from one report.
 * @param {object} record BESTPOS report.
 * @returns {void}
 * Side effects: DOM position fields and the map. Returns when data is missing. events: none.
 */
function renderBestPos(record) {
  const d = record.data;
  if (!d) return;
  $('pos-type').textContent = `${d.solutionStatus} / ${d.positionType}`;
  $('pos-type').classList.toggle('alert', d.solutionStatus !== 'SOL_COMPUTED');

  const explained = explainSolution(d.solutionStatus, d.positionType);
  $('pos-status-hint').textContent = explained.text;
  const quality = $('pos-quality');
  quality.hidden = !explained.quality;
  if (explained.quality) {
    quality.className = `quality ${explained.quality}`;
    quality.textContent = QUALITY_LABEL[explained.quality];
  }
  $('pos-lat').textContent = fmt(d.latitude, 9, '°');
  $('pos-lon').textContent = fmt(d.longitude, 9, '°');
  $('pos-hgt').textContent = fmt(heightFor(d), 3, ' m');
  const otherHeight = !Number.isFinite(d.undulation) || !Number.isFinite(d.heightMsl) ? null
    : state.heightDatum === 'ellipsoidal' ? d.heightMsl : d.heightMsl + d.undulation;
  $('pos-undulation').textContent = Number.isFinite(d.undulation)
    ? `geoid undulation ${d.undulation.toFixed(3)} m · ${state.heightDatum === 'ellipsoidal' ? 'MSL' : 'ellipsoidal'} ${otherHeight === null ? '—' : `${otherHeight.toFixed(3)} m`}`
    : '';
  $('pos-sigma').textContent = `${fmt(d.latitudeSigma, 3)} / ${fmt(d.longitudeSigma, 3)} / ${fmt(d.heightSigma, 3)} m`;
  $('pos-svs').textContent = `${d.satellitesUsed ?? '—'} / ${d.satellitesTracked ?? '—'}`;
  $('pos-age').textContent = `${fmt(d.differentialAge, 1, ' s')} / ${fmt(d.solutionAge, 1, ' s')}`;
  $('pos-stn').textContent = d.stationId || '—';
  updateMap(d);
}

// --- map --------------------------------------------------------------------

let map = null;
let marker = null;
let accuracyCircle = null;

/**
 * Escapes &, <, >, quotes, and apostrophes for HTML text.
 * @param {*} value Value coerced with String.
 * @returns {string}
 * Side effects: none. events: none.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

/** Plots the antenna position. Silently degrades to a message when offline. */
function updateMap(d) {
  if (!Number.isFinite(d.latitude) || !Number.isFinite(d.longitude)) return;
  if (d.latitude === 0 && d.longitude === 0) return;
  if (d.latitude < -90 || d.latitude > 90 || d.longitude < -180 || d.longitude > 180) return;

  const link = $('gmaps-link');
  link.href = `https://www.google.com/maps?q=${d.latitude},${d.longitude}`;
  link.hidden = false;

  if (typeof L === 'undefined') {
    $('map-fallback').textContent = 'Map library unavailable (no internet connection). '
      + `Position: ${d.latitude.toFixed(8)}, ${d.longitude.toFixed(8)}`;
    return;
  }

  const position = [d.latitude, d.longitude];
  const radius = Math.max(d.latitudeSigma || 0, d.longitudeSigma || 0);

  if (!map) {
    $('map-fallback').hidden = true;
    $('map').classList.add('ready');
    map = L.map('map', { attributionControl: true }).setView(position, 17);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    marker = L.marker(position).addTo(map);
    accuracyCircle = L.circle(position, { radius: radius || 1, color: '#3ddc84', weight: 1, fillOpacity: 0.15 }).addTo(map);
    // The container had no size until `ready` was applied a moment ago.
    requestAnimationFrame(() => map.invalidateSize());
  } else {
    marker.setLatLng(position);
    accuracyCircle.setLatLng(position).setRadius(radius || 1);
  }

  // Reuse the popup node. bindPopup on every fix allocated a new popup and left the old one detached.
  const popupHtml = `<b>${escapeHtml(d.solutionStatus)} / ${escapeHtml(d.positionType)}</b><br>`
    + `${d.latitude.toFixed(9)}, ${d.longitude.toFixed(9)}<br>`
    + `${escapeHtml(fmt(heightFor(d), 3, ' m'))} ${state.heightDatum === 'ellipsoidal' ? 'ellipsoidal' : 'MSL'} &middot; ${d.satellitesUsed ?? '?'} SVs`;
  const popup = typeof marker.getPopup === 'function' ? marker.getPopup() : null;
  if (popup && typeof popup.setContent === 'function') popup.setContent(popupHtml);
  else marker.bindPopup(popupHtml);
}

/**
 * Fills the BESTGNSSPOS readout from one report.
 * @param {object} record BESTGNSSPOS report.
 * @returns {void}
 * Side effects: DOM GNSS position fields. Returns when data is missing. events: none.
 */
function renderBestGnssPos(record) {
  const d = record.data;
  if (!d) return;
  $('gnss-type').textContent = `${d.solutionStatus} / ${d.positionType}`;
  $('gnss-status-hint').textContent = explainSolution(d.solutionStatus, d.positionType).text;
  $('gnss-latlon').textContent = `${fmt(d.latitude, 8)}, ${fmt(d.longitude, 8)}`;
  $('gnss-hgt').textContent = fmt(heightFor(d), 3, ' m');
  $('gnss-svs').textContent = `${d.satellitesUsed ?? '—'} / ${d.satellitesTracked ?? '—'}`;
}

// --- skyplot ----------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const SKY = { cx: 210, cy: 210, r: 180 };

const CONSTELLATIONS = {
  GPS: '#3ddc84',
  GLONASS: '#6aa9ff',
  GALILEO: '#c08bff',
  BEIDOU: '#ffb02e',
  QZSS: '#ff7ab6',
  NAVIC: '#4fd6d2',
  IRNSS: '#4fd6d2',
  SBAS: '#9aa4b5',
};

/**
 * Colour for a constellation name, or the fallback grey.
 * @param {string} system Constellation name.
 * @returns {string}
 * Side effects: none. events: none.
 */
function constellationColor(system) {
  return CONSTELLATIONS[(system || '').toUpperCase()] || '#9aa4b5';
}

/** Polar projection: elevation 90° at centre, 0° at the rim, azimuth clockwise from north. */
function skyPosition(elevationDeg, azimuthDeg) {
  const radius = ((90 - elevationDeg) / 90) * SKY.r;
  const azimuth = (azimuthDeg * Math.PI) / 180;
  return { x: SKY.cx + radius * Math.sin(azimuth), y: SKY.cy - radius * Math.cos(azimuth) };
}

/**
 * True when elevation is 0-90 and azimuth is 0 inclusive to 360 exclusive.
 * @param {number} elevation Elevation in degrees.
 * @param {number} azimuth Azimuth in degrees.
 * @returns {boolean}
 * Side effects: none. events: none.
 */
function isValidSkyPosition(elevation, azimuth) {
  return Number.isFinite(elevation) && elevation >= 0 && elevation <= 90
    && Number.isFinite(azimuth) && azimuth >= 0 && azimuth < 360;
}

/**
 * Creates an SVG element with attributes and optional text.
 * @param {string} tag SVG tag name.
 * @param {object} attrs Attribute map.
 * @param {string} [text] textContent when provided.
 * @returns {SVGElement}
 * Side effects: none until the caller inserts the element. events: none.
 */
function svg(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

// --- history ----------------------------------------------------------------

const HISTORY_WINDOW_KEY = 'historyWindowMinutes';
state.windowMinutes = readPreference(HISTORY_WINDOW_KEY, 60, (value) => {
  const minutes = Number(value);
  if (![5, 15, 60, 360, 1440].includes(minutes)) throw new Error('Invalid history window');
  return minutes;
});
state.tracks = {};
state.interferenceHistory = [];
state.solutionHistory = [];
state.showTraces = readPreference('showTraces', 'true') !== 'false';
state.archive = { status: null, data: null, shown: readPreference('archiveShown', 'true') !== 'false' };

$('history-window').value = String(state.windowMinutes);
$('show-traces').checked = state.showTraces;

$('history-window').addEventListener('change', (event) => {
  state.windowMinutes = Number(event.target.value);
  state.timelineView = null;
  writePreference(HISTORY_WINDOW_KEY, String(state.windowMinutes));
  loadHistory();
});

$('show-traces').addEventListener('change', (event) => {
  state.showTraces = event.target.checked;
  writePreference('showTraces', String(state.showTraces));
  renderSkyplot();
});

let historyRequest = 0;
let historyController = null;
/**
 * GET /api/history for the selected window and merges it with samples that arrived during the request.
 * @returns {Promise<void>}
 * Side effects: aborts the previous history fetch. Replaces tracks. Merges interference and, when data.solution is an array, solution history. A stale generation or a hidden tab returns before applying. Other failures are reported and existing samples stay. events: none.
 */
async function loadHistory() {
  const generation = ++historyRequest;
  historyController?.abort();
  historyController = new AbortController();
  const requestedAt = Date.now();
  try {
    const data = await request(`/api/history?minutes=${state.windowMinutes}&limit=${HISTORY_REQUEST_LIMIT}`,
      { signal: historyController.signal }, true);
    if (generation !== historyRequest || document.hidden) return;
    if (!data || !Array.isArray(data.interference) || !data.tracks || typeof data.tracks !== 'object') {
      throw new Error('Invalid history response');
    }
    if (data.interference.some((sample) => !sample || !Number.isFinite(sample.t)
      || typeof sample.signal !== 'string' || !Number.isFinite(sample.count)
      || (sample.detections !== undefined && (!Array.isArray(sample.detections) || sample.detections.length > 2048)))) {
      throw new Error('Invalid history samples');
    }
    state.tracks = data.tracks || {};
    const savedInterference = capSeries(data.interference, MAX_INTERFERENCE_SAMPLES,
      (sample) => String(sample.signal), keepInterferenceSample);
    // Interference samples already in memory with t at or after the request start arrived while the GET was in flight.
    const arrivedDuringRequest = state.interferenceHistory.filter((sample) => sample.t >= requestedAt);
    const keys = new Set(savedInterference.map((sample) => `${sample.t}:${sample.signal}:${sample.count}:${sample.maxPower}`));
    // Saved history (capped) is kept. In-flight samples are appended only when t:signal:count:maxPower is not already saved, then sorted by t.
    state.interferenceHistory = [...savedInterference, ...arrivedDuringRequest.filter((sample) =>
      !keys.has(`${sample.t}:${sample.signal}:${sample.count}:${sample.maxPower}`))];
    state.interferenceHistory.sort((a, b) => a.t - b.t);
    rememberHistoryDetection(state.interferenceHistory);
    if (Array.isArray(data.solution)) {
      const savedSolution = capSeries(
        data.solution.map((sample) => solutionSample(sample, sample?.t)).filter(Boolean).sort((a, b) => a.t - b.t),
        MAX_INTERFERENCE_SAMPLES, () => '', (previous, sample) => sample,
      );
      const lastSaved = savedSolution.length ? savedSolution[savedSolution.length - 1].t : -Infinity;
      // Live solution samples from during the request are appended only when they are newer than the last saved sample.
      const solutionDuringRequest = (state.solutionHistory || []).filter((sample) => sample.t >= requestedAt && sample.t > lastSaved);
      state.solutionHistory = [...savedSolution, ...solutionDuringRequest];
    }
    pruneClientHistory();
    capHistoryWindow(data.retentionMinutes);
    clearClientError();
  } catch (error) {
    if (generation === historyRequest) reportClientError('Could not load history (existing data retained)', error);
  }
  timelineDirty = true;
  flushUpdates(true);
}

/** The server cannot serve more than it retains, so hide unusable options. */
function capHistoryWindow(retentionMinutes) {
  if (!retentionMinutes) return;
  for (const option of $('history-window').options) {
    option.disabled = Number(option.value) > retentionMinutes;
    if (option.disabled) option.textContent = `${option.textContent.replace(/ \(.*\)$/, '')} (not retained)`;
  }
}

/**
 * Time-sorted samples cut to at most limit. Same rule as reduceSamples in src/history.js.
 * The newest Math.floor(limit / 2) samples stay as they are. Older samples are merged
 * into time buckets that start at 1000 ms and double until the older set fits the
 * remaining budget. key groups samples inside a bucket, and keep picks the survivor.
 * A series already within limit is returned as the same array, so a short chart is unchanged.
 * @param {object[]} samples Sorted by t.
 * @param {number} limit Maximum length.
 * @param {function(object): string} key Identity used before the time bucket.
 * @param {function(object, object): object} keep Called as keep(previous, sample).
 * @returns {object[]}
 * Side effects: none. samples is not mutated.
 */
function boundSeries(samples, limit, key, keep) {
  if (!Array.isArray(samples) || samples.length <= limit) return samples;
  const recentCount = Math.floor(limit / 2);
  const recent = samples.slice(samples.length - recentCount);
  const older = samples.slice(0, samples.length - recentCount);
  const budget = limit - recentCount;
  let reduced = older;
  for (let bucketMs = 1000; reduced.length > budget && bucketMs < 1e12; bucketMs *= 2) {
    const kept = new Map();
    for (const sample of older) {
      const id = `${key(sample)}:${Math.floor(sample.t / bucketMs)}`;
      const previous = kept.get(id);
      kept.set(id, previous ? keep(previous, sample) : sample);
    }
    reduced = [...kept.values()].sort((a, b) => a.t - b.t);
  }
  // budget is 0 only when limit is 0. slice(-0) would keep the whole array.
  const head = budget > 0 ? reduced.slice(-budget) : [];
  return [...head, ...recent];
}

/**
 * Picks the interference sample to keep inside one time bucket.
 * A sample with count > 0 wins over a clear sample. Otherwise the higher finite
 * maxPower wins. Equal or missing power keeps the sample already chosen.
 * @param {object} previous Sample already kept for this bucket.
 * @param {object} sample Candidate.
 * @returns {object}
 * Side effects: none.
 */
function keepInterferenceSample(previous, sample) {
  if ((sample.count > 0) !== (previous.count > 0)) return sample.count > 0 ? sample : previous;
  if (Number.isFinite(sample.maxPower) && (!Number.isFinite(previous.maxPower) || sample.maxPower > previous.maxPower)) {
    return sample;
  }
  return previous;
}

/**
 * Caps one series. Under the limit the same array is returned.
 * A span of two hours or less keeps the newest `limit` samples, which is the ring the
 * short-window charts already used. A longer span downsamples the older half so a 24 h
 * window does not have to store every 1 Hz point, while the newest half stays sample for sample.
 * @param {object[]} samples Time-sorted samples.
 * @param {number} limit Hard maximum length.
 * @param {function(object): string} key Series identity for downsampling.
 * @param {function(object, object): object} keep Survivor inside a bucket.
 * @returns {object[]}
 * Side effects: none. The input array is not mutated.
 */
function capSeries(samples, limit, key, keep) {
  if (!Array.isArray(samples) || samples.length <= limit) return samples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = first && last && Number.isFinite(first.t) && Number.isFinite(last.t) ? last.t - first.t : 0;
  const reduced = span > 2 * 60 * 60 * 1000 ? boundSeries(samples, limit, key, keep) : samples;
  if (reduced.length <= limit) return reduced;
  return reduced.slice(-limit);
}

/**
 * Drops client history older than the selected window and enforces the track and sample caps.
 * Interference, solution, and satellite-view series longer than two hours are downsampled
 * instead of keeping only the tail. Track points stay one sample per 20 s, capped at 1081, with at most 512 tracks.
 * @returns {void}
 * Side effects: state.interferenceHistory, solutionHistory, satelliteViewHistory, and tracks. events: none.
 */
function pruneClientHistory() {
  const cutoff = Date.now() - state.windowMinutes * 60000;
  state.interferenceHistory = capSeries(
    state.interferenceHistory.filter((s) => Number.isFinite(s.t) && s.t >= cutoff),
    MAX_INTERFERENCE_SAMPLES, (sample) => String(sample.signal), keepInterferenceSample,
  );
  if (state.solutionHistory) {
    state.solutionHistory = capSeries(
      state.solutionHistory.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff),
      MAX_INTERFERENCE_SAMPLES, () => '', (previous, sample) => sample,
    );
  }
  if (Array.isArray(state.satelliteViewHistory)) {
    state.satelliteViewHistory = capSeries(
      state.satelliteViewHistory.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff),
      MAX_INTERFERENCE_SAMPLES, () => '', (previous, sample) => sample,
    );
  }
  const tracks = Object.entries(state.tracks);
  for (const [index, [key, samples]] of tracks.entries()) {
    if (index >= MAX_TRACKS || !Array.isArray(samples)) {
      delete state.tracks[key];
      continue;
    }
    const kept = samples.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff).slice(-MAX_TRACK_SAMPLES);
    if (kept.length) state.tracks[key] = kept;
    else delete state.tracks[key];
  }
}

/**
 * Appends CRC-valid SATVIS2 tracks, ITDETECTSTATUS samples, and BESTPOS solution samples.
 * @param {object} record Decoded report.
 * @returns {void}
 * Side effects: state.tracks, interferenceHistory, and solution history. Returns immediately unless crcValid is true. Throws 'Too many satellite tracks' when a new key would exceed 512 tracks. events: none.
 */
function recordLiveHistory(record) {
  // crcValid must be true. A new satellite track when 512 already exist throws 'Too many satellite tracks'.
  if (record.crcValid !== true) return;
  // Same rule as saneTimestamp in src/novatel.js: after 2020, at most 2 s ahead of the PC, at most 5 min behind.
  // Header time is used only when it parses, is >= Date.UTC(2020, 0, 1), is >= now-5min, and is <= now+2s. Otherwise receivedAt when that parses, else Date.now().
  const nowMs = Date.now();
  const headerTime = Date.parse(record.header && record.header.utc);
  const receivedTime = Date.parse(record.receivedAt);
  const headerSane = Number.isFinite(headerTime) && headerTime >= Date.UTC(2020, 0, 1)
    && headerTime >= nowMs - 5 * 60 * 1000 && headerTime <= nowMs + 2000;
  const now = headerSane ? headerTime : Number.isFinite(receivedTime) ? receivedTime : nowMs;
  if (record.name === 'SATVIS2' && record.data && record.data.visibilityValid !== false) {
    for (const sat of record.data.satellites || []) {
      if (!isValidSkyPosition(sat.elevation, sat.azimuth)) continue;
      const key = `${record.data.system}:${sat.prn}`;
      if (!Object.hasOwn(state.tracks, key) && Object.keys(state.tracks).length >= MAX_TRACKS) {
        throw new Error('Too many satellite tracks');
      }
      const samples = state.tracks[key] || (state.tracks[key] = []);
      const last = samples[samples.length - 1];
      // Skip only a newer point inside 20 s. now < last.t is a backwards clock step;
      // now - last.t would stay negative and the track would freeze.
      if (last && now >= last.t && now - last.t < 20000) continue;
      samples.push({ t: now, el: sat.elevation, az: sat.azimuth });
      if (samples.length > MAX_TRACK_SAMPLES) samples.splice(0, samples.length - MAX_TRACK_SAMPLES);
    }
  }
  if (record.name === 'ITDETECTSTATUS' && record.data) {
    const bySignal = new Map();
    for (const detection of record.data.detections || []) {
      const signalDetections = bySignal.get(detection.signalType) || [];
      signalDetections.push(detection);
      bySignal.set(detection.signalType, signalDetections);
    }
    if (!bySignal.size) bySignal.set('ALL', []);
    for (const [signal, detections] of bySignal) {
      const powers = detections.map((d) => d.powerDbm).filter(Number.isFinite);
      state.interferenceHistory.push({
        t: now,
        signal,
        count: detections.length,
        maxPower: powers.length ? Math.max(...powers) : null,
        freq: detections.length && Number.isFinite(detections[0].centerFrequencyHz)
          ? detections[0].centerFrequencyHz
          : null,
        detections: detections.map((detection) => ({
          freq: Number.isFinite(detection.centerFrequencyHz) ? detection.centerFrequencyHz : null,
          bandwidth: Number.isFinite(detection.bandwidthHz) ? detection.bandwidthHz : null,
          power: Number.isFinite(detection.powerDbm) ? detection.powerDbm : null,
          type: detection.type || '',
        })),
      });
    }
  }
  if (state.interferenceHistory.length > MAX_INTERFERENCE_SAMPLES) {
    state.interferenceHistory = capSeries(
      state.interferenceHistory, MAX_INTERFERENCE_SAMPLES,
      (sample) => String(sample.signal), keepInterferenceSample,
    );
  }
  if (record.name === 'BESTPOS' && record.data) recordSolution(record.data, now);
}

// Unchanged solutions are thinned to one sample per heartbeat, matching the server history.
const SOLUTION_HEARTBEAT_MS = 10000;

/**
 * Builds a solution-history sample, or null when time or both used and type are unusable.
 * @param {object} data BESTPOS-like fields.
 * @param {number} t Sample time in milliseconds.
 * @returns {object|null}
 * Side effects: none. events: none.
 */
function solutionSample(data, t) {
  if (!data || !Number.isFinite(t)) return null;
  /** @param {*} value @returns {number|null} An integer from 0 to 255, otherwise null. Side effects: none. Events: none. */
  const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 255 ? value : null);
  /** @param {*} value @returns {string|null} A non-empty string trimmed to 32 characters, otherwise null. Side effects: none. Events: none. */
  const text = (value) => (typeof value === 'string' && value ? value.slice(0, 32) : null);
  const sample = {
    t, used: count(data.used ?? data.satellitesUsed), tracked: count(data.tracked ?? data.satellitesTracked),
    status: text(data.status ?? data.solutionStatus), type: text(data.type ?? data.positionType),
  };
  return sample.used === null && sample.type === null ? null : sample;
}

/**
 * Pushes a BESTPOS solution sample unless the same values were stored within the heartbeat.
 * @param {object} data BESTPOS data.
 * @param {number} now Sample time in milliseconds.
 * @returns {void}
 * Side effects: state.solutionHistory, capped at MAX_INTERFERENCE_SAMPLES. events: none.
 */
function recordSolution(data, now) {
  const sample = solutionSample(data, now);
  if (!sample) return;
  const history = state.solutionHistory || (state.solutionHistory = []);
  const last = history[history.length - 1];
  if (last && now - last.t < SOLUTION_HEARTBEAT_MS && last.used === sample.used && last.tracked === sample.tracked
    && last.status === sample.status && last.type === sample.type) return;
  history.push(sample);
  if (history.length > MAX_INTERFERENCE_SAMPLES) {
    const capped = capSeries(history, MAX_INTERFERENCE_SAMPLES, () => '', (previous, next) => next);
    if (capped !== history) state.solutionHistory = capped;
  }
}

// --- interference timeline --------------------------------------------------

const TIMELINE = { width: 900, height: 680, left: 168, right: 72, top: 28, bottom: 46, solutionRow: 90 };
const TIMELINE_SOLUTION_ROWS = 2;
const TIMELINE_BANDS = ['L1', 'L2', 'L5'];
const TIMELINE_BAND_INFO = {
  L1: { coverage: 'E1 / B1 / G1', range: '1559–1610 MHz' },
  L2: { coverage: 'G2', range: '1215–1260 MHz' },
  L5: { coverage: 'E5 / B2', range: '1164–1215 MHz' },
};

/**
 * Visible timeline range. While following, the end is the clock, so a future timestamp is outside the range.
 * @param {number} [now] Clock used as the live end. Defaults to Date.now().
 * @returns {object}
 * Side effects: none. A non-following end is also clamped so it is not after now. events: none.
 */
function timelineViewport(now = Date.now()) {
  const historyMs = state.windowMinutes * 60000;
  const spanMs = timelineSpanMs(now);
  const windowMs = Math.min(spanMs, Math.max(10000, state.timelineView?.windowMs || historyMs));
  // While following, the viewport ends at now, so a future timestamp is outside it and is not drawn. A pinned end is clamped to now as well.
  const end = state.timelineView && !state.timelineView.follow
    ? Math.max(now - spanMs + windowMs, Math.min(now, state.timelineView.end))
    : now;
  return { start: end - windowMs, end, windowMs };
}

/** Navigable time span: the live history window, extended back to the start of a shown archive. */
function timelineSpanMs(now = Date.now()) {
  const historyMs = state.windowMinutes * 60000;
  const archive = state.archive?.status;
  if (!state.archive?.shown || !archive || archive.state === 'idle' || !Number.isFinite(archive.from)) return historyMs;
  return Math.max(historyMs, now - archive.from);
}

// Fraction of the time axis kept to the right of the viewport end so "now" sits inset from the edge.
const TIMELINE_NOW_INSET = 0.1;
const TIMELINE_TICK_STEPS = [
  10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3,
  3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3, 172800e3, 345600e3, 604800e3,
];

/**
 * Axis length in milliseconds, the viewport plus the right-hand headroom.
 * @param {number} windowMs Viewport length.
 * @returns {number}
 * Side effects: none. events: none.
 */
function timelineAxisMs(windowMs) {
  return windowMs / (1 - TIMELINE_NOW_INSET);
}

/** Display axis for a viewport: spans the viewport plus headroom, mapping times to plot-relative x. */
function timelineAxis(start, windowMs, plotWidth, now = Date.now()) {
  const axisMs = timelineAxisMs(windowMs);
  const end = start + axisMs;
  return {
    start, end, axisMs, plotWidth,
    // dataEnd is min(now, axis end), so a sample after now is not drawn.
    dataEnd: Math.min(now, end),
    now: now >= start && now <= end ? now : null,
    x: (time) => (time - start) / axisMs * plotWidth,
  };
}

/**
 * Relative label such as minutes or hours ago for a non-negative duration.
 * @param {number} ms Duration in milliseconds.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatTimeSince(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return `${days} days${restHours ? ` ${restHours} hr` : ''} ago`;
  }
  return `${hours} hr${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''} ago`;
}

/** Tick times at whole steps before now (e.g. 1 hr ago, 2 hrs ago) that fall inside the axis. */
function timelineTicks(axis, now = Date.now()) {
  const maxTicks = Math.max(2, Math.floor(axis.plotWidth / 110));
  const step = TIMELINE_TICK_STEPS.find((candidate) => axis.axisMs / candidate <= maxTicks)
    || TIMELINE_TICK_STEPS[TIMELINE_TICK_STEPS.length - 1];
  const ticks = [];
  for (let k = Math.max(1, Math.ceil((now - axis.end) / step)); now - k * step >= axis.start; k++) {
    ticks.push(now - k * step);
  }
  return ticks.reverse();
}

/** Draws relative time ticks and the NOW marker shared by the timeline and frequency plots. */
function appendTimeAxis(chart, axis, layout, now = Date.now()) {
  const { left, top, bottom, labelY, nowLabelY, gridClass, labelClass } = layout;
  const right = left + axis.plotWidth;
  /** @param {number} x Plot x. @returns {'start'|'middle'|'end'} Keeps a tick label inside the plot. Side effects: none. Events: none. */
  const anchorFor = (x) => (x - left < 40 ? 'start' : right - x < 40 ? 'end' : 'middle');
  for (const time of timelineTicks(axis, now)) {
    const x = left + axis.x(time);
    const anchor = anchorFor(x);
    chart.append(svg('line', { x1: x, x2: x, y1: top, y2: bottom, class: gridClass }));
    chart.append(svg('text', { x, y: labelY, class: labelClass, style: `text-anchor:${anchor}` }, utcLabel(time)));
    chart.append(svg('text', { x, y: labelY + 12, class: 'tl-axis-ago', style: `text-anchor:${anchor}` },
      formatTimeSince(now - time)));
  }
  if (axis.now === null) return;
  const x = left + axis.x(axis.now);
  const anchor = anchorFor(x);
  const marker = svg('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'tl-now-line' });
  marker.append(svg('title', {}, `Now: ${utcLabel(axis.now)}`));
  chart.append(marker);
  chart.append(svg('text', { x, y: nowLabelY, class: 'tl-now-label', style: `text-anchor:${anchor}` }, 'NOW'));
  chart.append(svg('text', { x, y: labelY, class: 'tl-now-time', style: `text-anchor:${anchor}` }, utcLabel(axis.now)));
  chart.append(svg('text', { x, y: labelY + 12, class: 'tl-now-time', style: `text-anchor:${anchor}` }, 'now'));
}

/** Pinned selection: a time cursor on every linked plot plus a ring on the selected point. */
function appendSelectionMarker(chart, plotKey, axis, top, bottom) {
  chart.timeAxis = axis;
  chart.plotKey = plotKey;
  const selection = state.timelineSelection;
  if (!selection || selection.t < axis.start || selection.t > axis.end) return;
  const x = TIMELINE.left + axis.x(selection.t);
  chart.append(svg('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'tl-selected-line' }));
  if (selection.plot === plotKey) {
    chart.append(svg('circle', { cx: x, cy: selection.y, r: 7, class: 'tl-selected-ring' }));
  }
}

/** Keeps the View dropdown in step with the current viewport; pan/zoom shows "Custom". */
function syncTimelinePreset(now = Date.now()) {
  const select = $('timeline-preset');
  if (!select?.options) return;
  const view = state.timelineView;
  const spanMs = timelineSpanMs(now);
  const archive = state.archive?.status;
  const archiveShown = Boolean(state.archive?.shown && archive && archive.state !== 'idle' && Number.isFinite(archive.from));
  let custom = null;
  for (const option of select.options) {
    if (option.value === 'custom') custom = option;
    else if (option.value === 'archive') option.disabled = !archiveShown;
    else if (option.value !== 'live') option.disabled = Number(option.value) > spanMs + 60000;
  }
  const value = !view ? 'live' : view.follow && view.preset ? String(view.preset) : 'custom';
  if (custom) custom.hidden = value !== 'custom';
  if (select.value !== value) select.value = value;
}

/**
 * Applies a View choice: live, the whole archive, or a following window of that length.
 * @param {string} value Option value from the timeline preset select.
 * @returns {void}
 * Side effects: state.timelineView and a timeline redraw. events: none.
 */
function applyTimelinePreset(value) {
  if (value === 'live') state.timelineView = null;
  else if (value === 'archive') showWholeArchive();
  else if (Number(value) > 0) {
    const windowMs = Math.min(Number(value), timelineSpanMs());
    state.timelineView = { end: Date.now(), windowMs, follow: true, preset: value };
  }
  renderTimeline();
}

/**
 * Pins the viewport to end and windowMs, then reclamps it through timelineViewport.
 * @param {number} end Requested viewport end.
 * @param {number} windowMs Requested viewport length.
 * @returns {void}
 * Side effects: state.timelineView and a timeline redraw. events: none.
 */
function setTimelineView(end, windowMs) {
  state.timelineView = { end, windowMs };
  const view = timelineViewport();
  state.timelineView = { end: view.end, windowMs: view.windowMs };
  renderTimeline();
}

/**
 * Zooms the viewport around a fraction of the axis and pins the result.
 * @param {number} factor Scale applied to the current window.
 * @param {number} [fraction] Anchor along the axis. Defaults to 0.5.
 * @returns {void}
 * Side effects: state.timelineView and a timeline redraw via setTimelineView. events: none.
 */
function zoomTimeline(factor, fraction = 0.5) {
  const view = timelineViewport();
  const windowMs = Math.max(10000, Math.min(timelineSpanMs(), view.windowMs * factor));
  const anchor = view.start + fraction * timelineAxisMs(view.windowMs);
  setTimelineView(anchor - fraction * timelineAxisMs(windowMs) + windowMs, windowMs);
}

/**
 * Binds timeline zoom, pan, live, and chart navigation controls.
 * @returns {void}
 * Side effects: DOM click listeners. events: none.
 */
function initTimelineControls() {
  $('timeline-zoom-in').addEventListener('click', () => zoomTimeline(0.5));
  $('timeline-zoom-out').addEventListener('click', () => zoomTimeline(2));
  for (const [id, direction] of [['timeline-earlier', -1], ['timeline-later', 1]]) {
    $(id).addEventListener('click', () => {
      const view = timelineViewport();
      setTimelineView(view.end + direction * view.windowMs / 4, view.windowMs);
    });
  }
  $('timeline-live').addEventListener('click', () => {
    state.timelineView = null;
    renderTimeline();
  });
  initTimePlotNavigation($('timeline'));
}

/**
 * Wheel zoom and pointer pan on one time-plot SVG, or point selection when select mode is on.
 * @param {SVGElement} chart Plot element.
 * @returns {void}
 * Side effects: listeners on chart. preventDefault on a wheel zoom. events: none.
 */
function initTimePlotNavigation(chart) {
  let drag = null;
  if (state.selectMode) chart.classList.add('select-mode');
  /**
   * Maps the plot area from the SVG viewBox into client pixels.
   * @returns {{ left: number, width: number }}
   * Side effects: reads the chart's bounding box. Events: none.
   */
  const geometry = () => {
    const rect = chart.getBoundingClientRect();
    const width = chart.viewBox.baseVal.width;
    const scale = rect.width / width;
    return { left: rect.left + TIMELINE.left * scale, width: (width - TIMELINE.left - TIMELINE.right) * scale };
  };
  chart.addEventListener('wheel', (event) => {
    const area = geometry();
    const fraction = (event.clientX - area.left) / area.width;
    if (fraction < 0 || fraction > 1 || event.deltaY === 0) return;
    event.preventDefault();
    zoomTimeline(event.deltaY < 0 ? 0.8 : 1.25, fraction);
  }, { passive: false });
  chart.addEventListener('pointerdown', (event) => {
    const area = geometry();
    if (event.button !== 0 || event.clientX < area.left || event.clientX > area.left + area.width) return;
    if (state.selectMode) {
      selectTimePlotPoint(chart, event.clientX, event.clientY);
      return;
    }
    drag = { id: event.pointerId, x: event.clientX, width: area.width, view: timelineViewport() };
    chart.setPointerCapture(event.pointerId);
    chart.classList.add('panning');
  });
  chart.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const offset = (event.clientX - drag.x) / drag.width * timelineAxisMs(drag.view.windowMs);
    setTimelineView(drag.view.end - offset, drag.view.windowMs);
  });
  /**
   * Ends a pan when the pointer is released or cancelled.
   * @param {PointerEvent} event
   * @returns {void}
   * Side effects: clears `drag`, releases pointer capture, removes the panning class. Events: none.
   */
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const id = drag.id;
    drag = null;
    if (chart.hasPointerCapture(id)) chart.releasePointerCapture(id);
    chart.classList.remove('panning');
  };
  chart.addEventListener('pointerup', endDrag);
  chart.addEventListener('pointercancel', endDrag);
  chart.addEventListener('lostpointercapture', endDrag);
}

/**
 * Y position for a power in dBm inside one band row, or null when power is not finite.
 * @param {number} power Power in dBm.
 * @param {number} index Band row index.
 * @param {number} rowHeight Row height in user units.
 * @returns {number|null}
 * Side effects: none. events: none.
 */
function timelinePowerY(power, index, rowHeight) {
  if (!Number.isFinite(power)) return null;
  return TIMELINE.top + index * rowHeight + 20
    + (1 - (Math.max(-130, Math.min(-70, power)) + 130) / 60) * (rowHeight - 52);
}

/** A y-axis label drawn in both the left and right margins so values can be read from either side. */
function appendYLabel(chart, y, text, width, className = 'tl-label') {
  chart.append(svg('text', { x: TIMELINE.left - 8, y, class: className }, text));
  chart.append(svg('text', { x: width - TIMELINE.right + 8, y, class: `${className} tl-label-right` }, text));
}

/**
 * Wall display: the SVG is drawn in fewer user units than screen pixels so text and markers scale up with
 * the screen, while keeping at least WALL_MIN_HEIGHT units for the three band rows.
 */
const WALL_DESIGN_WIDTH = 900;
const WALL_MIN_HEIGHT = 400;

/**
 * User-unit size of the timeline SVG. Wall mode scales the drawing down so strokes grow on screen.
 * @param {SVGElement} chart Timeline element.
 * @returns {object}
 * Side effects: none. Reads the element rectangle. events: none.
 */
function timelineSize(chart) {
  const rect = chart.getBoundingClientRect();
  if (state.wall && rect.width > 0 && rect.height > 0) {
    const scale = Math.max(1, Math.min(rect.width / WALL_DESIGN_WIDTH, rect.height / WALL_MIN_HEIGHT));
    return { width: Math.round(rect.width / scale), height: Math.round(rect.height / scale), solutionRows: 0 };
  }
  const width = Math.min(1920, Math.max(360, Math.round(rect.width) || TIMELINE.width));
  return { width, height: TIMELINE.height, solutionRows: TIMELINE_SOLUTION_ROWS };
}

/**
 * Redraws the interference timeline, archive layer, spectrum plots, and solution rows for the viewport.
 * @returns {void}
 * Side effects: DOM SVG and range text. Samples after axis.dataEnd are omitted. May schedule an archive fetch. events: none.
 */
function renderTimeline() {
  const chart = $('timeline');
  chart.replaceChildren();

  const { width, height, solutionRows } = timelineSize(chart);
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const { start, end, windowMs } = timelineViewport();
  const bandIds = TIMELINE_BANDS;
  const rowHeight = (height - TIMELINE.top - TIMELINE.bottom
    - solutionRows * TIMELINE.solutionRow) / bandIds.length;
  const plotWidth = width - TIMELINE.left - TIMELINE.right;
  const now = Date.now();
  const axis = timelineAxis(start, windowMs, plotWidth, now);

  const samples = state.interferenceHistory.filter((sample) => sample.t >= start && sample.t <= axis.dataEnd)
    .sort((a, b) => a.t - b.t);
  $('timeline-range').textContent = `(${samples.length} samples, ${(windowMs / 1000).toFixed(0)} s window)`;
  $('timeline-mode').textContent = !state.timelineView ? 'Live'
    : state.timelineView.follow ? 'Live + archive' : 'Historical view';
  syncTimelinePreset(now);
  const archive = timelineArchiveSamples(start, axis.dataEnd);
  if (state.archive) ensureArchiveData(start, axis.dataEnd, plotWidth);
  if (archive) $('timeline-range').textContent = `(${samples.length} live samples, ${archive.samples.length} archive points, `
    + `${formatSpan(windowMs)} window)`;

  bandIds.forEach((bandId, index) => {
    const y = TIMELINE.top + index * rowHeight;
    chart.append(svg('rect', {
      x: TIMELINE.left, y: y + 1, width: plotWidth, height: rowHeight - 2, class: 'tl-row',
    }));
    chart.append(svg('rect', {
      x: 3, y: y + 2, width: width - 6, height: rowHeight - 4, rx: 6, class: 'tl-band-box',
    }));
    const bandInfo = TIMELINE_BAND_INFO[bandId];
    chart.append(svg('text', { x: 8, y: y + rowHeight / 2 - 12, class: 'tl-band-name' }, bandId));
    chart.append(svg('text', { x: 8, y: y + rowHeight / 2 + 2, class: 'tl-band-coverage' }, bandInfo.coverage));
    chart.append(svg('text', { x: 8, y: y + rowHeight / 2 + 16, class: 'tl-band-coverage' }, bandInfo.range));
    chart.append(svg('text', { x: TIMELINE.left, y: y + 12, class: 'tl-title' }, 'Power (dBm)'));
    for (const power of [-130, -110, -90, -70]) {
      const py = timelinePowerY(power, index, rowHeight);
      chart.append(svg('line', {
        x1: TIMELINE.left, x2: width - TIMELINE.right, y1: py, y2: py, class: 'tl-grid',
      }));
      appendYLabel(chart, py + 4, String(power), width);
    }
    appendYLabel(chart, y + rowHeight - 13, 'Status', width);
  });

  if (archive) drawArchiveTimeline(chart, axis, archive, bandIds, rowHeight, width);

  for (const [index, band] of bandIds.entries()) {
    const pixels = new Map();
    let segment = 0;
    let lastTime = null;
    for (const sample of timelineBandSamples(samples, band)) {
      if (!sample.count || !Number.isFinite(sample.maxPower) || (lastTime !== null && sample.t - lastTime > 15000)) {
        segment++;
      }
      lastTime = sample.t;
      const pixel = Math.round(axis.x(sample.t));
      const previous = pixels.get(pixel)?.sample;
      if (!previous || (sample.count > 0 && (!previous.count
        || (Number.isFinite(sample.maxPower) && (!Number.isFinite(previous.maxPower) || sample.maxPower > previous.maxPower))))) {
        pixels.set(pixel, { sample, segment });
      }
    }
    let previous = null;
    for (const { sample, segment } of pixels.values()) {
      const x = TIMELINE.left + axis.x(sample.t);
      const y = TIMELINE.top + index * rowHeight;
      const hit = sample.count > 0;
      const color = hit ? powerColour(sample.maxPower) : 'rgba(61,220,132,.65)';
      const status = svg('rect', {
        x: Math.max(TIMELINE.left, Math.min(width - TIMELINE.right - 3, x - 1.5)),
        y: y + rowHeight - 26, width: 3, height: 18,
        fill: hit ? powerColour(sample.maxPower) : 'rgba(61,220,132,.35)',
      });
      const description = `${band}, ${formatTimestamp(sample.t, true)}: `
        + (!hit ? 'Clear (no measured power)' : Number.isFinite(sample.maxPower) ? `${sample.maxPower} dBm` : 'Power unknown');
      status.append(svg('title', {}, description));
      chart.append(status);
      const py = hit ? timelinePowerY(sample.maxPower, index, rowHeight) : null;
      if (py !== null) {
        if (previous && previous.segment === segment && sample.t - previous.t <= 15000) {
          chart.append(svg('line', {
            x1: previous.x, y1: previous.y, x2: x, y2: py, stroke: color, class: 'tl-power-line',
          }));
        }
        const point = svg('circle', { cx: x, cy: py, r: 2.5, fill: color });
        point.append(svg('title', {}, description));
        chart.append(point);
        previous = { x, y: py, t: sample.t, segment };
      } else {
        previous = null;
      }
    }
  }

  if (!state.wall) renderSpectrumPlots(start, end, windowMs);
  if (solutionRows) drawSolutionTimeline(chart, axis, TIMELINE.top + bandIds.length * rowHeight, width);
  appendSelectionMarker(chart, 'timeline', axis, TIMELINE.top, height - TIMELINE.bottom);

  appendTimeAxis(chart, axis, {
    left: TIMELINE.left,
    top: TIMELINE.top,
    bottom: height - TIMELINE.bottom,
    labelY: height - 32,
    nowLabelY: TIMELINE.top - 8,
    gridClass: 'tl-grid',
    labelClass: 'tl-axis',
  }, now);

  chart.append(svg('text', { x: TIMELINE.left, y: height - 5, class: 'tl-title' },
    state.timeZone === 'Asia/Dubai' ? 'UAE' : state.timeZone));
}

// Detection samples this close together came from one ITDETECTSTATUS report (one sample is stored per
// signal type). A clear ('ALL') sample is always a report of its own.
const TIMELINE_REPORT_MS = 50;

/**
 * Samples for one band from time-sorted history. A report that detected interference only in other bands
 * still proves this band was monitored, so it becomes a clear sample here rather than a gap.
 */
function timelineBandSamples(samples, band) {
  const result = [];
  let index = 0;
  while (index < samples.length) {
    const first = samples[index];
    let hit = false;
    if (first.signal === 'ALL') index++;
    for (; index < samples.length && samples[index].signal !== 'ALL'
      && samples[index].t - first.t <= TIMELINE_REPORT_MS; index++) {
      const sample = samples[index];
      const bandSample = sample.count > 0 ? interferenceSampleForBand(sample, band) : null;
      if (bandSample) {
        result.push(bandSample);
        hit = true;
      }
    }
    if (!hit) result.push({ t: first.t, signal: 'ALL', count: 0, maxPower: null });
  }
  return result;
}

/**
 * Short duration label in seconds, minutes, hours, or days.
 * @param {number} ms Duration in milliseconds.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatSpan(ms) {
  if (ms < 120000) return `${Math.round(ms / 1000)} s`;
  if (ms < 7200000) return `${Math.round(ms / 60000)} min`;
  if (ms < 172800000) return `${Math.round(ms / 3600000)} h`;
  return `${(ms / 86400000).toFixed(1).replace(/\.0$/, '')} days`;
}

/** Archive coverage and detection samples inside [start, end], or null when no archive is shown. */
function timelineArchiveSamples(start, end) {
  const data = state.archive?.shown ? state.archive.data : null;
  if (!data) return null;
  return {
    bucketMs: data.bucketMs,
    coverage: data.coverage.filter(([runStart, runEnd]) => runEnd >= start && runStart <= end),
    samples: data.samples.filter((sample) => sample.t >= start && sample.t <= end),
  };
}

/** Draws archive coverage and detections beneath live data: faint coverage, hollow points, dashed lines. */
function drawArchiveTimeline(chart, axis, archive, bandIds, rowHeight, width) {
  const minX = TIMELINE.left;
  const maxX = width - TIMELINE.right;
  /** @param {number} time @returns {number} Plot x for a timestamp. Side effects: none. Events: none. */
  const xFor = (time) => TIMELINE.left + axis.x(time);
  const gapMs = Math.max(15000, archive.bucketMs * 1.5);
  bandIds.forEach((band, index) => {
    const y = TIMELINE.top + index * rowHeight;
    for (const [runStart, runEnd] of archive.coverage) {
      const x1 = Math.max(minX, xFor(runStart));
      const x2 = Math.min(maxX, xFor(runEnd));
      if (x2 < minX || x1 > maxX) continue;
      const rect = svg('rect', {
        x: x1, y: y + rowHeight - 26, width: Math.max(1, x2 - x1), height: 18, class: 'tl-archive-coverage',
      });
      rect.append(svg('title', {}, `Archive, ${band}: reports ${formatTimestamp(runStart, true)} – ${formatTimestamp(runEnd, true)}`
        + ' (clear unless marked)'));
      chart.append(rect);
    }
    const pixels = new Map();
    for (const sample of archive.samples) {
      if (sample.count <= 0) continue;
      const bandSample = interferenceSampleForBand(sample, band);
      if (!bandSample) continue;
      const pixel = Math.round(axis.x(sample.t));
      const previous = pixels.get(pixel);
      if (!previous || (Number.isFinite(bandSample.maxPower)
        && (!Number.isFinite(previous.maxPower) || bandSample.maxPower > previous.maxPower))) {
        pixels.set(pixel, bandSample);
      }
    }
    let previous = null;
    for (const sample of [...pixels.values()].sort((a, b) => a.t - b.t)) {
      const x = xFor(sample.t);
      const color = powerColour(sample.maxPower);
      const description = `Archive, ${band}, ${formatTimestamp(sample.t, true)}: `
        + (Number.isFinite(sample.maxPower) ? `${sample.maxPower} dBm` : 'Power unknown')
        + (archive.bucketMs > 1000 ? ` (strongest in ${formatSpan(archive.bucketMs)})` : '');
      const status = svg('rect', {
        x: Math.max(minX, Math.min(maxX - 3, x - 1.5)), y: y + rowHeight - 26, width: 3, height: 18,
        fill: color, class: 'tl-archive-status',
      });
      status.append(svg('title', {}, description));
      chart.append(status);
      const py = timelinePowerY(sample.maxPower, index, rowHeight);
      if (py === null) {
        previous = null;
        continue;
      }
      if (previous && sample.t - previous.t <= gapMs) {
        chart.append(svg('line', {
          x1: previous.x, y1: previous.y, x2: x, y2: py, stroke: color, class: 'tl-archive-line',
        }));
      }
      const point = svg('circle', { cx: x, cy: py, r: 3, stroke: color, class: 'tl-archive-point' });
      point.append(svg('title', {}, description));
      chart.append(point);
      previous = { x, y: py, t: sample.t };
    }
  });
}

// A reported solution is drawn for at most this long after its sample, so lost BESTPOS output shows as a gap.
const SOLUTION_HOLD_MS = 35000;
const FIX_TIERS = [
  { id: 'none', label: 'No fix', colour: '#ff5f56' },
  { id: 'single', label: 'Single', colour: '#3ddc84' },
  { id: 'diff', label: 'Differential', colour: '#3ddc84' },
  { id: 'float', label: 'Float', colour: '#3ddc84' },
  { id: 'fixed', label: 'Fixed', colour: '#3ddc84' },
];

/** Fix-quality tier index (0 = no fix … 4 = fixed), using the same tiers as the Position tab. */
function fixTier(sample) {
  if (!sample.type || (sample.status && sample.status !== 'SOL_COMPUTED')) return 0;
  const known = typeof POSITION_TYPE_TEXT === 'undefined' ? null : POSITION_TYPE_TEXT[sample.type];
  const index = FIX_TIERS.findIndex((tier) => tier.id === (known ? known[1] : 'single'));
  return Math.max(0, index);
}

/**
 * Merges consecutive samples with the same key into runs clipped to [start, end]. A run ends at the next
 * sample or SOLUTION_HOLD_MS after its last sample, whichever is first; null keys leave a gap.
 */
function solutionRuns(samples, start, end, key) {
  const runs = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (sample.t > end) break;
    const next = samples[index + 1];
    const stop = Math.min(next ? next.t : end, Number.isFinite(sample.end) ? sample.end : sample.t + SOLUTION_HOLD_MS, end);
    const value = key(sample);
    if (stop <= Math.max(start, sample.t) || value === null) continue;
    const last = runs[runs.length - 1];
    if (last && last.value === value && Boolean(last.last.archive) === Boolean(sample.archive)
      && last.last.source === sample.source && last.end >= sample.t) {
      last.end = stop;
      last.last = sample;
    } else {
      runs.push({ start: Math.max(start, sample.t), end: stop, value, first: sample, last: sample });
    }
  }
  return runs;
}

/** Archive intervals fill gaps in local history; never let archived values become live readouts. */
function timelineSolutionSamples(start, end) {
  const live = (state.solutionHistory || []).filter((sample) => sample.t >= start - SOLUTION_HOLD_MS && sample.t <= end)
    .map((sample, index, samples) => ({
      ...sample, end: Math.min(sample.t + SOLUTION_HOLD_MS, samples[index + 1]?.t ?? end, end),
    }));
  const archive = state.archive?.shown ? state.archive.data?.solution || [] : [];
  const bestsats = state.archive?.shown ? state.archive.data?.bestsats || [] : [];
  const bestpos = mergeSolutionIntervals(live, archive.map((sample) => ({ ...sample, archive: true })), start, end);
  return mergeSolutionIntervals(bestpos, bestsats.map((sample) => ({ ...sample, archive: true, source: 'BESTSATS' })), start, end);
}

/**
 * Fills gaps in primary solution intervals with fallback samples clipped to the range.
 * @param {Array} primary Preferred intervals.
 * @param {Array} fallback Samples used only in gaps.
 * @param {number} start Range start.
 * @param {number} end Range end.
 * @returns {Array}
 * Side effects: none. events: none.
 */
function mergeSolutionIntervals(primary, fallback, start, end) {
  const combined = [...primary];
  let primaryIndex = 0;
  for (let index = 0; index < fallback.length; index++) {
    const sample = fallback[index];
    let cursor = Math.max(start, sample.t);
    const stop = Math.min(end, sample.end, fallback[index + 1]?.t ?? end);
    if (stop <= cursor) continue;
    while (primaryIndex < primary.length && primary[primaryIndex].end <= cursor) primaryIndex++;
    for (let i = primaryIndex; i < primary.length && primary[i].t < stop; i++) {
      if (primary[i].t > cursor) combined.push({ ...sample, t: cursor, end: primary[i].t });
      cursor = Math.max(cursor, primary[i].end);
      if (cursor >= stop) break;
    }
    if (cursor < stop) combined.push({ ...sample, t: cursor, end: stop });
  }
  return combined.sort((a, b) => a.t - b.t);
}

/** Text for the live (latest) solution: tier, headline value and detail, or null when BESTPOS has gone stale. */
function liveSolution(now = Date.now()) {
  const history = state.solutionHistory || [];
  const latest = history[history.length - 1];
  if (!latest || now - latest.t > SOLUTION_HOLD_MS) return null;
  const tier = fixTier(latest);
  return {
    used: latest.used,
    tracked: latest.tracked,
    tier,
    fix: latest.status && latest.status !== 'SOL_COMPUTED' ? latest.status : (latest.type || '—'),
  };
}

// Live values roll in when they change; the change time lets re-renders resume the animation mid-way.
const SOLUTION_ROLL_MS = 450;
let solutionRoll = { used: undefined, fix: undefined, usedAt: 0, fixAt: 0, usedDirection: 'up' };

/**
 * CSS class and negative animation-delay while a live solution value is still rolling.
 * @param {string} key used or fix.
 * @param {number} now Clock in milliseconds.
 * @returns {object}
 * Side effects: none. Reads solutionRoll. events: none.
 */
function solutionRollAttributes(key, now) {
  const elapsed = now - solutionRoll[`${key}At`];
  if (elapsed >= SOLUTION_ROLL_MS) return {};
  const direction = key === 'used' ? solutionRoll.usedDirection : 'up';
  return { class: `tl-roll-${direction}`, style: `animation-delay:-${Math.max(0, elapsed)}ms` };
}

/** Large live readouts in the row header boxes: satellites used now, and the current fix type. */
function drawSolutionLive(chart, top, rowHeight, now) {
  const live = liveSolution(now);
  const used = live && Number.isInteger(live.used) ? live.used : null;
  const fix = live ? live.fix : null;
  if (used !== solutionRoll.used) {
    if (solutionRoll.used !== undefined) {
      solutionRoll.usedAt = now;
      solutionRoll.usedDirection = used !== null && solutionRoll.used !== null && used < solutionRoll.used ? 'down' : 'up';
    }
    solutionRoll.used = used;
  }
  if (fix !== solutionRoll.fix) {
    if (solutionRoll.fix !== undefined) solutionRoll.fixAt = now;
    solutionRoll.fix = fix;
  }

  const satValue = svg('text', { x: 8, y: top + 70, class: `tl-live-value${used === null ? ' stale' : ''}` },
    used === null ? '—' : String(used));
  const usedRoll = solutionRollAttributes('used', now);
  if (usedRoll.class) {
    satValue.setAttribute('class', `tl-live-value ${usedRoll.class}`);
    satValue.setAttribute('style', usedRoll.style);
  }
  satValue.append(svg('title', {}, used === null ? 'No live BESTPOS in the last 35 s'
    : `${used} satellites used now${Number.isInteger(live.tracked) ? ` of ${live.tracked} tracked` : ''}`));
  chart.append(satValue);
  chart.append(svg('text', { x: 8 + Math.max(1, String(used ?? '—').length) * 16 + 6, y: top + 70, class: 'tl-live-detail' },
    used === null ? 'no live data' : Number.isInteger(live.tracked) ? `of ${live.tracked} tracked` : 'used'));

  const fixY = top + rowHeight;
  const colour = live ? FIX_TIERS[live.tier].colour : null;
  const fixAttributes = { x: 8, y: fixY + 56, class: `tl-live-fix${live ? '' : ' stale'}` };
  if (colour) fixAttributes.fill = colour;
  // Long NovAtel type names are squeezed to fit the header box.
  if (fix && fix.length > 10) Object.assign(fixAttributes, { textLength: TIMELINE.left - 82, lengthAdjust: 'spacingAndGlyphs' });
  const fixValue = svg('text', fixAttributes, fix ?? '—');
  const fixRoll = solutionRollAttributes('fix', now);
  if (fixRoll.class) {
    fixValue.setAttribute('class', `tl-live-fix ${fixRoll.class}`);
    fixValue.setAttribute('style', fixRoll.style);
  }
  fixValue.append(svg('title', {}, live ? `Current fix: ${FIX_TIERS[live.tier].label} (${fix})` : 'No live BESTPOS in the last 35 s'));
  chart.append(fixValue);
  chart.append(svg('text', { x: 8, y: fixY + 74, class: 'tl-live-detail' }, live ? FIX_TIERS[live.tier].label : 'no live data'));
}

/** Satellites used and fix type from BESTPOS, drawn as two rows beneath the band rows on the shared time axis. */
function drawSolutionTimeline(chart, axis, top, width) {
  const rowHeight = TIMELINE.solutionRow;
  const right = width - TIMELINE.right;
  /** @param {number} time @returns {number} Plot x clamped to the solution row. Side effects: none. Events: none. */
  const xFor = (time) => Math.max(TIMELINE.left, Math.min(right, TIMELINE.left + axis.x(time)));
  const samples = timelineSolutionSamples(axis.start, axis.dataEnd);
  /** @param {object} run @returns {string} The run's time span, plus an archive or BESTSATS note when present. Side effects: none. Events: none. */
  const range = (run) => `${formatTimestamp(run.start, true)} – ${formatTimestamp(run.end, true)}${run.first.archive ? ' (archive)' : ''}`
    + `${run.first.source === 'BESTSATS' ? ' · BESTSATS: GOOD satellites; fix type unavailable' : ''}`;
  const rows = [
    ['Satellites', 'used in solution'],
    ['Fix type', 'BESTPOS only'],
  ];
  rows.forEach(([name, detail], index) => {
    const y = top + index * rowHeight;
    chart.append(svg('rect', { x: TIMELINE.left, y: y + 1, width: right - TIMELINE.left, height: rowHeight - 2, class: 'tl-row' }));
    chart.append(svg('rect', { x: 3, y: y + 2, width: width - 6, height: rowHeight - 4, rx: 6, class: 'tl-band-box' }));
    chart.append(svg('text', { x: 8, y: y + 22, class: 'tl-band-name' }, name));
    chart.append(svg('text', { x: 8, y: y + 38, class: 'tl-band-coverage' }, detail));
  });
  drawSolutionLive(chart, top, rowHeight, Date.now());
  if (!samples.length) {
    for (let index = 0; index < rows.length; index++) {
      chart.append(svg('text', {
        x: (TIMELINE.left + right) / 2, y: top + index * rowHeight + rowHeight / 2 + 4, class: 'tl-solution-empty',
      }, 'No BESTPOS solution data in this window'));
    }
    return;
  }

  // Satellites used: stepped trace over a lightly filled area, auto-scaled to the visible maximum.
  const satTop = top + 14;
  const satBottom = top + rowHeight - 10;
  const usedRuns = solutionRuns(samples, axis.start, axis.dataEnd, (sample) => sample.used);
  const maxUsed = Math.max(5, Math.ceil(Math.max(0, ...usedRuns.map((run) => run.value)) / 5) * 5);
  /** @param {number} count Satellites used. @returns {number} Y inside the satellite row. Side effects: none. Events: none. */
  const satY = (count) => satBottom - count / maxUsed * (satBottom - satTop);
  for (const count of [0, Math.round(maxUsed / 2), maxUsed]) {
    const y = satY(count);
    chart.append(svg('line', { x1: TIMELINE.left, x2: right, y1: y, y2: y, class: 'tl-grid' }));
    appendYLabel(chart, y + 4, String(count), width);
  }
  let path = '';
  let previous = null;
  for (const run of usedRuns) {
    const x1 = xFor(run.start);
    const x2 = Math.max(x1 + 1, xFor(run.end));
    const y = satY(run.value);
    path += previous && previous.end >= run.start ? ` V ${y} H ${x2}` : ` M ${x1} ${y} H ${x2}`;
    previous = run;
    const area = svg('rect', { x: x1, y, width: x2 - x1, height: satBottom - y, class: 'tl-sats-area' });
    const tracked = Number.isInteger(run.last.tracked) ? ` of ${run.last.tracked} tracked` : '';
    area.append(svg('title', {}, `${run.value} satellites used${tracked}, ${range(run)}`));
    chart.append(area);
  }
  if (path) chart.append(svg('path', { d: path.trim(), class: 'tl-sats-line' }));

  // Fix type: one lane per quality tier, coloured bars where the solution was in that tier.
  const fixTop = top + rowHeight + 6;
  const laneHeight = (rowHeight - 12) / FIX_TIERS.length;
  /** @param {number} tier Fix-tier index. @returns {number} Top y of that lane. Side effects: none. Events: none. */
  const laneY = (tier) => fixTop + (FIX_TIERS.length - 1 - tier) * laneHeight;
  FIX_TIERS.forEach((tier, index) => {
    appendYLabel(chart, laneY(index) + laneHeight / 2 + 4, tier.label, width, 'tl-label tl-fix-label');
  });
  const fixRuns = solutionRuns(samples, axis.start, axis.dataEnd, (sample) => (sample.type || sample.status
    ? `${fixTier(sample)}|${sample.status || ''}|${sample.type || ''}` : null));
  if (!fixRuns.length) {
    chart.append(svg('text', {
      x: (TIMELINE.left + right) / 2, y: top + rowHeight * 1.5 + 4, class: 'tl-solution-empty',
    }, 'Fix type unavailable: BESTSATS does not report it'));
  }
  for (const run of fixRuns) {
    const tier = fixTier(run.first);
    const x1 = xFor(run.start);
    const bar = svg('rect', {
      x: x1, y: laneY(tier) + 1, width: Math.max(1, xFor(run.end) - x1), height: laneHeight - 2,
      fill: FIX_TIERS[tier].colour, class: 'tl-fix-bar',
    });
    bar.append(svg('title', {}, `${FIX_TIERS[tier].label}: ${run.first.status || '—'} / ${run.first.type || '—'}, ${range(run)}`));
    chart.append(bar);
  }
}

const SPECTRUM_PLOTS = [
  {
    id: 'L1', min: 1559, max: 1610,
    signals: [
      ['GPS L1 C/A', 'GPS', 1575.42, 2.046],
      ['GPS L1C', 'GPS', 1575.42, 4.092],
      ['Galileo E1', 'Galileo', 1575.42, 4.092],
      ['GLONASS L1', 'GLONASS', 1598.0625, 1605.375],
      ['BeiDou B1I', 'BeiDou', 1561.098, 4.092],
      ['BeiDou B1C', 'BeiDou', 1575.42, 32.736],
    ],
  },
  {
    id: 'L2', min: 1215, max: 1300,
    signals: [
      ['GPS L2C', 'GPS', 1227.60, 20.46],
      ['GLONASS L2', 'GLONASS', 1242.9375, 1248.625],
      ['BeiDou B3', 'BeiDou', 1260, 1278],
    ],
  },
  {
    id: 'L5', min: 1164, max: 1215,
    signals: [
      ['GPS L5C', 'GPS', 1176.45, 20.46],
      ['Galileo E5a', 'Galileo', 1176.45, 20.46],
      ['Galileo E5b', 'Galileo', 1207.14, 20.46],
      ['BeiDou B2a', 'BeiDou', 1176.45, 20.46],
      ['BeiDou B2b', 'BeiDou', 1207.14, 20.46],
      ['NavIC L5', 'NavIC', 1176.45, 20.46],
    ],
  },
];

const SPECTRUM_COLORS = {
  'GPS L1 C/A': '#56b4e9',
  'GPS L1C': '#ffb000',
  'Galileo E1': '#00dfaf',
  'GLONASS L1': '#ed72b4',
  'BeiDou B1I': '#c6a0ff',
  'BeiDou B1C': '#f0e442',
  'GPS L2C': '#56b4e9',
  'GLONASS L2': '#ffb000',
  'BeiDou B3': '#00dfaf',
  'GPS L5C': '#56b4e9',
  'Galileo E5a': '#ffb000',
  'Galileo E5b': '#00dfaf',
  'BeiDou B2a': '#ed72b4',
  'BeiDou B2b': '#c6a0ff',
  'NavIC L5': '#f0e442',
};
const spectrumCharts = new Map();

/**
 * Turns a centre-plus-width or a start-end pair into a frequency span in MHz.
 * @param {Array} allocation Label, system, centre or start, width or end.
 * @returns {object}
 * Side effects: none. events: none.
 */
function spectrumAllocation([label, system, centerOrStart, widthOrEnd]) {
  return {
    label,
    min: widthOrEnd > centerOrStart ? centerOrStart : centerOrStart - widthOrEnd / 2,
    max: widthOrEnd > centerOrStart ? widthOrEnd : centerOrStart + widthOrEnd / 2,
  };
}

/**
 * Collapses detections that share a pixel and a signal, keeping the strongest.
 * Without yFor, frequency and bandwidth stay in the key so two tones on one time pixel stay distinct.
 * With yFor, frequency and bandwidth are rounded to pixels: marks that occupy the same spot are one node.
 * @param {Array} hits Hit objects.
 * @param {Function} xFor Maps a time to an x position.
 * @param {Function} [yFor] Maps a frequency in MHz to a y position.
 * @returns {Array}
 * Side effects: none. events: none.
 */
function spectrumMarkers(hits, xFor, yFor) {
  const markers = new Map();
  for (const { sample, detection } of hits) {
    const x = Math.round(xFor(sample.t));
    let key;
    if (typeof yFor === 'function' && Number.isFinite(detection.freq)) {
      const mhz = detection.freq / 1e6;
      const y = Math.round(yFor(mhz));
      const half = Number.isFinite(detection.bandwidth) && detection.bandwidth > 0 ? detection.bandwidth / 2e6 : 0;
      const height = Math.round(Math.abs(yFor(mhz - half) - yFor(mhz + half)));
      key = `${x}:${y}:${sample.signal}:${height}`;
    } else {
      key = JSON.stringify([x, sample.signal, detection.freq, detection.bandwidth]);
    }
    const existing = markers.get(key);
    if (!existing) {
      markers.set(key, { sample, detection, count: 1, start: sample.t, end: sample.t });
      continue;
    }
    existing.count++;
    existing.start = Math.min(existing.start, sample.t);
    existing.end = Math.max(existing.end, sample.t);
    if (Number.isFinite(detection.power)
      && (!Number.isFinite(existing.detection.power) || detection.power > existing.detection.power)) {
      existing.sample = sample;
      existing.detection = detection;
    }
  }
  return [...markers.values()];
}

/**
 * Draws the L1, L2, and L5 frequency-time plots for live and archive hits in the viewport.
 * @param {number} start Viewport start.
 * @param {number} end Viewport end.
 * @param {number} windowMs Viewport length.
 * @returns {void}
 * Side effects: DOM spectrum sections and SVG. The first build adds click and pointer listeners. events: none.
 */
function renderSpectrumPlots(start, end, windowMs) {
  const container = $('spectrum-plots');
  const availableWidth = Math.min(1920, Math.max(360, Math.round(container.getBoundingClientRect().width) || 900));
  const { left, right } = TIMELINE;
  const now = Date.now();
  const axis = timelineAxis(start, windowMs, availableWidth - left - right, now);
  const historyHits = state.interferenceHistory.filter((sample) => sample.t >= start && sample.t <= axis.dataEnd
    && sample.count > 0);
  const archiveData = state.archive?.shown ? state.archive.data : null;
  const archiveHits = archiveData
    ? archiveData.samples.filter((sample) => sample.t >= start && sample.t <= axis.dataEnd && sample.count > 0) : [];

  for (const plot of SPECTRUM_PLOTS) {
    const top = 18;
    const axisHeight = 40;
    const plotHeight = 220;
    const height = top + plotHeight + axisHeight;
    const plotWidth = availableWidth - left - right;
    /** @param {number} time @returns {number} X on this frequency plot. Side effects: none. Events: none. */
    const xFor = (time) => left + axis.x(time);
    /** @param {number} frequency MHz. @returns {number} Y, high frequency toward the top. Side effects: none. Events: none. */
    const yFor = (frequency) => top + (plot.max - frequency) / (plot.max - plot.min) * plotHeight;
    let elements = spectrumCharts.get(plot.id);
    if (!elements) {
      const section = document.createElement('section');
      section.className = 'spectrum-chart';
      const heading = document.createElement('h3');
      heading.textContent = { L1: 'L1 / E1 / B1 / G1', L2: 'L2 / G2 / B3', L5: 'L5 / E5 / B2' }[plot.id];
      const hitSummary = document.createElement('span');
      hitSummary.className = 'spectrum-hit-count';
      heading.append(hitSummary);
      const key = document.createElement('div');
      key.className = 'spectrum-key';
      key.setAttribute('aria-label', `${plot.id} signal visibility`);
      const buttons = new Map();
      for (const [label] of plot.signals) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'spectrum-key-item';
        button.style.setProperty('--signal-color', SPECTRUM_COLORS[label]);
        const swatch = document.createElement('i');
        button.append(swatch, document.createTextNode(label));
        button.addEventListener('click', () => {
          if (state.hiddenSignals.has(label)) state.hiddenSignals.delete(label);
          else state.hiddenSignals.add(label);
          writePreference('hiddenSignals', JSON.stringify([...state.hiddenSignals]));
          renderTimeline();
        });
        buttons.set(label, button);
        key.append(button);
      }
      const svgChart = svg('svg', { role: 'img' });
      initTimePlotNavigation(svgChart);
      section.append(heading, key, svgChart);
      container.append(section);
      elements = { svgChart, hitSummary, buttons };
      spectrumCharts.set(plot.id, elements);
    }
    const { svgChart, hitSummary, buttons } = elements;
    svgChart.setAttribute('aria-label', `${plot.id} frequency (MHz) over time (${state.timeZone})`);
    svgChart.setAttribute('viewBox', `0 0 ${availableWidth} ${height}`);
    svgChart.replaceChildren();
    for (const [label, button] of buttons) {
      button.setAttribute('aria-pressed', String(!state.hiddenSignals.has(label)));
    }
    const allocations = plot.signals.map(spectrumAllocation).filter(({ label }) => !state.hiddenSignals.has(label));
    // Split overlapping allocations into coloured stripes so none hides another.
    const boundaries = [...new Set([plot.min, plot.max, ...allocations.flatMap(({ min, max }) =>
      [Math.max(plot.min, min), Math.min(plot.max, max)])])].sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++) {
      const low = boundaries[i - 1];
      const high = boundaries[i];
      const active = allocations.filter(({ min, max }) => min < high && max > low);
      active.forEach((allocation, index) => {
        const stripeHeight = (yFor(low) - yFor(high)) / active.length;
        const stripe = svg('rect', {
          x: left, y: yFor(high) + index * stripeHeight, width: plotWidth,
          height: stripeHeight, fill: SPECTRUM_COLORS[allocation.label], class: 'spectrum-signal',
        });
        stripe.append(svg('title', {}, `${allocation.label}: ${allocation.min.toFixed(3)}-${allocation.max.toFixed(3)} MHz`
          + (active.length > 1 ? ' (striped overlap)' : '')));
        svgChart.append(stripe);
      });
    }
    allocations.forEach(({ label, min, max }) => {
      const outline = svg('rect', {
        x: left, y: yFor(Math.min(plot.max, max)), width: plotWidth,
        height: yFor(Math.max(plot.min, min)) - yFor(Math.min(plot.max, max)),
        fill: 'none', stroke: SPECTRUM_COLORS[label], class: 'spectrum-allocation-outline',
      });
      outline.append(svg('title', {}, `${label}: ${min.toFixed(3)}-${max.toFixed(3)} MHz`));
      svgChart.append(outline);
    });
    const centres = new Map();
    for (const { label, min, max } of allocations) {
      const centre = (min + max) / 2;
      const labels = centres.get(centre) || [];
      labels.push(label);
      centres.set(centre, labels);
    }
    for (const [centre, labels] of centres) {
      if (centre < plot.min || centre > plot.max) continue;
      labels.forEach((label, index) => {
        const guide = svg('line', {
          x1: left, x2: left + plotWidth, y1: yFor(centre), y2: yFor(centre),
          stroke: SPECTRUM_COLORS[label], 'stroke-dasharray': `6 ${labels.length * 10 - 6}`,
          'stroke-dashoffset': -index * 10, class: 'spectrum-centre-line',
        });
        guide.append(svg('title', {}, `${label} centre: ${centre.toFixed(3)} MHz`
          + (labels.length > 1 ? ` (shared with ${labels.filter((name) => name !== label).join(', ')})` : '')));
        svgChart.append(guide);
      });
    }

    /**
     * Detections whose centre, widened by half the bandwidth, intersects this plot's MHz range.
     * @param {object[]} samples
     * @returns {{ sample: object, detection: object }[]}
     * Side effects: none. Events: none.
     */
    const hitsIn = (samples) => {
      const hits = [];
      for (const sample of samples) {
        const detections = Array.isArray(sample.detections) && sample.detections.length
          ? sample.detections
          : Number.isFinite(sample.freq) ? [{ freq: sample.freq, bandwidth: null, power: sample.maxPower }] : [];
        for (const detection of detections) {
          if (!Number.isFinite(detection.freq)) continue;
          const halfBandwidth = Number.isFinite(detection.bandwidth) && detection.bandwidth > 0 ? detection.bandwidth / 2e6 : 0;
          if (detection.freq / 1e6 + halfBandwidth < plot.min || detection.freq / 1e6 - halfBandwidth > plot.max) continue;
          hits.push({ sample, detection });
        }
      }
      return hits;
    };
    const plotHits = hitsIn(historyHits);
    const archivePlotHits = hitsIn(archiveHits);
    const visibleHits = spectrumMarkers(plotHits, xFor, yFor);
    const visibleArchiveHits = spectrumMarkers(archivePlotHits, xFor, yFor);
    hitSummary.textContent = plotHits.length ? `${plotHits.length} hit${plotHits.length === 1 ? '' : 's'}` : 'No frequency hits';
    if (archivePlotHits.length) {
      hitSummary.textContent += ` · ${archivePlotHits.length} archive`;
    }

    const hitMarkers = [
      ...visibleArchiveHits.map((hit) => ({ ...hit, archive: true })),
      ...visibleHits.map((hit) => ({ ...hit, archive: false })),
    ];
    for (const { sample, detection, archive, count, start: firstTime, end: lastTime } of hitMarkers) {
      const centerMHz = detection.freq / 1e6;
      const halfBandwidthMHz = Number.isFinite(detection.bandwidth) && detection.bandwidth > 0
        ? detection.bandwidth / 2e6
        : 0;
      const y1 = Math.max(top, yFor(centerMHz + halfBandwidthMHz));
      const y2 = Math.min(top + plotHeight, yFor(centerMHz - halfBandwidthMHz));
      const markerHeight = Math.max(3, y2 - y1);
      const marker = svg('rect', {
        x: Math.max(left, Math.min(left + plotWidth - 4, xFor(sample.t) - 2)),
        y: Math.max(top, Math.min(top + plotHeight - markerHeight, y1)),
        width: 4,
        height: markerHeight,
        class: archive ? 'spectrum-detection archive' : 'spectrum-detection',
      });
      const title = svg('title', {}, `${archive ? 'Archive ' : ''}${sample.signal}: ${centerMHz.toFixed(3)} MHz`
        + (Number.isFinite(detection.bandwidth) ? `, ${(detection.bandwidth / 1e6).toFixed(3)} MHz bandwidth` : '')
        + (Number.isFinite(detection.power) ? `, ${detection.power.toFixed(1)} dBm` : '')
        + `, ${formatTimestamp(sample.t, true)}`
        + (count > 1 ? `; ${count} detections, ${formatTimestamp(firstTime, true)}`
          + ` - ${formatTimestamp(lastTime, true)} (strongest shown)` : ''));
      marker.append(title);
      svgChart.append(marker);
    }

    for (let tick = 0; tick <= 4; tick++) {
      const frequency = plot.min + ((plot.max - plot.min) * tick) / 4;
      for (const [x, className] of [[left - 8, 'spectrum-label'], [left + plotWidth + 8, 'spectrum-label spectrum-label-right']]) {
        svgChart.append(svg('text', { x, y: yFor(frequency) + 4, class: className }, frequency.toFixed(1)));
      }
    }
    appendSelectionMarker(svgChart, `spectrum-${plot.id}`, axis, top, top + plotHeight);
    appendTimeAxis(svgChart, axis, {
      left, top, bottom: top + plotHeight,
      labelY: height - 19,
      nowLabelY: 12,
      gridClass: 'spectrum-grid',
      labelClass: 'spectrum-axis',
    }, now);
    svgChart.append(svg('text', { x: left - 8, y: 11, class: 'spectrum-label' }, 'MHz'));
    svgChart.append(svg('text', { x: left + plotWidth + 8, y: 11, class: 'spectrum-label spectrum-label-right' }, 'MHz'));
  }
}

/**
 * Formats a timeline timestamp in the selected time zone.
 * @param {number} timestamp Epoch milliseconds.
 * @param {number} [windowMs] Window used to choose the fields.
 * @returns {string}
 * Side effects: none. events: none.
 */
function utcLabel(timestamp, windowMs = timelineViewport().windowMs) {
  return timelineTimeLabel(timestamp, windowMs);
}

/**
 * Formats a timestamp, adding seconds under one hour and the day above one day.
 * @param {number} timestamp Epoch milliseconds.
 * @param {number} windowMs Viewport length.
 * @returns {string}
 * Side effects: may cache an Intl formatter via dateFormatter. events: none.
 */
function timelineTimeLabel(timestamp, windowMs) {
  return dateFormatter({
    timeZone: state.timeZone, hour: '2-digit', minute: '2-digit',
    ...(windowMs < 3600000 ? { second: '2-digit' } : {}),
    ...(windowMs > 86400000 ? { day: '2-digit', month: 'short' } : {}),
    hourCycle: 'h23',
  }).format(new Date(timestamp));
}

/**
 * Colour for a detection power: red above -95 dBm, amber above -110, otherwise pale.
 * @param {number} powerDbm Power in dBm.
 * @returns {string}
 * Side effects: none. events: none.
 */
function powerColour(powerDbm) {
  if (!Number.isFinite(powerDbm)) return '#ffb02e';
  if (powerDbm > -95) return '#ff5f56';
  if (powerDbm > -110) return '#ffb02e';
  return '#ffd98a';
}

/**
 * History-window label in hours or minutes.
 * @param {number} minutes Window length in minutes.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatWindow(minutes) {
  if (minutes >= 60) return `${Math.round(minutes / 60)} h`;
  return `${minutes} min`;
}

/**
 * Compact age label in seconds, minutes, or hours.
 * @param {number} timestamp Epoch milliseconds.
 * @returns {string}
 * Side effects: none. Reads Date.now(). events: none.
 */
function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

// --- point selection ----------------------------------------------------------

const SELECT_RADIUS_PX = 14;

/**
 * Turns timeline point selection on or off and updates the toggle button.
 * @param {boolean} enabled Whether select mode should be on.
 * @returns {void}
 * Side effects: state.selectMode and DOM classes and button text. events: none.
 */
function setSelectMode(enabled) {
  state.selectMode = Boolean(enabled);
  const button = $('timeline-select');
  button.setAttribute('aria-pressed', String(state.selectMode));
  button.classList.toggle('active', state.selectMode);
  button.innerHTML = state.selectMode ? '&#8598; Selecting (Esc to stop)' : '&#8598; Select point';
  for (const chart of timePlotCharts()) chart.classList.toggle('select-mode', state.selectMode);
}

/**
 * The interference timeline SVG plus any spectrum plot SVGs already built.
 * @returns {Array<SVGElement>}
 * Side effects: none. events: none.
 */
function timePlotCharts() {
  return [$('timeline'), ...[...spectrumCharts.values()].map(({ svgChart }) => svgChart)];
}

/**
 * Stores a pinned time-plot selection and redraws the timeline.
 * @param {object|null} selection Selection with plot, time, y, and text, or null to clear.
 * @returns {void}
 * Side effects: state.timelineSelection, the selection panel DOM, and a timeline redraw. events: none.
 */
function setTimelineSelection(selection) {
  state.timelineSelection = selection;
  const panel = $('timeline-selection');
  panel.hidden = !selection;
  $('timeline-selection-text').textContent = selection ? selection.text : '';
  renderTimeline();
}

/** Finds the titled data element nearest the click (within SELECT_RADIUS_PX), preferring the smallest hit. */
function pickTimePlotElement(chart, clientX, clientY) {
  let best = null;
  for (const title of chart.querySelectorAll('title')) {
    const element = title.parentNode;
    if (!element || element === chart || element.tagName === 'text' || element.classList.contains('tl-now-line')) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
    const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance > SELECT_RADIUS_PX) continue;
    const area = rect.width * rect.height;
    if (!best || distance < best.distance - 0.5 || (Math.abs(distance - best.distance) <= 0.5 && area < best.area)) {
      best = { element, rect, distance, area, text: title.textContent };
    }
  }
  return best;
}

/**
 * Pins the titled mark under a click, or clears the selection when nothing is in range.
 * @param {SVGElement} chart Plot that received the pointer.
 * @param {number} clientX Pointer x.
 * @param {number} clientY Pointer y.
 * @returns {void}
 * Side effects: state and DOM via setTimelineSelection. Returns without a change when the screen matrix is missing. events: none.
 */
function selectTimePlotPoint(chart, clientX, clientY) {
  const axis = chart.timeAxis;
  const hit = pickTimePlotElement(chart, clientX, clientY);
  if (!axis || !hit) {
    setTimelineSelection(null);
    return;
  }
  // Narrow markers snap to their centre; wide bars and areas keep the clicked position.
  const narrow = hit.rect.width <= 12;
  const pointX = narrow ? (hit.rect.left + hit.rect.right) / 2 : Math.max(hit.rect.left, Math.min(hit.rect.right, clientX));
  const pointY = hit.rect.height <= 12 ? (hit.rect.top + hit.rect.bottom) / 2 : clientY;
  const matrix = chart.getScreenCTM();
  if (!matrix) return;
  const local = new DOMPoint(pointX, pointY).matrixTransform(matrix.inverse());
  const t = axis.start + (local.x - TIMELINE.left) / axis.plotWidth * axis.axisMs;
  setTimelineSelection({ plot: chart.plotKey, t, y: local.y, text: hit.text });
}

$('timeline-select').addEventListener('click', () => setSelectMode(!state.selectMode));
$('timeline-selection-clear').addEventListener('click', () => setTimelineSelection(null));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !$('tab-interference')?.classList.contains('active')) return;
  if (state.selectMode) setSelectMode(false);
  else if (state.timelineSelection) setTimelineSelection(null);
});
$('timeline-preset').addEventListener('change', (event) => applyTimelinePreset(event.target.value));

// --- wall display -------------------------------------------------------------

let wallWakeLock = null;
let wallCursorTimer = null;

/** Large-screen view of the Interference tab: status banner, L1/L2/L5 band cards and the live power plot. */
function setWallMode(enabled, { fullscreen = false } = {}) {
  state.wall = Boolean(enabled);
  document.documentElement.classList.toggle('wall', state.wall);
  const button = $('wall-toggle');
  button.textContent = state.wall ? 'Exit wall display' : '\u26F6 Wall display';
  button.setAttribute('aria-pressed', String(state.wall));
  const url = new URL(location.href);
  if (state.wall) url.searchParams.set('wall', '1');
  else url.searchParams.delete('wall');
  history.replaceState(null, '', url);
  if (state.wall) {
    // Dispatches a DOM click on the Interference tab button.
    document.querySelector('button.tab[data-tab="interference"]')?.click();
    if (state.selectMode) setSelectMode(false);
    state.timelineView = null;
    if (fullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    requestWallWakeLock();
    wallCursorActivity();
  } else {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    wallWakeLock?.release().catch(() => {});
    wallWakeLock = null;
    clearTimeout(wallCursorTimer);
    document.documentElement.classList.remove('wall-idle');
  }
  timelineDirty = true;
  flushUpdates(true);
}

/** Keeps the screen on while the wall display is shown, where the browser allows it. */
async function requestWallWakeLock() {
  if (!state.wall || wallWakeLock || document.hidden || !navigator.wakeLock) return;
  try {
    wallWakeLock = await navigator.wakeLock.request('screen');
    wallWakeLock.addEventListener('release', () => { wallWakeLock = null; });
  } catch {
    wallWakeLock = null;
  }
}

/** Hides the mouse pointer after a few seconds without movement. */
function wallCursorActivity() {
  document.documentElement.classList.remove('wall-idle');
  clearTimeout(wallCursorTimer);
  if (state.wall) wallCursorTimer = setTimeout(() => document.documentElement.classList.add('wall-idle'), 4000);
}

$('wall-toggle').addEventListener('click', () => setWallMode(!state.wall, { fullscreen: !state.wall }));
document.addEventListener('pointermove', () => { if (state.wall) wallCursorActivity(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) requestWallWakeLock(); });
let wallResizeFrame = 0;

/** One pending frame for a wall resize. Hidden tabs do not queue frames. */
function scheduleWallReflow() {
  if (!state.wall || document.hidden || wallResizeFrame) return;
  wallResizeFrame = requestAnimationFrame(() => {
    wallResizeFrame = 0;
    if (document.hidden) return;
    timelineDirty = true;
    flushUpdates();
  });
}

/** Drops a wall resize frame that has not run yet. */
function cancelWallReflow() {
  if (!wallResizeFrame) return;
  cancelAnimationFrame(wallResizeFrame);
  wallResizeFrame = 0;
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => scheduleWallReflow()).observe($('timeline'));
}
// Deferred until the rest of the script has initialised the state that rendering relies on.
if (new URLSearchParams(location.search).has('wall')) queueMicrotask(() => setWallMode(true));

// --- historic archive -------------------------------------------------------

const ARCHIVE_BUSY = new Set(['listing', 'scanning']);
const archiveFetch = { timer: null, delay: 0, controller: null, wanted: null, generation: 0, startedAt: 0 };

/**
 * Byte count as GB, MB, or kB, or a question mark when not finite.
 * @param {number} bytes Size in bytes.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/**
 * Duration as seconds, minutes and seconds, or hours and minutes.
 * @param {number} ms Duration in milliseconds.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Stores archive status from an SSE archive event, a snapshot, or an archive POST.
 * @param {object} status Status object. state must be a string.
 * @returns {void}
 * Side effects: throws when state is not a string. idle clears loaded samples. idle or a generation mismatch aborts the data fetch. May show the whole archive. Redraws archive status and marks the timeline dirty. events: none.
 */
function applyArchiveStatus(status) {
  // Status with a non-string state is rejected. Callers are the archive SSE event, snapshots, and archive POST responses.
  if (typeof status.state !== 'string') throw new Error('Invalid archive status');
  const previous = state.archive.status;
  if (!previous || previous.generation !== status.generation) archiveFetch.startedAt = Date.now();
  state.archive.status = status;
  // A new generation (e.g. a finished background refresh) keeps drawing the old data until the refetch lands.
  if (status.state === 'idle') state.archive.data = null;
  if (status.state === 'idle' || (state.archive.data && state.archive.data.generation !== status.generation)) {
    archiveFetch.controller?.abort();
  }
  // A page opened while an archive is loaded starts by showing the whole range.
  if (!previous && status.state !== 'idle' && state.archive.shown && !state.timelineView) showWholeArchive();
  renderArchiveStatus();
  timelineDirty = true;
}

/**
 * Fills the archive badge, progress, buttons, and status text from state.archive.
 * @returns {void}
 * Side effects: DOM in the archive panel. events: none.
 */
function renderArchiveStatus() {
  const status = state.archive.status;
  const known = Boolean(status);
  const busy = known && ARCHIVE_BUSY.has(status.state);
  const pending = state.archive.requestPending;
  $('archive-root').disabled = !known || pending;
  $('archive-days').disabled = !known || pending;
  $('archive-load').disabled = !known || pending;
  $('archive-load').textContent = busy ? 'Restart load' : status && status.state !== 'idle' ? 'Reload' : 'Load history';
  $('archive-cancel').disabled = !busy || pending;
  $('archive-clear').disabled = !known || status.state === 'idle' || pending;
  $('archive-default').disabled = !state.archive.defaults || pending;
  $('archive-show').checked = state.archive.shown;
  $('archive-auto').disabled = !known || pending;
  $('archive-auto').checked = Boolean(status?.auto?.enabled);

  const badge = $('archive-badge');
  const badgeState = !known ? 'idle' : busy ? 'busy' : status.state === 'error' ? 'error'
    : status.state === 'idle' ? 'idle' : status.errors?.length || status.state === 'cancelled' || status.auto?.lastError
      ? 'warning' : 'ready';
  badge.className = `archive-badge ${badgeState}`;
  badge.textContent = !known ? 'Unavailable' : status.refreshing ? 'Refreshing…' : {
    idle: 'Not loaded', listing: 'Searching…', scanning: 'Loading…', ready: 'Loaded', cancelled: 'Partly loaded', error: 'Failed',
  }[status.state] || status.state;
  $('archive-panel').setAttribute('aria-busy', String(busy));

  const progress = $('archive-progress');
  progress.hidden = !busy;
  if (status?.state === 'scanning' && status.bytesTotal > 0) {
    progress.max = status.bytesTotal;
    progress.value = Math.min(status.bytesTotal, status.bytesDone);
  } else {
    progress.removeAttribute('value');
  }

  const parts = [];
  if (!known) {
    parts.push('Archive status unavailable.');
  } else if (status.state === 'idle') {
    parts.push(status.message || 'No archive loaded. Choose a folder and how many days to load, then select Load history.');
  } else {
    /** @param {number} time @returns {string} Day, month, and clock time in the selected zone. Side effects: none. Events: none. */
    const dateLabel = (time) => dateFormatter({
      timeZone: state.timeZone, hourCycle: 'h23', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(time));
    const range = Number.isFinite(status.from) ? `${dateLabel(status.from)} – ${dateLabel(status.to)}` : '';
    if (status.refreshing) parts.push(`Refreshing in the background; still showing ${range || 'the previously loaded data'}.`);
    if (status.state === 'listing') parts.push(status.message || 'Searching for log files…');
    if (status.state === 'scanning') {
      const elapsed = Date.now() - (status.refreshing && Number.isFinite(status.startedAt) ? status.startedAt : archiveFetch.startedAt);
      const remaining = status.bytesDone > 0 && elapsed > 3000
        ? elapsed * (status.bytesTotal - status.bytesDone) / status.bytesDone : null;
      parts.push(`Reading file ${Math.min(status.filesDone + 1, status.filesTotal)} of ${status.filesTotal}`
        + `${status.filesCached ? ` (${status.filesCached} from cache)` : ''}`
        + ` · ${formatBytes(status.bytesDone)} of ${formatBytes(status.bytesTotal)}`
        + (Number.isFinite(remaining) ? ` · about ${formatDuration(remaining)} left` : '')
        + (status.currentFile ? ` · ${status.currentFile.split(/[\\/]/).pop()}.` : '.'));
    }
    if (status.state === 'ready' || status.state === 'cancelled') {
      if (status.message) parts.push(status.message);
      parts.push(`${status.filesDone} of ${status.filesTotal} files read${status.filesCached ? ` (${status.filesCached} from cache)` : ''}`
        + `${Number.isFinite(status.finishedAt) && Number.isFinite(status.startedAt)
          ? ` in ${formatDuration(status.finishedAt - status.startedAt)}` : ''}.`);
    }
    if (status.state === 'error') parts.push(status.message || 'Archive loading failed.');
    if (status.state !== 'listing') {
      parts.push(`${status.reports.toLocaleString()} status reports, ${status.samples.toLocaleString()} seconds with detections`
        + `${status.resolutionMs > 1000 ? ` (stored at ${formatSpan(status.resolutionMs)} resolution)` : ''}`
        + ` · ${(status.solutionReports || 0).toLocaleString()} BESTPOS reports, ${(status.solutionSamples || 0).toLocaleString()} solution intervals`
        + ` · ${(status.bestsatsReports || 0).toLocaleString()} BESTSATS reports (satellite-count fallback)`
        + `${status.bestsatsResolutionMs > 1000 ? ` (stored at ${formatSpan(status.bestsatsResolutionMs)} resolution)` : ''}`
        + `${status.solutionResolutionMs > 1000 ? ` (stored at ${formatSpan(status.solutionResolutionMs)} resolution)` : ''}`
        + `${range ? ` · ${range}` : ''}.`);
    }
    if (status.crcErrors) parts.push(`${status.crcErrors} corrupt reports skipped.`);
    if (status.errors?.length) parts.push(`${status.errors.length} problem${status.errors.length === 1 ? '' : 's'}: ${status.errors.slice(0, 3).join('; ')}`);
  }
  const auto = status?.auto;
  if (auto?.enabled) {
    /** @param {number} time @returns {string} Hours and minutes in the selected zone. Side effects: none. Events: none. */
    const clock = (time) => dateFormatter({ timeZone: state.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .format(new Date(time));
    parts.push(`Keep loaded: on, every ${formatSpan(auto.refreshMs || 900000)}`
      + `${Number.isFinite(auto.lastRunAt) ? ` · last refresh ${clock(auto.lastRunAt)}` : ''}`
      + `${Number.isFinite(auto.nextRunAt) ? ` · next ${clock(auto.nextRunAt)}` : ''}.`
      + `${auto.lastError ? ` Last refresh problem: ${auto.lastError}.` : ''}`);
  }
  $('archive-status').textContent = parts.join(' ');
  $('archive-summary').textContent = archiveSummary(status, known, busy);
}

/** One-line archive state for the collapsed panel header. */
function archiveSummary(status, known, busy) {
  if (!known) return '';
  if (status.state === 'idle') return 'Expand to choose days and load history';
  /** @param {number} time @returns {string} Short date and time in the selected zone. Side effects: none. Events: none. */
  const clock = (time) => dateFormatter({
    timeZone: state.timeZone, hourCycle: 'h23', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(time));
  const bits = [];
  if (busy && status.state === 'listing') bits.push('Searching for log files…');
  else if (busy && status.state === 'scanning') {
    const percent = status.bytesTotal > 0 ? Math.floor(100 * status.bytesDone / status.bytesTotal) : 0;
    bits.push(`File ${Math.min(status.filesDone + 1, status.filesTotal)} of ${status.filesTotal} · ${percent}%`);
  }
  if (Number.isFinite(status.from)) bits.push(`${clock(status.from)} – ${clock(status.to)}`);
  if (status.auto?.enabled) bits.push(`auto-refresh every ${formatSpan(status.auto.refreshMs || 900000)}`);
  if (status.state === 'error' || status.auto?.lastError || status.errors?.length) bits.push('problem – expand for details');
  return bits.join(' · ');
}

/** Fetches archive data for the visible range (debounced), at roughly one bucket per pixel. */
function ensureArchiveData(start, end, plotWidth) {
  const archive = state.archive;
  const status = archive.status;
  if (!archive.shown || !status || status.state === 'idle' || !Number.isFinite(status.from)) return;
  const from = Math.max(start, status.from);
  const to = Math.min(end, status.to);
  if (to <= from) return;
  const wantedBucket = Math.max(1000, (end - start) / Math.max(100, plotWidth));
  const data = archive.data;
  const covers = data && data.generation === status.generation && data.from <= from && data.to >= to
    && data.bucketMs <= Math.max(wantedBucket * 1.5, data.resolutionMs);
  if (covers && data.revision === status.revision && data.resolutionMs === status.resolutionMs) return;
  archiveFetch.wanted = { start, end, plotWidth };
  // New data arriving during a scan is refreshed slowly; navigating to an unfetched range is fast.
  const delay = covers ? 1500 : 150;
  if (archiveFetch.timer && archiveFetch.delay <= delay) return;
  clearTimeout(archiveFetch.timer);
  archiveFetch.delay = delay;
  archiveFetch.timer = setTimeout(fetchArchiveData, delay);
}

/**
 * GET /api/archive/interference for the wanted range and stores it when the generation still matches.
 * @returns {Promise<void>}
 * Side effects: aborts the previous archive fetch. An invalid body throws into the catch. Aborted or stale responses are ignored. Other failures call reportClientError. events: none.
 */
async function fetchArchiveData() {
  archiveFetch.timer = null;
  const status = state.archive.status;
  const wanted = archiveFetch.wanted;
  if (!wanted || !status || status.state === 'idle') return;
  const span = wanted.end - wanted.start;
  const from = Math.max(status.from, wanted.start - span / 2);
  const to = Math.min(status.to, wanted.end + span / 2);
  if (to <= from) return;
  const buckets = Math.min(4000, Math.max(10, Math.round(wanted.plotWidth * (to - from) / span)));
  archiveFetch.controller?.abort();
  const controller = new AbortController();
  archiveFetch.controller = controller;
  const generation = status.generation;
  try {
    // GET /api/archive/interference. Aborted and stale-generation responses are ignored; other failures are reported.
    const data = await request(`/api/archive/interference?from=${Math.floor(from)}&to=${Math.ceil(to)}&buckets=${buckets}`,
      { signal: controller.signal }, true);
    if (controller.signal.aborted || state.archive.status?.generation !== generation) return;
    if (!data || !Array.isArray(data.samples) || !Array.isArray(data.coverage) || !Number.isFinite(data.bucketMs)
      || !Array.isArray(data.solution) || !Array.isArray(data.bestsats)
      || [...data.solution, ...data.bestsats].some((sample) => !sample || !Number.isFinite(sample.t)
        || !Number.isFinite(sample.end) || sample.end < sample.t
        || (sample.used !== null && (!Number.isInteger(sample.used) || sample.used < 0 || sample.used > 255))
        || (sample.tracked !== null && (!Number.isInteger(sample.tracked) || sample.tracked < 0 || sample.tracked > 255))
        || (sample.type !== null && typeof sample.type !== 'string')
        || (sample.status !== null && typeof sample.status !== 'string'))
      || data.samples.some((sample) => !sample || !Number.isFinite(sample.t) || typeof sample.signal !== 'string'
        || !Number.isFinite(sample.count) || (sample.detections !== undefined && !Array.isArray(sample.detections)))) {
      throw new Error('Invalid archive response');
    }
    state.archive.data = { ...data, generation };
    timelineDirty = true;
  } catch (error) {
    if (!controller.signal.aborted) reportClientError('Could not load archive data', error);
  } finally {
    if (archiveFetch.controller === controller) archiveFetch.controller = null;
  }
}

/**
 * POST JSON to an archive URL and applies the status body.
 * @param {string} url Archive path.
 * @param {object} [body] JSON body. Defaults to an empty object.
 * @returns {Promise<object>}
 * Side effects: network, requestPending, and archive status DOM. Throws data.error or the HTTP status. events: none.
 */
async function archiveRequest(url, body) {
  state.archive.requestPending = true;
  renderArchiveStatus();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    applyArchiveStatus(data);
    return data;
  } finally {
    state.archive.requestPending = false;
    renderArchiveStatus();
  }
}

/** Shows the whole loaded range while following live time. */
function showWholeArchive() {
  const status = state.archive.status;
  if (!status || !Number.isFinite(status.from)) return;
  state.timelineView = { end: Date.now(), windowMs: Date.now() - status.from, follow: true, preset: 'archive' };
  timelineDirty = true;
}

/**
 * GET /api/archive and fills defaults, the day limit, the form, and current status.
 * @returns {Promise<void>}
 * Side effects: network, state.archive.defaults, and DOM. On failure writes the error into #archive-status. events: none.
 */
async function loadArchiveSettings() {
  try {
    // GET /api/archive. A failure is caught below and written to #archive-status.
    const info = await request('/api/archive', {}, true);
    state.archive.defaults = info.defaults;
    const maxDays = info.limits?.maxDays || 31;
    const select = $('archive-days');
    for (const option of [...select.options]) {
      if (Number(option.value) > maxDays) option.remove();
    }
    const days = String(info.settings?.days || 1);
    if (![...select.options].some((option) => option.value === days)) {
      select.append(new Option(`Last ${days} days`, days));
    }
    select.value = days;
    $('archive-root').value = info.settings?.root || '';
    applyArchiveStatus(info.status);
  } catch (error) {
    $('archive-status').textContent = `Could not read archive settings: ${error.message}`;
  }
}

$('archive-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    // POST /api/archive/load. The catch writes #archive-status and sets the Failed badge.
    await archiveRequest('/api/archive/load', { root: $('archive-root').value.trim(), days: Number($('archive-days').value) });
    state.archive.data = null;
    if (!state.archive.shown) {
      state.archive.shown = true;
      writePreference('archiveShown', 'true');
    }
    showWholeArchive();
    flushUpdates(true);
  } catch (error) {
    $('archive-status').textContent = `Could not start loading: ${error.message}`;
    $('archive-badge').className = 'archive-badge error';
    $('archive-badge').textContent = 'Failed';
  }
});

$('archive-cancel').addEventListener('click', () => {
  // POST /api/archive/cancel. The catch writes error.message into #archive-status.
  archiveRequest('/api/archive/cancel').catch((error) => { $('archive-status').textContent = error.message; });
});

$('archive-clear').addEventListener('click', () => {
  // POST /api/archive/clear. On success the timeline returns to live; the catch writes #archive-status.
  archiveRequest('/api/archive/clear').then(() => {
    state.timelineView = null;
    flushUpdates(true);
  }).catch((error) => { $('archive-status').textContent = error.message; });
});

$('archive-default').addEventListener('click', () => {
  if (!state.archive.defaults) return;
  $('archive-root').value = state.archive.defaults.root;
  $('archive-days').value = String(state.archive.defaults.days);
});

$('archive-show').addEventListener('change', (event) => {
  state.archive.shown = event.target.checked;
  writePreference('archiveShown', String(state.archive.shown));
  if (state.archive.shown) showWholeArchive();
  else state.timelineView = null;
  flushUpdates(true);
});

$('archive-auto').addEventListener('change', (event) => {
  const enabled = event.target.checked;
  // POST /api/archive/auto. On failure the checkbox is restored and #archive-status explains it.
  archiveRequest('/api/archive/auto', { enabled }).then(() => {
    if (enabled && !state.archive.shown) {
      state.archive.shown = true;
      writePreference('archiveShown', 'true');
      flushUpdates(true);
    }
  }).catch((error) => {
    event.target.checked = !enabled;
    $('archive-status').textContent = `Could not change automatic loading: ${error.message}`;
  });
});

renderArchiveStatus();
loadArchiveSettings();
{
  const panel = $('archive-panel');
  panel.open = readPreference('archivePanelOpen', 'false') === 'true';
  panel.addEventListener('toggle', () => writePreference('archivePanelOpen', String(panel.open)));
}
setInterval(() => {
  if (ARCHIVE_BUSY.has(state.archive.status?.state)) renderArchiveStatus();
}, 1000);

/**
 * Redraws the skyplot, satellite counts, legends, and the satellite table.
 * @returns {void}
 * Side effects: DOM skyplot and satellite readouts. events: none.
 */
function renderSkyplot() {
  const satellites = buildSatelliteList();
  const usageAvailable = satelliteUsageAvailable();
  const plot = $('skyplot');
  const fallback = $('sky-fallback');

  plot.replaceChildren();

  for (const elevation of [0, 30, 60]) {
    const radius = ((90 - elevation) / 90) * SKY.r;
    plot.append(svg('circle', {
      cx: SKY.cx, cy: SKY.cy, r: radius,
      class: elevation === 0 ? 'sky-rim' : 'sky-ring',
    }));
    if (elevation) {
      plot.append(svg('text', { x: SKY.cx + 4, y: SKY.cy - radius + 12, class: 'sky-ring-label' }, `${elevation}°`));
    }
  }

  for (const [azimuth, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const outer = skyPosition(0, azimuth);
    plot.append(svg('line', { x1: SKY.cx, y1: SKY.cy, x2: outer.x, y2: outer.y, class: 'sky-ring' }));
    const position = skyPosition(-7, azimuth);
    plot.append(svg('text', { x: position.x, y: position.y + 4, class: 'sky-compass' }, label));
  }

  const counts = { used: 0, tracked: 0, unknown: 0, visible: 0, missing: 0, unhealthy: 0 };
  const perSystem = {};
  let plotted = 0;

  if (state.showTraces) {
    for (const sat of satellites) {
      if (state.hiddenSystems.has(sat.system) || sat.state === 'visible') continue;
      for (const path of tracePaths(sat)) plot.append(path);
    }
  }

  for (const sat of satellites) {
    perSystem[sat.system] = perSystem[sat.system]
      || { visible: 0, tracked: 0, used: 0, notUsed: 0, missing: 0, unhealthy: 0 };
    counts[sat.state]++;
    if (sat.inView) perSystem[sat.system].visible++;
    if (sat.tracked) perSystem[sat.system].tracked++;
    if (sat.state === 'used') perSystem[sat.system].used++;
    if (sat.state === 'tracked') perSystem[sat.system].notUsed++;
    if (sat.state === 'missing') perSystem[sat.system].missing++;
    if (sat.state === 'unhealthy') perSystem[sat.system].unhealthy++;
    if (state.hiddenSystems.has(sat.system)) continue;

    if (sat.state === 'visible'
      || !Number.isFinite(sat.elevation) || !Number.isFinite(sat.azimuth) || sat.elevation < 0) continue;
    plotted++;
    plot.append(buildSatMarker(sat));
  }

  const bestpos = latestByName.BESTPOS;
  const solutionUsed = bestpos?.crcValid !== false ? bestpos?.data?.satellitesUsed : null;
  $('sv-used').textContent = usageAvailable ? counts.used
    : Number.isInteger(solutionUsed) && solutionUsed >= 0 ? solutionUsed : '\u2014';
  $('sv-tracked').textContent = satellites.filter((sat) => sat.tracked).length;
  $('sv-missing').textContent = satelliteTrackingAvailable() ? counts.missing : '\u2014';
  $('sv-unhealthy').textContent = usageAvailable ? counts.unhealthy : '\u2014';
  $('sv-status-note').textContent = usageAvailable
    ? 'Usage: BESTSATS. Missing: visible assigned TRACKSTAT channels above the tracking cutoff without RANGE observations. In view: SATVIS2 above-horizon prediction, not a tracking count.'
    : 'Per-satellite usage unavailable: waiting for BESTSATS. The used total, when available, comes from BESTPOS; tracked comes from RANGE.'
      + (satelliteTrackingAvailable() ? ' Missing is derived from TRACKSTAT and SATVIS2.' : ' Missing status is unavailable without TRACKSTAT.');
  const best = latestByName.BESTSATS;
  const bestAge = Date.now() - Date.parse(best?.receivedAt);
  if (Number.isFinite(bestAge) && bestAge >= 5000) {
    $('sv-status-note').textContent += ` WARNING: BESTSATS is ${Math.floor(bestAge / 1000)} s old; usage counts are last reported, not live.`;
  }
  const bestEpoch = best?.header?.utc;
  if (usageAvailable && bestEpoch && bestEpoch === bestpos?.header?.utc
    && Number.isInteger(solutionUsed) && counts.used !== solutionUsed) {
    $('sv-status-note').textContent += ` WARNING: same-epoch BESTPOS reports ${solutionUsed} used, but BESTSATS identifies ${counts.used}; counts have not been adjusted.`;
  }
  $('sv-missing').classList.toggle('alert', counts.missing > 0);
  $('sv-unhealthy').classList.toggle('alert', counts.unhealthy > 0);
  $('sky-count').textContent = `(${plotted} plotted)`;
  fallback.hidden = plotted > 0;
  plot.classList.toggle('ready', plotted > 0);

  renderSkyLegend(perSystem);
  renderSignalLegend(signalBreakdown(satellites));
  renderSatelliteTable(satellites);
}

const STATE_TEXT = {
  used: 'Used in solution',
  tracked: 'Tracked, not used',
  unknown: 'Tracked, usage unknown (no BESTSATS status)',
  visible: 'Not tracked',
  missing: 'Missing observation',
  unhealthy: 'Unhealthy / excluded',
};

/** Past positions as polylines, split where the azimuth wraps through north. */
function tracePaths(sat) {
  const samples = (state.tracks[`${sat.system}:${sat.prn}`] || [])
    .filter((sample) => isValidSkyPosition(sample.el, sample.az))
    .sort((a, b) => a.t - b.t);
  if (!samples || samples.length < 2) return [];

  const colour = constellationColor(sat.system);
  const paths = [];
  let points = [];

  /**
   * Emits the current skyplot trace when it has more than one point, then clears it.
   * @returns {void}
   * Side effects: appends a polyline to `paths` and empties `points`. Events: none.
   */
  const flush = () => {
    if (points.length > 1) {
      paths.push(svg('polyline', {
        points: points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        class: 'sat-trace',
        stroke: colour,
      }));
    }
    points = [];
  };

  let previous = null;
  for (const sample of samples) {
    if (previous && Math.abs(sample.az - previous.az) > 180) flush();
    points.push(skyPosition(sample.el, sample.az));
    previous = sample;
  }
  flush();
  return paths;
}

/**
 * SVG group for one satellite marker and its title.
 * @param {object} sat Satellite with system, prn, angles, and state.
 * @returns {SVGGElement}
 * Side effects: none until the caller inserts the group. events: none.
 */
function buildSatMarker(sat) {
  const { x, y } = skyPosition(sat.elevation, sat.azimuth);
  const colour = constellationColor(sat.system);
  const group = svg('g', { class: `sat ${sat.state}` });

  const style = {
    used: { fill: colour, stroke: 'none', label: '#12151a' },
    tracked: { fill: 'rgba(27,32,41,.9)', stroke: colour, label: colour },
    // Dashed ring, same fill and stroke as tracked. The legend uses the same dash.
    unknown: { fill: 'rgba(27,32,41,.9)', stroke: colour, label: colour },
    visible: { fill: 'none', stroke: 'rgba(140,148,164,.7)', label: '#8c94a4' },
    missing: { fill: 'none', stroke: '#ffb02e', label: '#ffb02e' },
    unhealthy: { fill: 'none', stroke: '#ff5f56', label: '#ff5f56' },
  }[sat.state];

  group.append(svg('circle', {
    cx: x, cy: y, r: 11,
    fill: style.fill,
    stroke: style.stroke,
    'stroke-width': 2,
    'stroke-dasharray': sat.state === 'visible' ? '3 2' : sat.state === 'unknown' ? '4 2' : 'none',
  }));
  group.append(svg('text', { x, y: y + 4, class: 'sat-label', fill: style.label }, sat.prn));
  group.append(svg('title', {}, `${sat.system} ${sat.prn}\n${STATE_TEXT[sat.state]}`
    + `\nElevation ${sat.elevation.toFixed(1)}° · Azimuth ${sat.azimuth.toFixed(1)}°`
    + (sat.carrierToNoise ? `\nC/No ${sat.carrierToNoise.toFixed(1)} dB-Hz` : '')
    + (sat.detail ? `\n${sat.detail}` : '')));
  return group;
}

/** Merges geometry, measured satellites, assigned channels and solution usage. */
function buildSatelliteList() {
  const byKey = new Map();
  /** @param {string} system @param {*} prn @returns {string} Map key after PRN normalisation. Side effects: none. Events: none. */
  const key = (system, prn) => `${system}:${normalisePrn(system, prn)}`;

  for (const [system, record] of Object.entries(state.satvis)) {
    if (record.crcValid === false || record.data?.visibilityValid === false) continue;
    for (const sat of (record.data && record.data.satellites) || []) {
      if (normalisePrn(system, sat.prn) === null || !isValidSkyPosition(sat.elevation, sat.azimuth)) continue;
      byKey.set(key(system, sat.prn), {
        system,
        prn: String(normalisePrn(system, sat.prn)),
        elevation: sat.elevation,
        azimuth: sat.azimuth,
        health: sat.health,
        carrierToNoise: null,
        tracked: false,
        inView: true,
        state: 'visible',
        detail: '',
      });
    }
  }

  const range = latestByName.RANGE;
  for (const obs of (range?.crcValid !== false && range?.data?.observations) || []) {
    const system = observationSystem(obs);
    if (!system || system === 'OTHER' || normalisePrn(system, obs.prn) === null) continue;
    const id = key(system, obs.prn);
    const entry = byKey.get(id) || {
      system, prn: String(normalisePrn(system, obs.prn)),
      elevation: null, azimuth: null, health: '0', detail: '',
      inView: false,
    };
    entry.carrierToNoise = Math.max(entry.carrierToNoise || 0, obs.carrierToNoise || 0) || null;
    entry.state = 'unknown';
    entry.tracked = true;
    byKey.set(id, entry);
  }

  const trackstat = latestByName.TRACKSTAT;
  for (const obs of (trackstat?.crcValid !== false && trackstat?.data?.observations) || []) {
    const system = observationSystem(obs);
    if (!system || system === 'OTHER' || normalisePrn(system, obs.prn) === null) continue;
    const status = typeof obs.trackingStatus === 'number'
      ? obs.trackingStatus : parseInt(obs.trackingStatus, 16);
    if (!Number.isFinite(status) || (system === 'GLONASS' && (status & 0x1f) === 0)) continue;
    const id = key(system, obs.prn);
    const entry = byKey.get(id);
    if (!entry) continue;
    if (!entry.tracked) {
      const cutoff = trackstat.data.cutoff;
      if (!entry.inView || !Number.isFinite(cutoff) || entry.elevation < cutoff) continue;
      entry.state = 'missing';
      entry.detail = 'Assigned TRACKSTAT channel without a RANGE observation';
    }
    byKey.set(id, entry);
  }

  const best = latestByName.BESTSATS;
  for (const sat of (best?.crcValid !== false && best?.data?.satellites) || []) {
    if (!sat.system || sat.system === 'OTHER' || normalisePrn(sat.system, sat.prn) === null) continue;
    const id = key(sat.system, sat.prn);
    const entry = byKey.get(id) || {
      system: sat.system, prn: String(normalisePrn(sat.system, sat.prn)),
      elevation: null, azimuth: null, health: '0', carrierToNoise: null,
      tracked: false, inView: false,
    };
    entry.state = bestSatState(sat.status, entry.tracked);
    entry.detail = sat.status;
    byKey.set(id, entry);
  }

  return [...byKey.values()].sort((a, b) => a.system.localeCompare(b.system) || Number(a.prn) - Number(b.prn));
}

/**
 * Skyplot state from a BESTSATS status and whether RANGE is tracking the satellite.
 * @param {string} status BESTSATS status.
 * @param {boolean} tracked Whether RANGE has the satellite.
 * @returns {string}
 * Side effects: none. events: none.
 */
function bestSatState(status, tracked) {
  if (status === 'GOOD') return 'used';
  if (status === 'BADHEALTH') return 'unhealthy';
  if (['NA', 'NOEPHEMERIS', 'LOSSOFLOCK'].includes(status) && !tracked) return 'missing';
  return tracked ? 'tracked' : 'visible';
}

/**
 * True when BESTSATS has a CRC-accepted satellite list.
 * @returns {boolean}
 * Side effects: none. events: none.
 */
function satelliteUsageAvailable() {
  const best = latestByName.BESTSATS;
  return best?.crcValid !== false && Array.isArray(best?.data?.satellites);
}

/**
 * True when TRACKSTAT has a CRC-accepted observation list.
 * @returns {boolean}
 * Side effects: none. events: none.
 */
function satelliteTrackingAvailable() {
  const trackstat = latestByName.TRACKSTAT;
  return trackstat?.crcValid !== false && Array.isArray(trackstat?.data?.observations);
}

/** RANGE reports GLONASS as slot + 37; SATVIS2 and BESTSATS use the slot number. */
function normalisePrn(system, prn) {
  const text = String(prn ?? '').trim();
  const match = text.match(system === 'GLONASS' ? /^(\d+)(?:[+-]\d+)?$/ : /^(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  if (system === 'GLONASS' && value > 37) return value - 37;
  return value;
}

/**
 * Rebuilds the constellation legend and binds each button to toggleSystem.
 * @param {object} perSystem Per-constellation counts.
 * @returns {void}
 * Side effects: DOM legend and click listeners. events: none.
 */
function renderSkyLegend(perSystem) {
  const list = $('sky-legend');
  list.replaceChildren();

  for (const system of Object.keys(perSystem).sort()) {
    const hidden = state.hiddenSystems.has(system);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `legend-toggle${hidden ? ' off' : ''}`;

    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = hidden ? 'transparent' : constellationColor(system);
    dot.style.borderColor = constellationColor(system);

    const label = document.createElement('span');
    label.textContent = hidden
      ? `${system} — hidden`
      : `${system} — ${perSystem[system].tracked} tracked / ${perSystem[system].visible} in view`
        + (satelliteUsageAvailable()
          ? ` · ${perSystem[system].used} used / ${perSystem[system].notUsed} not used`
            + (perSystem[system].unhealthy ? ` / ${perSystem[system].unhealthy} unhealthy` : '')
          : ' · usage unavailable')
        + (satelliteTrackingAvailable() ? ` / ${perSystem[system].missing} missing` : ' / missing unavailable');

    button.append(dot, label);
    button.addEventListener('click', () => toggleSystem(system));
    li.append(button);
    list.append(li);
  }
}

/**
 * Hides or shows one constellation and redraws the skyplot.
 * @param {string} system Constellation name.
 * @returns {void}
 * Side effects: state.hiddenSystems, localStorage via writePreference, and the skyplot DOM. events: none.
 */
function toggleSystem(system) {
  if (state.hiddenSystems.has(system)) state.hiddenSystems.delete(system);
  else state.hiddenSystems.add(system);
  writePreference('hiddenSystems', JSON.stringify([...state.hiddenSystems]));
  renderSkyplot();
}

$('sky-all').addEventListener('click', () => {
  state.hiddenSystems.clear();
  writePreference('hiddenSystems', '[]');
  renderSkyplot();
});

const SIGNAL_BANDS = ['L1', 'L2', 'L5', 'Other'];

/**
 * Counts used satellites per band from BESTSATS signal masks.
 * @param {Array} satellites Satellites from buildSatelliteList.
 * @returns {object}
 * Side effects: none. events: none.
 */
function signalBreakdown(satellites) {
  const used = new Set(satellites
    .filter((sat) => sat.state === 'used' && !state.hiddenSystems.has(sat.system))
    .map((sat) => `${sat.system}:${normalisePrn(sat.system, sat.prn)}`));
  const counts = Object.fromEntries(SIGNAL_BANDS.map((band) => [band, new Set()]));
  const best = latestByName.BESTSATS;
  const maskBands = {
    GPS: ['L1', 'L2', 'L5'],
    GLONASS: ['L1', 'L2', 'Other'],
    SBAS: ['L1', 'L5'],
    GALILEO: ['L1', 'L5', 'L5', 'L5', 'Other'],
    BEIDOU: ['L1', 'L5', 'Other', 'L1', 'L5', 'L5'],
    QZSS: ['L1', 'L2', 'L5', 'Other'],
    NAVIC: [null, null, 'L5'],
  };
  for (const sat of (best?.crcValid !== false && best?.data?.satellites) || []) {
    const key = `${sat.system}:${normalisePrn(sat.system, sat.prn)}`;
    if (!used.has(key)) continue;
    if (!/^[0-9a-fA-F]{1,8}$/.test(sat.signalMask || '')) continue;
    const mask = parseInt(sat.signalMask, 16);
    const bands = maskBands[sat.system] || [];
    for (let bit = 0; bit < 32; bit++) {
      if ((mask >>> bit) & 1) counts[bands[bit] || 'Other'].add(key);
    }
  }

  return Object.fromEntries(SIGNAL_BANDS.map((band) => [band, counts[band].size]));
}

/**
 * Fills the used-signal band legend.
 * @param {object} counts Band name to used-satellite count.
 * @returns {void}
 * Side effects: DOM #signal-legend. events: none.
 */
function renderSignalLegend(counts) {
  const list = $('signal-legend');
  list.replaceChildren();
  if (!Object.values(counts).some(Boolean)) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = satelliteUsageAvailable() ? 'No used signals in the BESTSATS masks.' : 'Used signals unavailable without BESTSATS.';
    list.append(li);
    return;
  }

  for (const band of SIGNAL_BANDS) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = `signal-band band-${band.toLowerCase()}`;
    label.textContent = band;
    const value = document.createElement('span');
    value.textContent = `${counts[band]} used`;
    li.append(label, value);
    list.append(li);
  }
}

/**
 * Maps a tracking-status signal code to L1, L2, L5, or Other.
 * @param {string} system Constellation name.
 * @param {number|string} trackingStatus Numeric or hex tracking status.
 * @returns {string}
 * Side effects: none. events: none.
 */
function signalBand(system, trackingStatus) {
  const value = typeof trackingStatus === 'number' ? trackingStatus : parseInt(trackingStatus, 16);
  if (!Number.isFinite(value)) return 'Other';
  const code = (value >>> 21) & 0x1f;
  const bandsBySystem = {
    GPS: { 0: 'L1', 1: 'L1', 5: 'L2', 9: 'L2', 14: 'L5', 16: 'L1', 17: 'L2' },
    GLONASS: { 0: 'L1', 1: 'L2', 5: 'L2' },
    SBAS: { 0: 'L1', 6: 'L5', 14: 'L5' },
    GALILEO: { 2: 'L1', 12: 'L5', 17: 'L5', 20: 'L5' },
    BEIDOU: { 0: 'L1', 1: 'L5', 4: 'L1', 5: 'L5', 7: 'L1', 9: 'L5', 11: 'L5' },
    QZSS: { 0: 'L1', 1: 'L1', 5: 'L2', 9: 'L2', 14: 'L5', 16: 'L1', 17: 'L2', 24: 'L1' },
    NAVIC: { 0: 'L5' },
  };
  return (bandsBySystem[system] && bandsBySystem[system][code]) || 'Other';
}

/**
 * Fills the satellite table, hiding constellations in hiddenSystems.
 * @param {Array} satellites Satellite rows.
 * @returns {void}
 * Side effects: DOM #sv-table. events: none.
 */
function renderSatelliteTable(satellites) {
  const body = document.querySelector('#sv-table tbody');
  body.replaceChildren();
  const shown = satellites.filter((s) => !state.hiddenSystems.has(s.system));
  if (!shown.length) {
    emptyRow(body, 7, 'No satellite data yet.');
    return;
  }

  const order = { used: 0, tracked: 1, unknown: 2, missing: 3, unhealthy: 4, visible: 5 };
  shown.sort((a, b) => order[a.state] - order[b.state] || (b.elevation || 0) - (a.elevation || 0));

  for (const sat of shown) {
    const row = body.insertRow();
    cell(row, sat.system);
    cell(row, sat.prn);
    cell(row, STATE_TEXT[sat.state]).className = `state-${sat.state}`;
    cell(row, sat.elevation === null ? '—' : `${sat.elevation.toFixed(1)}°`);
    cell(row, sat.azimuth === null ? '—' : `${sat.azimuth.toFixed(1)}°`);
    cell(row, sat.carrierToNoise ? `${sat.carrierToNoise.toFixed(1)} dB-Hz` : '—');
    cell(row, sat.detail || '—', 'raw');
  }
}

/**
 * Stores one SATVIS2 report by system and redraws the skyplot.
 * @param {object} record SATVIS2 report.
 * @returns {void}
 * Side effects: state.satvis and the skyplot DOM. Returns when system is missing. events: none.
 */
function renderSatVis(record) {
  if (!record.data || !record.data.system) return;
  state.satvis[record.data.system] = record;
  renderSkyplot();
}

/**
 * Redraws the skyplot and the first RANGE observation rows.
 * @param {object} record RANGE report.
 * @returns {void}
 * Side effects: DOM range table and skyplot. Returns when data is missing. events: none.
 */
function renderRange(record) {
  const d = record.data;
  if (!d) return;
  renderSkyplot();
  $('range-count').textContent = `(${d.observationCount} observations)`;
  const body = document.querySelector('#range tbody');
  body.replaceChildren();
  if (!d.observations.length) {
    emptyRow(body, 6, 'No observations in the last RANGE log.');
    return;
  }
  for (const obs of d.observations.slice(0, 40)) {
    const row = body.insertRow();
    cell(row, obs.prn);
    cell(row, obs.gloFrequency);
    cell(row, fmt(obs.pseudorange, 3, ' m'));
    cell(row, fmt(obs.carrierToNoise, 1, ' dB-Hz'));
    cell(row, fmt(obs.lockTime, 0, ' s'));
    cell(row, obs.trackingStatus, 'raw');
  }
}

/**
 * Fills receiver error, status word, and active flag list.
 * @param {object} record RXSTATUS report.
 * @returns {void}
 * Side effects: DOM health fields. Returns when data is missing. events: none.
 */
function renderRxStatus(record) {
  const d = record.data;
  if (!d) return;
  $('rx-error').textContent = `0x${d.errorWord}`;
  $('rx-error').classList.toggle('alert', d.hasError);
  $('rx-status').textContent = `0x${d.receiverStatusWord}`;

  const list = $('rx-flags');
  list.replaceChildren();
  if (!d.activeFlags.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No status flags set.';
    list.append(li);
    return;
  }
  for (const flag of d.activeFlags) {
    const li = document.createElement('li');
    li.className = 'flag';
    li.textContent = flag;
    list.append(li);
  }
}

/**
 * Fills the version table and the one-line version summary.
 * @param {object} record VERSION report.
 * @returns {void}
 * Side effects: DOM version table and summary. Returns when components are missing. events: none.
 */
function renderVersion(record) {
  const d = record.data;
  if (!d || !d.components) return;
  const body = document.querySelector('#version tbody');
  body.replaceChildren();
  for (const c of d.components) {
    const row = body.insertRow();
    cell(row, c.type);
    cell(row, c.model);
    cell(row, c.serialNumber);
    cell(row, c.hardwareVersion);
    cell(row, c.softwareVersion);
    cell(row, c.bootVersion);
    cell(row, c.compileDate);
  }
  renderVersionSummary(record);
}

/**
 * Sets the overview version line from the first component.
 * @param {object} record VERSION report.
 * @returns {void}
 * Side effects: DOM #version-line when a component exists. events: none.
 */
function renderVersionSummary(record) {
  const main = record.data?.components?.[0];
  if (main) $('version-line').textContent = `${main.model} · SW ${main.softwareVersion} · S/N ${main.serialNumber}`;
}

/**
 * Sets the interference time and message count and redraws the band cards.
 * @param {object} record ITDETECTSTATUS report.
 * @returns {void}
 * Side effects: DOM and renderBands. Returns when data is missing. events: none.
 */
function renderItDetect(record) {
  const d = record.data;
  if (!d) return;
  $('it-time').textContent = formatTime(record);
  $('it-total').textContent = state.counts.ITDETECTSTATUS || 0;
  renderBands();
}

// --- interference bands -----------------------------------------------------

const BANDS = [
  { id: 'L1', minHz: 1559e6, maxHz: 1610e6, title: 'L1 / E1 / B1 / G1', range: '1559 – 1610 MHz', note: 'GPS/QZSS L1, Galileo E1, BeiDou B1, GLONASS G1' },
  { id: 'L2', minHz: 1215e6, maxHz: 1260e6, title: 'L2 / G2', range: '1215 – 1260 MHz', note: 'GPS/QZSS L2, GLONASS G2' },
  { id: 'L5', minHz: 1164e6, maxHz: 1215e6, title: 'L5 / E5 / B2', range: '1164 – 1215 MHz', note: 'GPS L5, GAL E5a/E5b, BDS B2a/B2b/B2I, NavIC L5' },
  { id: 'L6', minHz: 1260e6, maxHz: 1300e6, title: 'L6 / E6 / B3', range: '1260 – 1300 MHz', note: 'GAL E6, QZSS L6, BDS B3' },
  { id: 'SBAS', title: 'SBAS', range: 'L1 / L5 overlay', note: 'WAAS, EGNOS, MSAS, GAGAN' },
  { id: 'SBAND', minHz: 2483e6, maxHz: 2500e6, title: 'S-Band', range: '2483 – 2500 MHz', note: 'NavIC S' },
  { id: 'LBAND', minHz: 1525e6, maxHz: 1559e6, title: 'L-Band', range: '1525 – 1560 MHz', note: 'TerraStar corrections' },
  { id: 'OTHER', title: 'Unclassified', range: '—', note: 'Signal type not recognised' },
];

/** Maps an ITDETECTSTATUS detection by measured frequency before its receiver RF-path label. */
function classifyBand(signalType, detections) {
  const freq = detections.map((d) => d.centerFrequencyHz ?? d.freq).find((hz) => Number.isFinite(hz) && hz > 0);
  if (freq !== undefined) {
    const band = BANDS.find((band) => freq >= band.minHz && freq < band.maxHz)
      || BANDS.find((band) => freq === band.maxHz);
    return band?.id || 'OTHER';
  }
  const s = (signalType || '').toUpperCase();

  if (s.includes('SBAS') || s.includes('WAAS') || s.includes('EGNOS')) return 'SBAS';
  if (s.includes('LBAND') || s.includes('TERRASTAR')) return 'LBAND';
  if (/NAVICS|SBAND|\bS\b/.test(s)) return 'SBAND';
  if (/L6|E6|B3/.test(s)) return 'L6';
  if (/L5|E5|B2/.test(s)) return 'L5';
  if (/L2|G2/.test(s)) return 'L2';
  if (/L1|E1|B1|G1/.test(s)) return 'L1';

  return 'OTHER';
}

function detectionBands(signalType, detection) {
  const freq = detection.centerFrequencyHz ?? detection.freq;
  const bandwidth = detection.bandwidthHz ?? detection.bandwidth;
  if (Number.isFinite(freq) && freq > 0 && Number.isFinite(bandwidth) && bandwidth > 0) {
    const bands = BANDS.filter((band) => freq + bandwidth / 2 > band.minHz && freq - bandwidth / 2 < band.maxHz);
    return bands.length ? bands.map((band) => band.id) : ['OTHER'];
  }
  return [classifyBand(signalType, [detection])];
}

function interferenceSampleForBand(sample, band) {
  if (!Array.isArray(sample.detections) || !sample.detections.length) {
    return detectionBands(sample.signal, { freq: sample.freq }).includes(band) ? sample : null;
  }
  const detections = sample.detections.filter((detection) => detectionBands(sample.signal, detection).includes(band));
  if (!detections.length) return null;
  const powers = detections.map((detection) => detection.power).filter(Number.isFinite);
  return {
    ...sample,
    count: sample.count > 0 ? detections.length : 0,
    maxPower: powers.length ? Math.max(...powers) : null,
    freq: detections[0].freq,
    detections,
  };
}

/**
 * Rebuilds band cards from the latest ITDETECTSTATUS report and window stats.
 * @returns {void}
 * Side effects: DOM #bands and the verdict banner. events: none.
 */
function renderBands() {
  const now = Date.now();
  const groups = {};
  const stats = bandStats(now);
  const record = latestByName.ITDETECTSTATUS;
  const detections = (record && record.data && record.data.detections) || [];

  for (const detection of detections) {
    for (const band of detectionBands(detection.signalType, detection)) {
      const group = groups[band] || (groups[band] = { signals: new Map(), detections: [] });
      group.signals.set(detection.signalType, (group.signals.get(detection.signalType) || 0) + 1);
      group.detections.push(detection);
    }
  }

  const container = $('bands');
  container.replaceChildren();
  for (const band of BANDS) {
    const group = groups[band.id];
    const bandDetections = group ? group.detections : [];
    const status = !interferenceIsLive(record, now) ? 'unmonitored' : bandDetections.length ? 'jammed' : 'clear';
    const card = buildBandCard(band, group, bandDetections, status, stats[band.id]);
    card.dataset.band = band.id;
    container.append(card);
  }

  renderVerdict();
}

/** Detection rate, peak power and time since the last hit over the selected window. */
function bandStats(now) {
  const cutoff = now - state.windowMinutes * 60000;
  const stats = {};

  for (const sample of state.interferenceHistory) {
    if (sample.t < cutoff) continue;
    for (const { id: band } of BANDS) {
      const bandSample = sample.signal === 'ALL' ? sample : interferenceSampleForBand(sample, band);
      if (!bandSample) continue;
      const entry = stats[band] || (stats[band] = { samples: 0, hits: 0, peak: null, lastHit: null });
      entry.samples++;
      if (sample.count > 0) {
        entry.hits++;
        entry.lastHit = Math.max(entry.lastHit || 0, sample.t);
        if (Number.isFinite(bandSample.maxPower)) {
          entry.peak = entry.peak === null ? bandSample.maxPower : Math.max(entry.peak, bandSample.maxPower);
        }
      }
    }
  }
  return stats;
}

/**
 * Builds one interference band card, including stats and detection rows when present.
 * @param {object} band Band descriptor.
 * @param {object|undefined} group Signals and detections for the band.
 * @param {Array} detections Detections in the band.
 * @param {string} status jammed, clear, or unmonitored.
 * @param {object|undefined} stats Window stats for the band.
 * @returns {HTMLElement}
 * Side effects: none until the caller inserts the card. events: none.
 */
function buildBandCard(band, group, detections, status, stats) {
  const card = document.createElement('article');
  card.className = `band ${status}`;

  const head = document.createElement('header');
  const title = document.createElement('div');
  title.className = 'band-title';
  title.textContent = band.title;
  const pill = document.createElement('span');
  pill.className = `pill ${status}`;
  pill.textContent = status === 'jammed'
    ? `${detections.length} detection${detections.length === 1 ? '' : 's'}`
    : status === 'clear' ? 'Clear' : 'No data';
  head.append(title, pill);

  const range = document.createElement('div');
  range.className = 'band-range';
  range.textContent = band.range;

  const signals = document.createElement('div');
  signals.className = 'chips';
  if (group) {
    for (const [signalType, count] of group.signals) {
      const chip = document.createElement('span');
      chip.className = `chip${count ? ' hit' : ''}`;
      chip.textContent = `${signalType} x${count}`;
      signals.append(chip);
    }
  } else {
    const chip = document.createElement('span');
    chip.className = 'chip muted-chip';
    chip.textContent = band.note;
    signals.append(chip);
  }

  card.append(head, range, signals);

  if (stats && stats.samples) {
    const summary = document.createElement('div');
    summary.className = 'band-stats';
    const rate = Math.round((stats.hits / stats.samples) * 100);
    summary.textContent = `${rate}% of ${stats.samples} reports in the last ${formatWindow(state.windowMinutes)}`
      + (stats.peak !== null ? ` \u00b7 peak ${stats.peak.toFixed(1)} dBm` : '')
      + (stats.lastHit ? ` \u00b7 last hit ${timeAgo(stats.lastHit)}` : '');
    if (stats.hits) summary.classList.add('has-hits');
    card.append(summary);
  }

  if (detections.length) {
    const strongest = detections.reduce((a, b) => ((b.powerDbm ?? -999) > (a.powerDbm ?? -999) ? b : a));
    card.append(buildPowerMeter(strongest.powerDbm));
    const list = document.createElement('ul');
    list.className = 'band-detections';
    for (const det of detections) {
      const li = document.createElement('li');
      const type = document.createElement('span');
      type.className = 'det-type';
      type.textContent = detectionTypeLabel(det.type);
      const freq = document.createElement('span');
      freq.textContent = det.centerFrequencyHz === null ? det.signalType : formatFrequency(det.centerFrequencyHz);
      const power = document.createElement('span');
      power.className = 'det-power';
      power.textContent = det.powerDbm === null ? '—' : `${det.powerDbm} dBm`;
      const description = document.createElement('span');
      description.className = 'det-description';
      description.textContent = describeDetection(det);
      li.append(type, freq, power, description);
      list.append(li);
    }
    card.append(list);
  }

  return card;
}

const DETECTION_TYPE_TEXT = {
  SPECTRUMANALYSIS: 'Spectrum analysis',
  STATISTICANALYSIS: 'Statistical analysis',
};

/**
 * Display name for a detector type, or the raw type, or Unknown detector.
 * @param {string} type Detector type.
 * @returns {string}
 * Side effects: none. events: none.
 */
function detectionTypeLabel(type) {
  return DETECTION_TYPE_TEXT[type] || type || 'Unknown detector';
}

/**
 * Sentence describing a spectrum or statistical detection, including affected-signal masks.
 * @param {object} detection One ITDETECTSTATUS detection.
 * @returns {string}
 * Side effects: none. events: none.
 */
function describeDetection(detection) {
  const masks = (detection.affectedSignals || []).filter((mask) => mask && mask !== '00000000');
  const maskText = masks.length ? ` Affected-signal masks: ${masks.join(', ')}.` : '';

  if (detection.type === 'SPECTRUMANALYSIS') {
    const delta = Number.isFinite(detection.powerDbm) && Number.isFinite(detection.noiseFloorDbm)
      ? detection.powerDbm - detection.noiseFloorDbm
      : null;
    return `Energy peak centred at ${formatFrequency(detection.centerFrequencyHz)}`
      + ` with ${formatFrequency(detection.bandwidthHz)} bandwidth.`
      + (Number.isFinite(detection.powerDbm) ? ` Peak power ${detection.powerDbm.toFixed(3)} dBm.` : '')
      + (Number.isFinite(detection.noiseFloorDbm) ? ` Noise floor ${detection.noiseFloorDbm.toFixed(3)} dBm.` : '')
      + (delta !== null ? ` Peak is ${delta.toFixed(1)} dB above the noise floor.` : '')
      + maskText;
  }

  if (detection.type === 'STATISTICANALYSIS') {
    const metrics = (detection.metrics || []).filter(Number.isFinite);
    return 'Statistical detector found a non-GNSS-like signal distribution.'
      + (metrics.length ? ` Receiver metrics: ${metrics.map((value) => value.toFixed(3)).join(', ')}.` : '')
      + maskText;
  }

  return `Receiver-reported ${detectionTypeLabel(detection.type).toLowerCase()} event.` + maskText;
}

/** Signal strength bar spanning a typical detector range of -130 to -70 dBm. */
function buildPowerMeter(powerDbm) {
  const wrap = document.createElement('div');
  wrap.className = 'meter';
  const fill = document.createElement('div');
  const ratio = powerDbm === null || powerDbm === undefined
    ? 0
    : Math.min(1, Math.max(0, (powerDbm + 130) / 60));
  fill.className = `meter-fill ${ratio > 0.66 ? 'high' : ratio > 0.33 ? 'medium' : 'low'}`;
  fill.style.width = `${Math.round(ratio * 100)}%`;
  const label = document.createElement('span');
  label.className = 'meter-label';
  label.textContent = powerDbm === null || powerDbm === undefined ? 'strongest: —' : `strongest: ${powerDbm} dBm`;
  wrap.append(fill, label);
  return wrap;
}

/**
 * True when the server is online, the receiver is connected, and the interference report is fresh.
 * @param {object} record Latest ITDETECTSTATUS report.
 * @param {number} [now] Clock in milliseconds.
 * @returns {boolean}
 * Side effects: none. events: none.
 */
function interferenceIsLive(record, now = Date.now()) {
  return !connection.offline && connection.status?.connected === true
    && hasFreshInterferenceReport(record, now);
}

/**
 * True when the report is CRC-valid, has data, and receivedAt is under the stale limit.
 * @param {object} record ITDETECTSTATUS report.
 * @param {number} [now] Clock in milliseconds.
 * @returns {boolean}
 * Side effects: none. events: none.
 */
function hasFreshInterferenceReport(record, now = Date.now()) {
  const receivedAt = Date.parse(record?.receivedAt);
  return record?.crcValid === true && Boolean(record?.data)
    && Number.isFinite(receivedAt) && now - receivedAt < INTERFERENCE_STALE_MS;
}

/**
 * Updates the interference banner, freshness line, clock, last detection, and device summary.
 * @returns {void}
 * Side effects: DOM banner and related interference readouts. events: none.
 */
function renderVerdict() {
  const now = Date.now();
  const record = latestByName.ITDETECTSTATUS;
  const receivedAt = Date.parse(record?.receivedAt);
  const age = Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : null;
  const detections = record?.data?.detections || [];
  const jammedBands = BANDS.map((band) => band.id)
    .filter((band) => detections.some((detection) => detectionBands(detection.signalType, detection).includes(band)));
  const totalDetections = detections.length;
  const banner = $('it-banner');
  const verdict = $('it-verdict');
  const detail = $('it-detail');

  const messageCount = state.counts.ITDETECTSTATUS || 0;
  const reportIsFresh = hasFreshInterferenceReport(record, now);
  $('it-freshness').textContent = reportIsFresh
    ? `Receiving Data \u00b7 ${messageCount} status messages`
    : `${connection.offline ? 'Live server connection lost' : 'Device connection lost'}`
      + ` \u00b7 Last message ${age === null ? 'never' : `${Math.floor(age / 1000)} s ago`}`
      + ` \u00b7 ${messageCount} status messages`;
  renderClock(now);
  renderLastDetection();
  renderDeviceSummary();
  $('it-bands-hit').textContent = jammedBands.length ? jammedBands.join(', ') : 'None';
  $('it-bands-hit').classList.toggle('alert', jammedBands.length > 0);
  $('it-count').textContent = totalDetections;
  $('it-count').classList.toggle('alert', totalDetections > 0);

  const lastReportAt = Number.isFinite(receivedAt) ? receivedAt : liveStatusStartedAt;
  if (!reportIsFresh && now - lastReportAt >= INTERFERENCE_STALE_MS) {
    banner.className = 'banner device-error';
    verdict.textContent = connection.offline ? 'Live server connection lost'
      : connection.status?.connected === false ? 'Device disconnected' : 'Device status unavailable';
    detail.textContent = connection.offline ? 'Cannot receive live data from the server. Reconnecting...'
      : connection.status?.connected === false ? 'Receiver connection lost. Interference status is unknown.'
        : 'No fresh valid ITDETECTSTATUS report from the receiver. Interference status is unknown.';
    return;
  }

  if (!record) {
    banner.className = 'banner idle';
    verdict.textContent = 'Waiting for ITDETECTSTATUS';
    detail.textContent = 'No interference data received yet.';
    return;
  }
  if (jammedBands.length) {
    banner.className = 'banner alarm';
    verdict.textContent = `Jamming detected on ${jammedBands.join(', ')}`;
    detail.textContent = `${totalDetections} active detection${totalDetections === 1 ? '' : 's'} across ${jammedBands.length} band${jammedBands.length === 1 ? '' : 's'}.`;
    return;
  }
  banner.className = 'banner clear';
  verdict.textContent = 'No interference detected';
  detail.textContent = 'Latest receiver status reports no active detections.';
}

/**
 * Keeps the strongest detection when this CRC-valid ITDETECTSTATUS report is the newest.
 * @param {object} record ITDETECTSTATUS report.
 * @returns {void}
 * Side effects: state.lastDetection. Ignores other names, failed CRC, empty detections, and older times. events: none.
 */
function rememberLastDetection(record) {
  if (record?.name !== 'ITDETECTSTATUS' || record.crcValid !== true) return;
  const detections = record.data?.detections;
  if (!Array.isArray(detections) || detections.length === 0) return;
  const at = Date.parse(record.receivedAt);
  if (!Number.isFinite(at) || (state.lastDetection && at < state.lastDetection.at)) return;
  const detection = detections.reduce((strongest, item) => {
    if (!strongest) return item;
    const power = Number.isFinite(item.powerDbm) ? item.powerDbm : -Infinity;
    const strongestPower = Number.isFinite(strongest.powerDbm) ? strongest.powerDbm : -Infinity;
    return power > strongestPower ? item : strongest;
  }, null);
  state.lastDetection = { at, detection };
}

/** Seeds the last detection from restored history samples when it is newer than the live one. */
function rememberHistoryDetection(samples) {
  let latest = null;
  for (const sample of samples) {
    if (sample?.count > 0 && Number.isFinite(sample.t) && (!latest || sample.t >= latest.t)) latest = sample;
  }
  if (!latest || (state.lastDetection && latest.t <= state.lastDetection.at)) return;
  /** @param {object|undefined} item @returns {number} Measured power, or -Infinity when it is not finite. Side effects: none. Events: none. */
  const power = (item) => (Number.isFinite(item?.power) ? item.power : -Infinity);
  const strongest = (latest.detections || []).reduce((best, item) => (
    !best || power(item) > power(best) ? item : best), null);
  state.lastDetection = {
    at: latest.t,
    detection: {
      signalType: latest.signal,
      type: strongest?.type || '',
      powerDbm: Number.isFinite(strongest?.power) ? strongest.power : latest.maxPower,
      bandwidthHz: strongest?.bandwidth ?? null,
      centerFrequencyHz: strongest?.freq ?? latest.freq ?? null,
    },
  };
}

/**
 * One-line text for the remembered detection, or None yet.
 * @param {object|null} last Last-detection record.
 * @returns {string}
 * Side effects: none. events: none.
 */
function lastDetectionSummary(last) {
  if (!last) return 'None yet';
  const detection = last.detection;
  const signal = detection.signalType || 'Unknown signal';
  const metrics = [
    Number.isFinite(detection.powerDbm) ? `${detection.powerDbm.toFixed(1)} dBm` : null,
    Number.isFinite(detection.bandwidthHz) ? `${formatFrequency(detection.bandwidthHz)} BW` : null,
    Number.isFinite(detection.centerFrequencyHz)
      ? `Centre frequency ${formatFrequency(detection.centerFrequencyHz)}` : null,
  ];
  const details = [
    detection.type ? `${signal} (${detectionTypeLabel(detection.type)})` : signal,
    ...(metrics.some(Boolean)
      ? metrics.map((text, index) => text || ['power unavailable', 'bandwidth unavailable', 'centre frequency unavailable'][index])
      : ['power and frequency not reported by this detector']),
  ];
  return details.join(' \u00b7 ');
}

/**
 * Writes the last-detection summary and its time into the interference banner.
 * @returns {void}
 * Side effects: DOM #it-last-detection and #it-last-detection-detail. events: none.
 */
function renderLastDetection() {
  const last = state.lastDetection;
  $('it-last-detection').textContent = lastDetectionSummary(last);
  $('it-last-detection-detail').textContent = last
    ? `${formatTimestamp(last.at)} \u00b7 ${timeAgo(last.at)}` : 'No interference reported since startup';
}

/**
 * Writes the clock time and date in the selected time zone.
 * @param {number} [now] Clock in milliseconds. Defaults to Date.now().
 * @returns {void}
 * Side effects: DOM #it-clock and #it-clock-date. events: none.
 */
function renderClock(now = Date.now()) {
  const date = new Date(now);
  $('it-clock').textContent = dateFormatter({
    timeZone: state.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
  $('it-clock-date').textContent = dateFormatter({
    timeZone: state.timeZone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    timeZoneName: 'shortOffset',
  }).format(date);
}

const SATELLITE_SYSTEMS = ['GPS', 'GLONASS', 'GALILEO', 'BEIDOU', 'QZSS', 'NAVIC'];

// RANGE channel tracking status bits 21-25, listed in display order (NovAtel OEM7).
const SIGNAL_NAMES = {
  GPS: [[0, 'L1C/A'], [16, 'L1C'], [5, 'L2P'], [9, 'L2P(Y)'], [17, 'L2C'], [14, 'L5']],
  GLONASS: [[0, 'L1C/A'], [1, 'L2C/A'], [5, 'L2P'], [6, 'L3']],
  SBAS: [[0, 'L1C/A'], [6, 'L5']],
  // OEM7 bits 21-25 name Galileo 2 E1, 6 E6B, 7 E6C, 12 E5a, 17 E5b, 20 E5 AltBOC.
  // Code 0 is not in that table. The simulator leaves bits 21-25 clear, so those
  // observations stay "Signal 0" instead of a guessed name.
  GALILEO: [[2, 'E1'], [12, 'E5a'], [17, 'E5b'], [20, 'E5 AltBOC'], [6, 'E6B'], [7, 'E6C']],
  BEIDOU: [[0, 'B1I'], [4, 'B1I'], [7, 'B1C'], [1, 'B2I'], [5, 'B2I'], [9, 'B2a'], [11, 'B2b'], [2, 'B3I'], [6, 'B3I']],
  QZSS: [[0, 'L1C/A'], [16, 'L1C'], [24, 'L1C/B'], [17, 'L2C'], [14, 'L5'], [27, 'L6P'], [28, 'L6D']],
  NAVIC: [[0, 'L5']],
};

/** Older servers label NavIC (tracking system 6) as RESERVED. */
function observationSystem(observation) {
  return observation?.system === 'RESERVED' ? 'NAVIC' : observation?.system;
}

/**
 * Tracking-status signal code in bits 21-25, or null when the status is not numeric.
 * @param {number|string} trackingStatus Numeric or hex tracking status.
 * @returns {number|null}
 * Side effects: none. events: none.
 */
function signalCode(trackingStatus) {
  const value = typeof trackingStatus === 'number' ? trackingStatus : parseInt(trackingStatus, 16);
  return Number.isFinite(value) ? (value >>> 21) & 0x1f : null;
}

/**
 * Signal name for a system and tracking status, or Signal plus the code.
 * @param {string} system Constellation name.
 * @param {number|string} trackingStatus Tracking status.
 * @returns {string}
 * Side effects: none. events: none.
 */
function signalName(system, trackingStatus) {
  const code = signalCode(trackingStatus);
  if (code === null) return 'Unknown';
  const entry = (SIGNAL_NAMES[system] || []).find(([value]) => value === code);
  return entry ? entry[1] : `Signal ${code}`;
}

/**
 * Display order of a signal name within a system, or Infinity when unknown.
 * @param {string} system Constellation name.
 * @param {string} name Signal name.
 * @returns {number}
 * Side effects: none. events: none.
 */
function signalOrder(system, name) {
  const index = (SIGNAL_NAMES[system] || []).findIndex(([, value]) => value === name);
  return index < 0 ? Infinity : index;
}

/** Unique tracked satellites and per-signal satellite counts for each constellation from RANGE. */
function trackedSatelliteSummary(range = latestByName.RANGE) {
  const systems = new Map();
  for (const observation of (range?.crcValid !== false && range?.data?.observations) || []) {
    const system = observationSystem(observation);
    if (!system || system === 'OTHER') continue;
    if (normalisePrn(system, observation.prn) === null) continue;
    const prn = String(normalisePrn(system, observation.prn));
    if (!systems.has(system)) systems.set(system, { prns: new Set(), signals: new Map() });
    const entry = systems.get(system);
    entry.prns.add(prn);
    const name = signalName(system, observation.trackingStatus);
    if (!entry.signals.has(name)) entry.signals.set(name, new Set());
    entry.signals.get(name).add(prn);
  }
  return systems;
}

/**
 * Counts satellites marked in view, by constellation.
 * @returns {object}
 * Side effects: none. events: none.
 */
function satellitesInViewBySystem() {
  const counts = {};
  for (const satellite of buildSatelliteList()) {
    if (!satellite.inView) continue;
    counts[satellite.system] = (counts[satellite.system] || 0) + 1;
  }
  return counts;
}

/**
 * Adds the numbers in a count map.
 * @param {object} [counts] Map of counts.
 * @returns {number}
 * Side effects: none. events: none.
 */
function sumCounts(counts) {
  return Object.values(counts || {}).reduce((sum, count) => sum + count, 0);
}

/**
 * Fills the per-constellation tracked and in-view table and the satellite-view plot.
 * @returns {void}
 * Side effects: DOM satellite summary and the view plot. events: none.
 */
function renderDeviceSummary() {
  const tracked = trackedSatelliteSummary();
  const inView = satellitesInViewBySystem();
  const systems = [...new Set([...SATELLITE_SYSTEMS, ...tracked.keys(), ...Object.keys(inView)])]
    .filter((system) => SATELLITE_SYSTEMS.includes(system) || tracked.has(system) || inView[system]);
  const body = $('satellite-signal-rows');
  body.replaceChildren();
  let trackedTotal = 0;
  let signalTotal = 0;
  for (const system of systems) {
    const entry = tracked.get(system);
    const trackedCount = entry ? entry.prns.size : 0;
    const inViewCount = inView[system] || 0;
    trackedTotal += trackedCount;
    const row = body.insertRow();
    row.className = trackedCount ? '' : 'inactive';
    const name = row.insertCell();
    const key = document.createElement('i');
    key.className = 'satellite-key';
    key.style.background = constellationColor(system);
    name.append(key, document.createTextNode(constellationLabel(system)));
    cell(row, `${trackedCount} / ${inViewCount}`, 'satellite-counts');
    const signals = entry ? [...entry.signals]
      .sort(([a], [b]) => signalOrder(system, a) - signalOrder(system, b) || a.localeCompare(b)) : [];
    signals.forEach(([, prns]) => { signalTotal += prns.size; });
    cell(row, signals.length
      ? signals.map(([signal, prns]) => `${signal} ${prns.size}`).join(' \u00b7 ')
      : inViewCount ? 'Not tracked' : 'Not reported by receiver', 'satellite-signals');
  }
  const inViewTotal = sumCounts(inView);
  $('satellite-total-counts').textContent = `${trackedTotal} / ${inViewTotal}`;
  $('satellite-view-total').textContent = trackedTotal || inViewTotal
    ? `${trackedTotal} tracked \u00b7 ${inViewTotal} in view \u00b7 ${signalTotal} signals`
    : 'No satellite data';
  renderSatelliteViewPlot();
}

/**
 * Appends a tracked and in-view sample for a CRC-valid RANGE, SATVIS2, BESTSATS, or TRACKSTAT report.
 * @param {object} record Satellite report.
 * @returns {void}
 * Side effects: state.satelliteViewHistory. Skips a bad CRC, an unparsed time, an older time, and an unchanged sample inside the heartbeat. events: none.
 */
function recordSatelliteView(record) {
  if (!['RANGE', 'SATVIS2', 'BESTSATS', 'TRACKSTAT'].includes(record?.name) || record.crcValid !== true) return;
  const t = Date.parse(record.receivedAt);
  if (!Number.isFinite(t)) return;
  const tracked = {};
  for (const [system, entry] of trackedSatelliteSummary()) tracked[system] = entry.prns.size;
  const inView = satellitesInViewBySystem();
  const history = state.satelliteViewHistory;
  const last = history[history.length - 1];
  const unchanged = last && JSON.stringify([last.tracked, last.inView]) === JSON.stringify([tracked, inView]);
  if (last && (t <= last.t || (unchanged && t - last.t < SOLUTION_HEARTBEAT_MS))) return;
  history.push({ t, tracked, inView });
  // A repeated snapshot has the same receivedAt, so the t <= last.t check above drops it.
  if (history.length > MAX_INTERFERENCE_SAMPLES) {
    const capped = capSeries(history, MAX_INTERFERENCE_SAMPLES, () => '', (previous, next) => next);
    if (capped !== history) state.satelliteViewHistory = capped;
  }
}

const SATELLITE_VIEW = { width: 900, height: 180, left: 44, right: 16, top: 22, bottom: 34 };

/**
 * Draws tracked and in-view counts on the same time axis as the interference timeline.
 * @returns {void}
 * Side effects: DOM #satellite-view-chart. Samples after axis.dataEnd are omitted. events: none.
 */
function renderSatelliteViewPlot() {
  const chart = $('satellite-view-chart');
  chart.replaceChildren();
  const { start, windowMs } = timelineViewport();
  const plotWidth = SATELLITE_VIEW.width - SATELLITE_VIEW.left - SATELLITE_VIEW.right;
  const axis = timelineAxis(start, windowMs, plotWidth);
  const bottom = SATELLITE_VIEW.height - SATELLITE_VIEW.bottom;
  const samples = state.satelliteViewHistory
    .filter((sample) => sample.t >= axis.start && sample.t <= axis.dataEnd)
    .sort((a, b) => a.t - b.t);
  const systems = [...new Set(samples.flatMap((sample) => Object.keys(sample.tracked || {})))]
    .sort((a, b) => a.localeCompare(b));
  const peak = Math.max(0, ...samples.map((sample) => Math.max(sumCounts(sample.tracked), sumCounts(sample.inView))));
  const maxCount = Math.max(8, Math.ceil(peak / 10) * 10);
  /** @param {number} count @returns {number} Y in the satellite-view plot. Side effects: none. Events: none. */
  const y = (count) => bottom - count / maxCount * (bottom - SATELLITE_VIEW.top);

  for (const count of [0, maxCount / 2, maxCount]) {
    const gridY = y(count);
    chart.append(svg('line', {
      x1: SATELLITE_VIEW.left, x2: SATELLITE_VIEW.width - SATELLITE_VIEW.right,
      y1: gridY, y2: gridY, class: 'tl-grid',
    }));
    chart.append(svg('text', { x: SATELLITE_VIEW.left - 8, y: gridY + 4, class: 'tl-axis', style: 'text-anchor:end' }, String(count)));
  }

  /**
   * Draws one satellite-view series, breaking the line when samples are more than 30 seconds apart.
   * @param {(sample: object) => number} value
   * @param {object} attributes SVG attributes for the polyline.
   * @returns {void}
   * Side effects: appends polylines to `chart`. Events: none.
   */
  const drawSeries = (value, attributes) => {
    let segment = [];
    let previousTime = null;
    /**
     * Appends the current segment when it has more than one point, then clears it.
     * @returns {void}
     * Side effects: appends a polyline to `chart`. Events: none.
     */
    const flush = () => {
      if (segment.length > 1) {
        chart.append(svg('polyline', { points: segment.join(' '), fill: 'none', ...attributes }));
      }
      segment = [];
    };
    for (const sample of samples) {
      if (previousTime !== null && sample.t - previousTime > 30000) flush();
      segment.push(`${(SATELLITE_VIEW.left + axis.x(sample.t)).toFixed(1)},${y(value(sample)).toFixed(1)}`);
      previousTime = sample.t;
    }
    flush();
  };

  if (!samples.length) {
    chart.append(svg('text', {
      x: SATELLITE_VIEW.left + plotWidth / 2, y: (SATELLITE_VIEW.top + bottom) / 2,
      class: 'tl-axis', style: 'text-anchor:middle',
    }, 'Waiting for satellite reports'));
  } else {
    drawSeries((sample) => sumCounts(sample.inView), { class: 'satellite-view-line satellite-view-in-view' });
    for (const system of systems) {
      drawSeries((sample) => sample.tracked?.[system] || 0,
        { stroke: constellationColor(system), class: 'satellite-view-line' });
    }
    drawSeries((sample) => sumCounts(sample.tracked), { class: 'satellite-view-line satellite-view-total-line' });
  }
  appendTimeAxis(chart, axis, {
    left: SATELLITE_VIEW.left,
    top: SATELLITE_VIEW.top,
    bottom,
    labelY: SATELLITE_VIEW.height - 16,
    nowLabelY: SATELLITE_VIEW.top - 8,
    gridClass: 'tl-grid',
    labelClass: 'tl-axis',
  });
}

/**
 * Display name for a constellation code.
 * @param {string} system Constellation code.
 * @returns {string}
 * Side effects: none. events: none.
 */
function constellationLabel(system) {
  return ({ GALILEO: 'Galileo', BEIDOU: 'BeiDou', GLONASS: 'GLONASS', NAVIC: 'NavIC', QZSS: 'QZSS', SBAS: 'SBAS' })[system]
    || system;
}

/**
 * Fills the message-count table from state.counts and latestByName.
 * @returns {void}
 * Side effects: DOM #counts. events: none.
 */
function renderCounts() {
  const body = document.querySelector('#counts tbody');
  body.replaceChildren();
  const names = Object.keys(state.counts).sort();
  if (!names.length) {
    emptyRow(body, 5, 'No messages received yet.');
    return;
  }
  for (const name of names) {
    const record = latestByName[name];
    const row = body.insertRow();
    cell(row, name);
    cell(row, record ? record.format : '—');
    cell(row, state.counts[name]);
    cell(row, record ? formatTime(record) : '—');
    const crc = cell(row, record ? crcLabel(record.crcValid) : '—');
    if (record && record.crcValid === false) crc.className = 'bad';
  }
}

/**
 * Rebuilds the ephemeris summary and the table for the selected constellation.
 * @returns {void}
 * Side effects: DOM #ephemeris. May write the ephemerisConstellation preference when the saved choice is absent. events: none.
 */
function renderEphemeris() {
  const container = $('ephemeris');
  container.replaceChildren();
  const messageGroups = Object.entries(state.ephemeris)
    .filter(([, entry]) => entry.records && Object.keys(entry.records).length)
    .sort(([a], [b]) => ephemerisSystem(a).localeCompare(ephemerisSystem(b)));
  const records = messageGroups.flatMap(([, entry]) => Object.values(entry.records));

  $('eph-systems').textContent = new Set(messageGroups.map(([name]) => ephemerisConstellation(name))).size;
  const latest = records.reduce((current, record) => !current || record.receivedAt > current.receivedAt ? record : current, null);
  $('eph-latest').textContent = latest ? formatTime(latest) : '—';

  if (!messageGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-panel';
    empty.textContent = 'Waiting for decoded ephemeris records.';
    container.append(empty);
    return;
  }

  const constellationGroups = new Map();
  for (const [name, entry] of messageGroups) {
    const constellation = ephemerisConstellation(name);
    const group = constellationGroups.get(constellation) || [];
    group.push(...Object.values(entry.records));
    constellationGroups.set(constellation, group);
  }

  const sortedGroups = Array.from(constellationGroups.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  const rowsByConstellation = new Map(sortedGroups.map(([constellation, constellationRecords]) => [constellation, ephemerisRows(constellationRecords)]));
  const mergedRows = Array.from(rowsByConstellation.values()).flat();
  const unhealthy = mergedRows.filter((row) => ephemerisMergedHealth(row.records) === false).length;
  $('eph-satellites').textContent = mergedRows.length;
  $('eph-unhealthy').textContent = unhealthy;
  $('eph-unhealthy').classList.toggle('alert', unhealthy > 0);

  if (!sortedGroups.some(([constellation]) => constellation === state.ephemerisConstellation)) {
    state.ephemerisConstellation = sortedGroups[0][0];
    writePreference('ephemerisConstellation', state.ephemerisConstellation);
  }

  container.append(buildEphemerisSubTabs(sortedGroups));

  for (const [constellation, constellationRecords] of sortedGroups) {
    if (constellation !== state.ephemerisConstellation) continue;
    const section = document.createElement('section');
    section.className = 'ephemeris-group';
    const heading = document.createElement('h2');
    heading.textContent = `${constellation} (${rowsByConstellation.get(constellation).length} satellites)`;
    section.append(heading);

    section.append(buildEphemerisTable(constellationRecords));
    container.append(section);
  }
}

/**
 * Builds constellation tabs that store the choice and redraw the ephemeris.
 * @param {Array} groups Pairs of constellation name and records.
 * @returns {HTMLElement}
 * Side effects: click listeners on the returned element. events: none.
 */
function buildEphemerisSubTabs(groups) {
  const nav = document.createElement('div');
  nav.className = 'ephemeris-subtabs';
  nav.setAttribute('role', 'tablist');

  for (const [constellation, records] of groups) {
    const satelliteCount = ephemerisRows(records).length;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = constellation === state.ephemerisConstellation ? 'active' : '';
    button.dataset.constellation = constellation;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', constellation === state.ephemerisConstellation ? 'true' : 'false');
    button.textContent = `${constellation} (${satelliteCount})`;
    button.addEventListener('click', () => {
      state.ephemerisConstellation = constellation;
      writePreference('ephemerisConstellation', constellation);
      renderEphemeris();
    });
    nav.append(button);
  }

  return nav;
}

const EPHEMERIS_SYSTEMS = {
  GPSEPHEM: 'GPS',
  GLOEPHEMERIS: 'GLONASS',
  GALINAVEPHEMERIS: 'Galileo I/NAV',
  GALFNAVEPHEMERIS: 'Galileo F/NAV',
  BDSEPHEMERIS: 'BeiDou',
  QZSSEPHEMERIS: 'QZSS',
  NAVICEPHEMERIS: 'NavIC',
};

/**
 * Short system label for an ephemeris message name.
 * @param {string} name Message name.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisSystem(name) {
  return EPHEMERIS_SYSTEMS[name] || name;
}

/**
 * Constellation bucket for an ephemeris message. Galileo I/NAV and F/NAV share GALILEO.
 * @param {string} name Message name.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisConstellation(name) {
  if (name.startsWith('GAL')) return 'GALILEO';
  return ephemerisSystem(name);
}

/**
 * Source tag for a merged cell, such as I/NAV or F/NAV.
 * @param {string} name Message name.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisSourceLabel(name) {
  const labels = {
    GALINAVEPHEMERIS: 'I/NAV',
    GALFNAVEPHEMERIS: 'F/NAV',
  };
  return labels[name] || ephemerisSystem(name);
}

/**
 * Map of ephemeris parameter name to value.
 * @param {object} data Decoded ephemeris data.
 * @returns {object}
 * Side effects: none. events: none.
 */
function ephemerisParameters(data) {
  return Object.fromEntries((data.parameters || []).map((parameter) => [parameter.name, parameter.value]));
}

/**
 * Health flag for one ephemeris record: true, false, or null when required fields are missing.
 * @param {string} name Message name.
 * @param {object} data Decoded ephemeris data.
 * @returns {boolean|null}
 * Side effects: none. events: none.
 */
function ephemerisHealth(name, data) {
  const values = ephemerisParameters(data);
  /** @param {...string} keys @returns {boolean} True when any named parameter is null or undefined. Side effects: none. Events: none. */
  const missing = (...keys) => keys.some((key) => values[key] === null || values[key] === undefined);
  if (name === 'GLOEPHEMERIS') {
    if (missing('health')) return null;
    return values.health >= 0 && values.health <= 3;
  }
  if (name === 'GALINAVEPHEMERIS') {
    if (missing('e1Health', 'e5Health')) return null;
    return values.e1Health === 0 && values.e5Health === 0;
  }
  if (name === 'GALFNAVEPHEMERIS') {
    if (missing('e5Health')) return null;
    return values.e5Health === 0;
  }
  if (name === 'NAVICEPHEMERIS') {
    if (missing('l5Health', 'sHealth', 'alert')) return null;
    return values.l5Health === 0 && values.sHealth === 0 && values.alert === 0;
  }
  return values.health === null || values.health === undefined ? null : values.health === 0;
}

/**
 * Builds the ephemeris table, column group, and synced scrollbar for one constellation.
 * @param {Array} records Ephemeris records.
 * @returns {HTMLElement}
 * Side effects: DOM nodes and scroll listeners on the returned shell. events: none.
 */
function buildEphemerisTable(records) {
  const container = document.createElement('div');
  container.className = 'ephemeris-table-shell';
  const wrapper = document.createElement('div');
  wrapper.className = 'ephemeris-table-wrap';
  const table = document.createElement('table');
  table.className = 'ephemeris-table';
  const head = table.createTHead();
  const rows = ephemerisRows(records);
  const ephemerisColumns = ephemerisParameterColumns(rows, false);
  const ionoColumns = ephemerisParameterColumns(rows, true);
  const parameterCount = ephemerisColumns.length + ionoColumns.length;
  const tableWidth = ephemerisTableWidth(parameterCount);
  table.style.width = tableWidth;
  table.insertBefore(buildEphemerisColumnGroup(parameterCount), table.firstChild);
  const header = head.insertRow();
  header.append(tableHeader('PRN'));
  for (const column of ephemerisColumns) header.append(tableHeader(ephemerisParameterLabel(column), ephemerisParameterTitle(column), 'parameter-heading'));
  for (const column of ionoColumns) header.append(tableHeader(ephemerisParameterLabel(column), ephemerisParameterTitle(column), 'parameter-heading iono-heading'));
  header.append(tableHeader('Health'));
  header.append(tableHeader('Updated'));

  const body = table.createTBody();

  for (const rowData of rows) {
    const row = body.insertRow();
    cell(row, rowData.satelliteId || '—');
    for (const column of ephemerisColumns) parameterCell(row, formatMergedEphemerisValue(rowData.records, column), 'parameter-value-cell');
    for (const column of ionoColumns) parameterCell(row, formatMergedEphemerisValue(rowData.records, column), 'parameter-value-cell iono-cell');
    const healthCell = cell(row, ephemerisHealthLabel(rowData.records));
    healthCell.className = `eph-health ${ephemerisHealthClass(rowData.records)}`;
    cell(row, formatTime(rowData.latest));
  }

  wrapper.append(table);
  container.append(buildEphemerisScrollbar(wrapper, tableWidth), wrapper);
  return container;
}

/**
 * Scrollbar that mirrors the ephemeris table wrapper scroll position.
 * @param {HTMLElement} wrapper Table scroller.
 * @param {string} width CSS width of the inner spacer.
 * @returns {HTMLElement}
 * Side effects: scroll listeners on the scrollbar and wrapper. events: none.
 */
function buildEphemerisScrollbar(wrapper, width) {
  const scrollbar = document.createElement('div');
  scrollbar.className = 'ephemeris-scrollbar';
  const inner = document.createElement('div');
  inner.style.width = width;
  scrollbar.append(inner);

  let syncing = false;
  scrollbar.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    wrapper.scrollLeft = scrollbar.scrollLeft;
    syncing = false;
  });
  wrapper.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    scrollbar.scrollLeft = wrapper.scrollLeft;
    syncing = false;
  });

  return scrollbar;
}

/**
 * colgroup for the PRN, parameter, health, and updated columns.
 * @param {number} parameterCount Number of parameter columns.
 * @returns {HTMLElement}
 * Side effects: none until the caller inserts the group. events: none.
 */
function buildEphemerisColumnGroup(parameterCount) {
  const group = document.createElement('colgroup');
  group.append(tableColumn('prn-col'));
  for (let index = 0; index < parameterCount; index++) group.append(tableColumn('parameter-col'));
  group.append(tableColumn('health-col'));
  group.append(tableColumn('updated-col'));
  return group;
}

/**
 * CSS width for an ephemeris table with the given parameter count.
 * @param {number} parameterCount Number of parameter columns.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisTableWidth(parameterCount) {
  return `${5.5 + (parameterCount * 5.75) + 6.5 + 8}rem`;
}

/**
 * A col element with the given class.
 * @param {string} className Column class.
 * @returns {HTMLElement}
 * Side effects: none until the caller inserts the column. events: none.
 */
function tableColumn(className) {
  const column = document.createElement('col');
  column.className = className;
  return column;
}

/**
 * Table cell that can expand when the text is long or has more than one line.
 * @param {HTMLTableRowElement} row Row to extend.
 * @param {string} text Cell text.
 * @param {string} className Cell class.
 * @returns {HTMLTableCellElement}
 * Side effects: DOM cell. Adds click and keydown listeners when the text is expandable. events: none.
 */
function parameterCell(row, text, className) {
  const td = cell(row, text, className);
  td.title = td.textContent;
  if (td.textContent.length > 12 || td.textContent.includes('\n')) {
    td.classList.add('expandable-value');
    td.tabIndex = 0;
    td.setAttribute('role', 'button');
    td.setAttribute('aria-expanded', 'false');
    td.addEventListener('click', () => toggleParameterCell(td));
    td.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleParameterCell(td);
    });
  }
  return td;
}

/**
 * Toggles the expanded class and aria-expanded on a parameter cell.
 * @param {HTMLElement} cellElement Cell to toggle.
 * @returns {void}
 * Side effects: DOM class and aria-expanded. events: none.
 */
function toggleParameterCell(cellElement) {
  const expanded = cellElement.classList.toggle('expanded');
  cellElement.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

/**
 * Groups ephemeris records by satellite id, keeping the newest record on each row.
 * @param {Array} records Ephemeris records.
 * @returns {Array}
 * Side effects: none. events: none.
 */
function ephemerisRows(records) {
  const rows = new Map();
  for (const record of records) {
    const satelliteId = record.data.satelliteId || '';
    const row = rows.get(satelliteId) || { satelliteId, records: [], latest: record };
    row.records.push(record);
    if (record.receivedAt > row.latest.receivedAt) row.latest = record;
    rows.set(satelliteId, row);
  }
  return Array.from(rows.values()).sort((a, b) => Number(a.satelliteId) - Number(b.satelliteId));
}

/**
 * A th with text and optional title and class.
 * @param {string} text Header text.
 * @param {string} [title] Tooltip.
 * @param {string} [className] Header class.
 * @returns {HTMLElement}
 * Side effects: none until the caller inserts the header. events: none.
 */
function tableHeader(text, title, className) {
  const th = document.createElement('th');
  th.textContent = text;
  if (title) th.title = title;
  if (className) th.className = className;
  return th;
}

/**
 * Parameter names to show, either ionospheric columns or the other columns.
 * @param {Array} rows Grouped ephemeris rows.
 * @param {boolean} ionoOnly When true, keep only iono-style names.
 * @returns {Array<string>}
 * Side effects: none. events: none.
 */
function ephemerisParameterColumns(rows, ionoOnly) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const record of row.records) {
      for (const parameter of record.data.parameters || []) {
        if (!shouldShowEphemerisParameter(parameter) || isIonoParameter(parameter.name) !== ionoOnly || seen.has(parameter.name)) continue;
        seen.add(parameter.name);
        columns.push(parameter.name);
      }
    }
  }
  return columns;
}

/**
 * One formatted value, or one source-prefixed line per differing record.
 * @param {Array} records Records for one satellite.
 * @param {string} name Parameter name.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatMergedEphemerisValue(records, name) {
  const values = records
    .map((record) => ({ record, parameter: (record.data.parameters || []).find((parameter) => parameter.name === name) }))
    .filter((entry) => entry.parameter);
  if (!values.length) return '—';

  const formatted = values.map(({ record, parameter }) => ({
    source: ephemerisSourceLabel(record.name),
    value: formatEphemerisValue(parameter.value, parameter.unit),
  }));
  const uniqueValues = [...new Set(formatted.map((entry) => entry.value))];
  if (uniqueValues.length === 1) return uniqueValues[0];
  return formatted.map((entry) => `${entry.source}: ${entry.value}`).join('\n');
}

/**
 * False for satelliteId and names that start with reserved.
 * @param {object} parameter Parameter with a name.
 * @returns {boolean}
 * Side effects: none. events: none.
 */
function shouldShowEphemerisParameter(parameter) {
  return parameter.name !== 'satelliteId' && !parameter.name.startsWith('reserved');
}

/**
 * True when the name ends in iono, groupDelay, timeOffset, or frequencyCorrection.
 * @param {string} name Parameter name.
 * @returns {boolean}
 * Side effects: none. events: none.
 */
function isIonoParameter(name) {
  return /(?:iono|groupDelay|timeOffset|frequencyCorrection)$/i.test(name);
}

/**
 * Unhealthy, Healthy, or Unknown for a merged satellite row.
 * @param {Array} records Records for one satellite.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisHealthLabel(records) {
  const health = ephemerisMergedHealth(records);
  return health === false ? 'Unhealthy' : health === true ? 'Healthy' : 'Unknown';
}

/**
 * CSS class bad, good, or unknown for a merged health value.
 * @param {Array} records Records for one satellite.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisHealthClass(records) {
  const health = ephemerisMergedHealth(records);
  return health === false ? 'bad' : health === true ? 'good' : 'unknown';
}

/**
 * False if any record is unhealthy, otherwise true if any is healthy, otherwise null.
 * @param {Array} records Records for one satellite.
 * @returns {boolean|null}
 * Side effects: none. events: none.
 */
function ephemerisMergedHealth(records) {
  const values = records.map((record) => ephemerisHealth(record.name, record.data));
  if (values.includes(false)) return false;
  if (values.includes(true)) return true;
  return null;
}

/**
 * Short column label for an ephemeris parameter name.
 * @param {string} name Parameter name.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisParameterLabel(name) {
  const labels = {
    tow: 'Subframe time', toe: 'Orbit ref time', toc: 'Clock ref time',
    iode1: 'IODE 1 - ephem issue', iode2: 'IODE 2 - ephem issue', iodc: 'IODC - clock issue',
    issueOfData: 'IOD nav issue', semiMajorAxis: 'Semi-major axis',
    rootSemiMajorAxis: 'Sqrt semi-major axis', meanAnomaly: 'Mean anomaly',
    deltaN: 'Delta N correction', eccentricity: 'Eccentricity',
    cuc: 'Cuc latitude corr', cus: 'Cus latitude corr', crc: 'Crc radius corr', crs: 'Crs radius corr',
    cic: 'Cic inclination corr', cis: 'Cis inclination corr',
    argumentOfPerigee: 'Argument of perigee', ascendingNode: 'Ascending node',
    ascendingNodeRate: 'Ascending node rate', inclination: 'Inclination',
    inclinationRate: 'Inclination rate', clockBias: 'Clock bias', clockDrift: 'Clock drift',
    clockDriftRate: 'Clock drift rate', correctedMeanMotion: 'Corrected mean motion',
    frequencyChannel: 'Frequency channel', satelliteType: 'Satellite type flag',
    ephemerisTime: 'Ephemeris ref time', timeOffset: 'GPS/GLONASS time offset',
    positionX: 'Position X', positionY: 'Position Y', positionZ: 'Position Z',
    velocityX: 'Velocity X', velocityY: 'Velocity Y', velocityZ: 'Velocity Z',
    accelerationX: 'Lunisolar acceleration X', accelerationY: 'Lunisolar acceleration Y',
    accelerationZ: 'Lunisolar acceleration Z', uraVariance: 'URA variance', ura: 'URA accuracy index',
    sisaIndex: 'SISA accuracy index', source: 'Navigation data source',
    health: 'Health status flag', l5Health: 'L5 health flag', sHealth: 'S-band health flag',
    e1Health: 'E1 health flag', e5Health: 'E5 health flag', e1DataValidity: 'E1 data validity flag',
    e5DataValidity: 'E5 data validity flag', antiSpoofing: 'Anti-spoofing flag', alert: 'Alert flag',
    autoNav: 'Autonav flag', fitInterval: 'Fit interval flag', flags: 'Status flags',
    userRange: 'User range accuracy flag', technology: 'Signal technology flag',
    groupDelay: 'Group delay bias', b1GroupDelay: 'B1 group delay bias', b2GroupDelay: 'B2 group delay bias',
    e1E5aGroupDelay: 'E1-E5a group delay bias', e1E5bGroupDelay: 'E1-E5b group delay bias',
    frequencyCorrection: 'Frequency correction', clockAge: 'Clock age', ephemerisAge: 'Ephemeris age',
    dayNumber: 'GLONASS day number', issue: 'Issue of data', frameTime: 'Frame time', age: 'Data age',
  };
  return labels[name] || name.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * Tooltip text for an ephemeris parameter name.
 * @param {string} name Parameter name.
 * @returns {string}
 * Side effects: none. events: none.
 */
function ephemerisParameterTitle(name) {
  const descriptors = {
    cuc: 'Cuc - argument of latitude cosine harmonic correction',
    cus: 'Cus - argument of latitude sine harmonic correction',
    crc: 'Crc - orbit radius cosine harmonic correction',
    crs: 'Crs - orbit radius sine harmonic correction',
    cic: 'Cic - inclination cosine harmonic correction',
    cis: 'Cis - inclination sine harmonic correction',
    iode1: 'IODE 1 - issue of ephemeris data from subframe 2',
    iode2: 'IODE 2 - issue of ephemeris data from subframe 3',
    iodc: 'IODC - issue of clock data',
    issueOfData: 'Issue of navigation data',
    ura: 'URA - user range accuracy index',
    uraVariance: 'URA variance - estimated user range accuracy variance',
    sisaIndex: 'SISA - Galileo signal-in-space accuracy index',
    health: 'Satellite health status flag; zero is generally healthy except GLONASS range values',
    l5Health: 'NavIC L5 signal health flag',
    sHealth: 'NavIC S-band signal health flag',
    e1Health: 'Galileo E1 signal health flag',
    e5Health: 'Galileo E5 signal health flag',
    e1DataValidity: 'Galileo E1 data validity flag',
    e5DataValidity: 'Galileo E5 data validity flag',
    antiSpoofing: 'GPS anti-spoofing flag',
    alert: 'NavIC alert flag',
    autoNav: 'NavIC autonomous navigation flag',
    fitInterval: 'Fit interval flag for the broadcast ephemeris',
    flags: 'Receiver-decoded status flags for this ephemeris record',
    source: 'Navigation data source identifier',
    technology: 'GLONASS signal technology flag',
    userRange: 'GLONASS user range accuracy flag',
    groupDelay: 'Broadcast signal group delay bias',
    b1GroupDelay: 'BeiDou B1 group delay bias',
    b2GroupDelay: 'BeiDou B2 group delay bias',
    e1E5aGroupDelay: 'Galileo E1-E5a broadcast group delay bias',
    e1E5bGroupDelay: 'Galileo E1-E5b broadcast group delay bias',
  };
  return descriptors[name] || `${ephemerisParameterLabel(name)} (${name})`;
}

/**
 * Formats a number with its unit, or an em dash when the value is null.
 * @param {*} value Parameter value.
 * @param {string} [unit] Unit suffix.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatEphemerisValue(value, unit) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  let formatted;
  if (Number.isInteger(value)) formatted = value.toLocaleString('en-US');
  else if (value !== 0 && (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e7)) formatted = value.toExponential(9);
  else formatted = value.toPrecision(10).replace(/\.?0+$/, '');
  return unit ? `${formatted} ${unit}` : formatted;
}

const latestByName = {};

let lastItReportHadDetections = false;

/**
 * Prepends one interference event. A clear report is skipped when CRC failed or the previous report had no detections.
 * @param {object} record ITDETECTSTATUS report.
 * @returns {void}
 * Side effects: DOM #it-log, trimmed to MAX_IT_ROWS, and lastItReportHadDetections. Returns when data is missing. events: none.
 */
function appendItRow(record) {
  const d = record.data;
  if (!d) return;
  if (d.detectionCount === 0) {
    if (record.crcValid === false || !lastItReportHadDetections) return;
    lastItReportHadDetections = false;
  } else if (d.detectionCount > 0 && record.crcValid !== false) {
    lastItReportHadDetections = true;
  }
  const item = document.createElement('li');
  if (d.detectionCount > 0) item.className = 'has-detections';

  const time = document.createElement('span');
  time.className = 'time';
  time.dataset.timestamp = (record.header && record.header.utc) || record.receivedAt || '';
  time.textContent = formatTime(record);

  const content = document.createElement('div');
  content.className = 'it-event';
  const summary = document.createElement('div');
  summary.className = 'it-event-summary';
  const signals = [...new Set((d.detections || []).map((detection) => detection.signalType))];
  summary.textContent = `${d.detectionCount} detection${d.detectionCount === 1 ? '' : 's'}`
    + (signals.length ? ` on ${signals.join(', ')}` : ' - clear')
    + (record.crcValid === false ? ' [CRC FAIL]' : '');

  content.append(summary);
  if (d.detectionCount === 0) {
    const description = document.createElement('div');
    description.className = 'it-event-detail';
    description.textContent = 'The receiver reports no active interference detections.';
    content.append(description);
  } else {
    for (const detection of d.detections || []) {
      const description = document.createElement('div');
      description.className = 'it-event-detail';
      description.textContent = `${detection.signalType} - ${detectionTypeLabel(detection.type)}: ${describeDetection(detection)}`;
      content.append(description);
    }
  }

  item.append(time, content);
  $('it-log').prepend(item);
  while ($('it-log').children.length > MAX_IT_ROWS) $('it-log').lastElementChild.remove();
}

/**
 * Prepends one raw log row unless the log is paused, and trims the list to MAX_RAW_ROWS.
 * @param {object} record Raw display record.
 * @returns {void}
 * Side effects: DOM #raw-log. registerFilterOption may throw. events: none.
 */
function appendRawRow(record) {
  registerFilterOption(record.name);
  if (state.paused) return;

  const item = document.createElement('li');
  item.dataset.name = record.name;
  if (record.crcValid === false) item.classList.add('crc-fail');
  if (state.filter && state.filter !== record.name) item.hidden = true;

  const time = document.createElement('span');
  time.className = 'time';
  time.dataset.timestamp = record.receivedAt || '';
  time.textContent = formatTimestamp(record.receivedAt);

  const tag = document.createElement('span');
  tag.className = `tag ${record.format}`;
  tag.textContent = record.name;

  const raw = document.createElement('pre');
  const rawText = String(record.raw ?? '');
  raw.textContent = rawText.length > 16384 ? `${rawText.slice(0, 16384)} [display truncated]` : rawText;

  item.append(time, tag, raw);
  $('raw-log').prepend(item);
  while ($('raw-log').children.length > MAX_RAW_ROWS) $('raw-log').lastElementChild.remove();
}

/**
 * Hides raw-log rows whose name is not the selected filter.
 * @returns {void}
 * Side effects: DOM hidden on raw-log children. events: none.
 */
function applyRawFilter() {
  for (const item of $('raw-log').children) {
    item.hidden = Boolean(state.filter) && item.dataset.name !== state.filter;
  }
}

/**
 * Adds a raw-log filter option once. Throws when the select would grow past 256 names.
 * @param {string} name Message name.
 * @returns {void}
 * Side effects: DOM option on #raw-filter. events: none.
 */
function registerFilterOption(name) {
  const select = $('raw-filter');
  if ([...select.options].some((o) => o.value === name)) return;
  if (select.options.length >= 257) throw new Error('Too many raw log filter options');
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  select.append(option);
}

// --- helpers ----------------------------------------------------------------

/**
 * Appends a td, using an em dash for null or undefined.
 * @param {HTMLTableRowElement} row Row to extend.
 * @param {*} text Cell text.
 * @param {string} [className] Cell class.
 * @returns {HTMLTableCellElement}
 * Side effects: DOM cell. events: none.
 */
function cell(row, text, className) {
  const td = row.insertCell();
  td.textContent = text === null || text === undefined ? '—' : String(text);
  if (className) td.className = className;
  return td;
}

/**
 * Inserts a single spanning cell with the empty-state text.
 * @param {HTMLTableSectionElement} body Table body.
 * @param {number} span Column span.
 * @param {string} text Empty-state text.
 * @returns {void}
 * Side effects: DOM row. events: none.
 */
function emptyRow(body, span, text) {
  const row = body.insertRow();
  row.className = 'empty';
  const td = row.insertCell();
  td.colSpan = span;
  td.textContent = text;
}

/**
 * OK, FAIL, or an em dash for a CRC flag.
 * @param {boolean|null} valid crcValid flag.
 * @returns {string}
 * Side effects: none. events: none.
 */
function crcLabel(valid) {
  if (valid === true) return 'OK';
  if (valid === false) return 'FAIL';
  return '—';
}

/**
 * Fixed-digit number plus suffix, or an em dash when the value is empty or NaN.
 * @param {*} value Number to format.
 * @param {number} digits Digits after the decimal.
 * @param {string} [suffix] Text appended after the number.
 * @returns {string}
 * Side effects: none. events: none.
 */
function fmt(value, digits, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(digits)}${suffix}`;
}

/**
 * Hertz as MHz, kHz, or Hz, or an em dash when null.
 * @param {number|null} hz Frequency in hertz.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatFrequency(hz) {
  if (hz === null || hz === undefined) return '—';
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(4)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz} Hz`;
}

/**
 * Formats header UTC when present, otherwise receivedAt.
 * @param {object} record Report with header and receivedAt.
 * @returns {string}
 * Side effects: none. events: none.
 */
function formatTime(record) {
  const iso = (record.header && record.header.utc) || record.receivedAt;
  return formatTimestamp(iso);
}

/**
 * Formats an instant in the selected time zone, or an em dash when it is empty or invalid.
 * @param {*} timestamp Date, epoch, or ISO string.
 * @param {boolean} [detailed] Include the date and milliseconds.
 * @returns {string}
 * Side effects: may cache an Intl formatter. events: none.
 */
function formatTimestamp(timestamp, detailed = false) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return '—';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '—';
  return dateFormatter({
    timeZone: state.timeZone, hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset',
    ...(detailed ? { year: 'numeric', month: '2-digit', day: '2-digit', fractionalSecondDigits: 3 } : {}),
  }).format(date);
}

const dateFormatters = new Map();
/**
 * Returns a cached en-GB DateTimeFormat, clearing the cache once it holds 12 entries.
 * @param {object} options Intl options.
 * @returns {Intl.DateTimeFormat}
 * Side effects: mutates the dateFormatters map. events: none.
 */
function dateFormatter(options) {
  const key = JSON.stringify(options);
  if (!dateFormatters.has(key)) {
    const formatter = new Intl.DateTimeFormat('en-GB', options);
    if (dateFormatters.size >= 12) dateFormatters.clear();
    dateFormatters.set(key, formatter);
  }
  return dateFormatters.get(key);
}

/**
 * Fills the time-zone select and re-renders timestamps when it changes.
 * @returns {void}
 * Side effects: DOM select and a change listener that writes the timeZone preference and redraws several views. events: none.
 */
function initTimeZone() {
  const select = $('time-zone');
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  for (const zone of new Set([...zones, state.timeZone])) {
    if ([...select.options].some((option) => option.value === zone)) continue;
    const option = document.createElement('option');
    option.value = zone;
    option.textContent = zone.replace(/_/g, ' ');
    select.append(option);
  }
  select.value = state.timeZone;
  select.addEventListener('change', () => {
    state.timeZone = select.value;
    writePreference('timeZone', state.timeZone);
    for (const element of document.querySelectorAll('[data-timestamp]')) {
      element.textContent = formatTimestamp(element.dataset.timestamp);
    }
    if (latestByName.ITDETECTSTATUS) renderItDetect(latestByName.ITDETECTSTATUS);
    renderCounts();
    renderEphemeris();
    renderTimeline();
  });
}

// Always-on screens can still grow outside the JS arrays (renderer, a leaked popup).
// Above this heap, reload the same URL so ?wall=1 stays. heapmb=0 turns it off.
// heapmb=N (megabytes) replaces the default. Absent means 768. A page younger than
// 10 minutes is left alone, and a reload is not repeated inside 15 minutes.
const HEAP_RELOAD_DEFAULT_MB = 768;
const HEAP_RELOAD_MIN_UPTIME_MS = 10 * 60 * 1000;
const HEAP_RELOAD_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Heap reload threshold in megabytes, or 0 when the safety net is off.
 * @returns {number}
 * Side effects: reads location.search. events: none.
 */
function heapReloadLimitMb() {
  const params = new URLSearchParams(location.search);
  if (!params.has('heapmb')) return HEAP_RELOAD_DEFAULT_MB;
  const value = Number(params.get('heapmb'));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Reloads the page when performance.memory is over the heap threshold.
 * Browsers without performance.memory do nothing. The URL, including wall=1, is kept.
 * location.reload() leaves the Fullscreen API, and a page cannot re-enter it without
 * a user gesture. Wall layout is the html.wall class from ?wall=1, which survives
 * the reload. Fullscreen on an unattended display is Chrome kiosk mode, documented
 * in the README, not a control on this page.
 * @returns {void}
 * Side effects: sessionStorage key gnssHeapReloadAt, console.warn, and location.reload. events: none.
 */
function maybeReloadForHeap() {
  const limit = heapReloadLimitMb();
  if (!limit || typeof performance === 'undefined' || !performance.memory) return;
  if (Date.now() - liveStatusStartedAt < HEAP_RELOAD_MIN_UPTIME_MS) return;
  const used = performance.memory.usedJSHeapSize;
  if (!Number.isFinite(used) || used / (1024 * 1024) < limit) return;
  let last = 0;
  try { last = Number(sessionStorage.getItem('gnssHeapReloadAt')) || 0; } catch { /* private mode */ }
  if (last && Date.now() - last < HEAP_RELOAD_COOLDOWN_MS) return;
  try { sessionStorage.setItem('gnssHeapReloadAt', String(Date.now())); } catch { /* still reload */ }
  console.warn(`JavaScript heap is ${Math.round(used / (1024 * 1024))} MB, above ${limit} MB. Reloading to release memory.`);
  location.reload();
}

setInterval(() => flushUpdates(), 250);
setInterval(maybeReloadForHeap, 60000);
setInterval(() => {
  const tab = document.querySelector('.tab.active')?.dataset.tab;
  if (!document.hidden && tab === 'satellites') {
    renderSafely('Updating satellite report freshness', renderSkyplot);
  }
  if (!document.hidden && tab === 'interference') {
    renderSafely('Updating live device status', () => {
      renderVerdict();
      if (!interferenceIsLive(latestByName.ITDETECTSTATUS)) renderBands();
    });
  }
}, 1000);
setInterval(() => {
  pruneClientHistory();
  timelineDirty = true;
}, 15000);
window.addEventListener('resize', () => { timelineDirty = true; });
document.addEventListener('visibilitychange', () => {
  // Hidden: close /events, abort the history request, and cancel a queued wall frame.
  // Visible: open /events again and reload history. No backoff timer. Listeners are not added again.
  if (document.hidden) {
    source?.close();
    source = null;
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
    }
    historyRequest++;
    historyController?.abort();
    cancelWallReflow();
  } else {
    connectStream();
    loadHistory();
  }
});
// error and unhandledrejection are shown by the client error reporter. These listeners do not dispatch another event.
window.addEventListener('error', (event) => reportClientError('Display error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportClientError('Asynchronous display error', event.reason));
$('retry-display').addEventListener('click', () => {
  // Clears the notice, closes /events, opens it again, and reloads history.
  $('client-error').hidden = true;
  lastErrorNotice = '';
  source?.close();
  source = null;
  connectStream();
  loadHistory();
});

syncHeightToggle();
initTimeZone();
initTimelineControls();
connectStream();
loadHistory();
// Long windows are served downsampled; re-fetching keeps their oldest hours from being trimmed by the cap.
setInterval(() => {
  if (!document.hidden && state.windowMinutes >= 360) loadHistory();
}, 30 * 60000);
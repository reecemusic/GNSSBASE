'use strict';

const $ = (id) => document.getElementById(id);
const MAX_RAW_ROWS = 300;
const MAX_IT_ROWS = 50;
// Room for a downsampled 24 h history response plus many hours of live reports arriving on top of it.
const MAX_INTERFERENCE_SAMPLES = 40000;
const HISTORY_REQUEST_LIMIT = 15000;
const MAX_TRACK_SAMPLES = 1081;
const MAX_TRACKS = 512;
const MAX_EVENT_CHARS = 8 * 1024 * 1024;
const dirtyRecords = new Set();
const pendingRaw = [];
const pendingInterference = [];
let countsDirty = false;
let ephemerisDirty = false;
let timelineDirty = false;
let lastErrorNotice = '';

function reportClientError(context, error) {
  const message = `${context}: ${error instanceof Error ? error.message : String(error)}`;
  const notice = $('client-error');
  if (notice) {
    notice.hidden = false;
    notice.textContent = `${message}. Use Retry display to reload current data.`;
  }
  if (lastErrorNotice !== message) console.error(message, error);
  lastErrorNotice = message;
}

function readPreference(key, fallback, parse = (value) => value) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : parse(value);
  } catch (error) {
    reportClientError(`Could not read preference ${key}`, error);
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    reportClientError(`Could not save preference ${key}`, error);
  }
}

async function request(url, options = {}, json = false) {
  const controller = new AbortController();
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

function updateConnectionFields() {
  const transport = connectionTransport.value;
  $('tcp-fields').hidden = transport === 'serial';
  $('serial-fields').hidden = transport === 'tcp';
}

function connectionPhase() {
  const status = connection.status;
  if (connection.offline) return 'offline';
  if (!status) return 'connecting';
  if (status.connected) return 'connected';
  return status.phase || 'waiting';
}

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
    detail = `Receiver port open via ${connectionTarget(status)}`
      + (auto && status.transport === 'tcp' ? ' · USB serial unavailable, using TCP fallback' : '');
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

function handleStreamEvent(context, event, handler) {
  try {
    if (event.data.length > MAX_EVENT_CHARS) throw new Error('Live event exceeds the display size limit');
    const data = JSON.parse(event.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a data object');
    handler(data);
  } catch (error) {
    reportClientError(context, error);
  }
}

function connectStream() {
  if (source || document.hidden) return;
  source = new EventSource('/events');
  source.addEventListener('status', (event) => handleStreamEvent('Receiver status', event, renderStatus));
  source.addEventListener('snapshot', (event) => handleStreamEvent('Loading live snapshot', event, applySnapshot));
  source.addEventListener('message', (event) => handleStreamEvent('Reading live report', event, applyPayload));
  source.addEventListener('archive', (event) => handleStreamEvent('Archive status', event, applyArchiveStatus));
  source.addEventListener('open', () => {
    connection.offline = false;
    renderConnectionBar();
  });
  source.addEventListener('error', () => {
    connection.offline = true;
    renderConnectionBar();
  });
}

function applySnapshot(snap) {
  if (snap.status) renderStatus(snap.status);
  if (snap.archive) applyArchiveStatus(snap.archive);
  state.counts = snap.counts || {};
  state.ephemeris = snap.ephemeris || {};
  state.itBySignal = snap.itdetectBySignal || {};
  state.satvis = snap.satvisBySystem || {};
  state.itSeen = state.counts.ITDETECTSTATUS || 0;

  pendingRaw.length = 0;
  pendingInterference.length = 0;
  Object.values(snap.latest || {}).forEach(applyRecord);
  $('it-log').replaceChildren();
  lastItReportHadDetections = false;
  (snap.itdetectHistory || []).slice(-MAX_IT_ROWS).forEach((record) => queueRecord(pendingInterference, record, MAX_IT_ROWS));
  $('raw-log').replaceChildren();
  (snap.rawLog || []).slice(-MAX_RAW_ROWS).forEach((record) => queueRecord(pendingRaw, record, MAX_RAW_ROWS));
  countsDirty = ephemerisDirty = timelineDirty = true;
}

function applyPayload(payload) {
  validateRecord(payload.record);
  state.counts = payload.counts;
  if (payload.ephemeris) state.ephemeris = payload.ephemeris;
  recordLiveHistory(payload.record);
  applyRecord(payload.record);
  if (payload.record.name === 'ITDETECTSTATUS') {
    state.itSeen = state.counts.ITDETECTSTATUS || 0;
    queueRecord(pendingInterference, payload.record, MAX_IT_ROWS);
    timelineDirty = true;
  }
  if (payload.record.name === 'BESTPOS') timelineDirty = true;
  if (!state.paused) queueRecord(pendingRaw, rawDisplayRecord(payload.record), MAX_RAW_ROWS);
  countsDirty = true;
  if (payload.ephemeris) ephemerisDirty = true;
}

function queueRecord(queue, record, limit) {
  queue.push(record);
  if (queue.length > limit) queue.splice(0, queue.length - limit);
}

function rawDisplayRecord(record) {
  const text = String(record.raw ?? '');
  return {
    name: record.name, format: record.format, crcValid: record.crcValid, receivedAt: record.receivedAt,
    raw: text.length > 16384 ? `${text.slice(0, 16384)} [display truncated]` : text,
  };
}

function renderSafely(label, render) {
  try {
    render();
  } catch (error) {
    reportClientError(label, error);
  }
}

function flushUpdates(force = false) {
  if (document.hidden) return;
  const tab = document.querySelector('.tab.active')?.dataset.tab;
  const renderers = {
    overview: () => { if (force || countsDirty) renderCounts(); },
    position: () => {
      if (latestByName.BESTPOS) renderBestPos(latestByName.BESTPOS);
      if (latestByName.BESTGNSSPOS) renderBestGnssPos(latestByName.BESTGNSSPOS);
    },
    satellites: () => {
      renderSkyplot();
      if (latestByName.RANGE) renderRange(latestByName.RANGE);
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
    satellites: ['RANGE', 'SATVIS2', 'BESTSATS'].some((name) => dirtyRecords.has(name)),
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

function renderStatus(status) {
  connection.status = status;
  connection.offline = false;
  renderConnectionBar();
}

function applyRecord(record) {
  validateRecord(record);
  latestByName[record.name] = record;
  dirtyRecords.add(record.name);
  if (record.name === 'SATVIS2' && record.data) state.satvis[record.data.system] = record;
  if (record.name === 'VERSION') renderVersionSummary(record);
  registerFilterOption(record.name);
}

function validateRecord(record) {
  if (!record || typeof record.name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(record.name)) {
    throw new Error('Report has an invalid message name');
  }
  if (record.data !== undefined && record.data !== null && (typeof record.data !== 'object' || Array.isArray(record.data))) {
    throw new Error(`${record.name} has invalid report data`);
  }
  if (Object.keys(latestByName).length >= 256 && !Object.hasOwn(latestByName, record.name)) {
    throw new Error('Too many distinct message types');
  }
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

function explainSolution(solutionStatus, positionType) {
  const status = SOLUTION_STATUS_TEXT[solutionStatus] || solutionStatus || '';
  const type = POSITION_TYPE_TEXT[positionType];
  if (!type) return { text: status, quality: null };
  const accuracy = type[2] ? ` (${type[2]})` : '';
  return { text: `${status}. ${type[0]}${accuracy}.`, quality: type[1] };
}

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
  $('pos-undulation').textContent = Number.isFinite(d.undulation)
    ? `geoid undulation ${d.undulation.toFixed(3)} m · ${state.heightDatum === 'ellipsoidal' ? `MSL ${d.heightMsl.toFixed(3)} m` : `ellipsoidal ${(d.heightMsl + d.undulation).toFixed(3)} m`}`
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

/** Plots the antenna position. Silently degrades to a message when offline. */
function updateMap(d) {
  if (!Number.isFinite(d.latitude) || !Number.isFinite(d.longitude)) return;
  if (d.latitude === 0 && d.longitude === 0) return;

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

  marker.bindPopup(`<b>${d.solutionStatus} / ${d.positionType}</b><br>`
    + `${d.latitude.toFixed(9)}, ${d.longitude.toFixed(9)}<br>`
    + `${fmt(heightFor(d), 3, ' m')} ${state.heightDatum === 'ellipsoidal' ? 'ellipsoidal' : 'MSL'} &middot; ${d.satellitesUsed ?? '?'} SVs`);
}

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

function constellationColor(system) {
  return CONSTELLATIONS[(system || '').toUpperCase()] || '#9aa4b5';
}

/** Polar projection: elevation 90° at centre, 0° at the rim, azimuth clockwise from north. */
function skyPosition(elevationDeg, azimuthDeg) {
  const radius = ((90 - elevationDeg) / 90) * SKY.r;
  const azimuth = (azimuthDeg * Math.PI) / 180;
  return { x: SKY.cx + radius * Math.sin(azimuth), y: SKY.cy - radius * Math.cos(azimuth) };
}

function isValidSkyPosition(elevation, azimuth) {
  return Number.isFinite(elevation) && elevation >= 0 && elevation <= 90
    && Number.isFinite(azimuth) && azimuth >= 0 && azimuth < 360;
}

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
    const savedInterference = data.interference.slice(-MAX_INTERFERENCE_SAMPLES);
    const arrivedDuringRequest = state.interferenceHistory.filter((sample) => sample.t >= requestedAt);
    const keys = new Set(savedInterference.map((sample) => `${sample.t}:${sample.signal}:${sample.count}:${sample.maxPower}`));
    state.interferenceHistory = [...savedInterference, ...arrivedDuringRequest.filter((sample) =>
      !keys.has(`${sample.t}:${sample.signal}:${sample.count}:${sample.maxPower}`))];
    state.interferenceHistory.sort((a, b) => a.t - b.t);
    if (Array.isArray(data.solution)) {
      const savedSolution = data.solution.slice(-MAX_INTERFERENCE_SAMPLES)
        .map((sample) => solutionSample(sample, sample?.t)).filter(Boolean).sort((a, b) => a.t - b.t);
      const lastSaved = savedSolution.length ? savedSolution[savedSolution.length - 1].t : -Infinity;
      const solutionDuringRequest = (state.solutionHistory || []).filter((sample) => sample.t >= requestedAt && sample.t > lastSaved);
      state.solutionHistory = [...savedSolution, ...solutionDuringRequest];
    }
    pruneClientHistory();
    capHistoryWindow(data.retentionMinutes);
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

function pruneClientHistory() {
  const cutoff = Date.now() - state.windowMinutes * 60000;
  state.interferenceHistory = state.interferenceHistory.filter((s) => Number.isFinite(s.t) && s.t >= cutoff).slice(-MAX_INTERFERENCE_SAMPLES);
  if (state.solutionHistory) {
    state.solutionHistory = state.solutionHistory.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff)
      .slice(-MAX_INTERFERENCE_SAMPLES);
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

function recordLiveHistory(record) {
  const now = Date.now();
  if (record.name === 'SATVIS2' && record.data) {
    for (const sat of record.data.satellites || []) {
      if (!isValidSkyPosition(sat.elevation, sat.azimuth)) continue;
      const key = `${record.data.system}:${sat.prn}`;
      if (!Object.hasOwn(state.tracks, key) && Object.keys(state.tracks).length >= MAX_TRACKS) {
        throw new Error('Too many satellite tracks');
      }
      const samples = state.tracks[key] || (state.tracks[key] = []);
      const last = samples[samples.length - 1];
      if (last && now - last.t < 20000) continue;
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
    state.interferenceHistory.splice(0, state.interferenceHistory.length - MAX_INTERFERENCE_SAMPLES);
  }
  if (record.name === 'BESTPOS' && record.data) recordSolution(record.data, now);
}

// Unchanged solutions are thinned to one sample per heartbeat, matching the server history.
const SOLUTION_HEARTBEAT_MS = 10000;

function solutionSample(data, t) {
  if (!data || !Number.isFinite(t)) return null;
  const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 255 ? value : null);
  const text = (value) => (typeof value === 'string' && value ? value.slice(0, 32) : null);
  const sample = {
    t, used: count(data.used ?? data.satellitesUsed), tracked: count(data.tracked ?? data.satellitesTracked),
    status: text(data.status ?? data.solutionStatus), type: text(data.type ?? data.positionType),
  };
  return sample.used === null && sample.type === null ? null : sample;
}

function recordSolution(data, now) {
  const sample = solutionSample(data, now);
  if (!sample) return;
  const history = state.solutionHistory || (state.solutionHistory = []);
  const last = history[history.length - 1];
  if (last && now - last.t < SOLUTION_HEARTBEAT_MS && last.used === sample.used && last.tracked === sample.tracked
    && last.status === sample.status && last.type === sample.type) return;
  history.push(sample);
  if (history.length > MAX_INTERFERENCE_SAMPLES) history.splice(0, history.length - MAX_INTERFERENCE_SAMPLES);
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

function timelineViewport(now = Date.now()) {
  const historyMs = state.windowMinutes * 60000;
  const spanMs = timelineSpanMs(now);
  const windowMs = Math.min(spanMs, Math.max(10000, state.timelineView?.windowMs || historyMs));
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

function timelineAxisMs(windowMs) {
  return windowMs / (1 - TIMELINE_NOW_INSET);
}

/** Display axis for a viewport: spans the viewport plus headroom, mapping times to plot-relative x. */
function timelineAxis(start, windowMs, plotWidth, now = Date.now()) {
  const axisMs = timelineAxisMs(windowMs);
  const end = start + axisMs;
  return {
    start, end, axisMs, plotWidth,
    dataEnd: Math.min(now, end),
    now: now >= start && now <= end ? now : null,
    x: (time) => (time - start) / axisMs * plotWidth,
  };
}

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

function setTimelineView(end, windowMs) {
  state.timelineView = { end, windowMs };
  const view = timelineViewport();
  state.timelineView = { end: view.end, windowMs: view.windowMs };
  renderTimeline();
}

function zoomTimeline(factor, fraction = 0.5) {
  const view = timelineViewport();
  const windowMs = Math.max(10000, Math.min(timelineSpanMs(), view.windowMs * factor));
  const anchor = view.start + fraction * timelineAxisMs(view.windowMs);
  setTimelineView(anchor - fraction * timelineAxisMs(windowMs) + windowMs, windowMs);
}

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

function initTimePlotNavigation(chart) {
  let drag = null;
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
    drag = { id: event.pointerId, x: event.clientX, width: area.width, view: timelineViewport() };
    chart.setPointerCapture(event.pointerId);
    chart.classList.add('panning');
  });
  chart.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const offset = (event.clientX - drag.x) / drag.width * timelineAxisMs(drag.view.windowMs);
    setTimelineView(drag.view.end - offset, drag.view.windowMs);
  });
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

function renderTimeline() {
  const chart = $('timeline');
  chart.replaceChildren();

  const width = Math.min(1920, Math.max(360, Math.round(chart.getBoundingClientRect().width) || TIMELINE.width));
  chart.setAttribute('viewBox', `0 0 ${width} ${TIMELINE.height}`);
  const { start, end, windowMs } = timelineViewport();
  const bandIds = TIMELINE_BANDS;
  const rowHeight = (TIMELINE.height - TIMELINE.top - TIMELINE.bottom
    - TIMELINE_SOLUTION_ROWS * TIMELINE.solutionRow) / bandIds.length;
  const plotWidth = width - TIMELINE.left - TIMELINE.right;
  const now = Date.now();
  const axis = timelineAxis(start, windowMs, plotWidth, now);

  const samples = state.interferenceHistory.filter((sample) => sample.t >= start && sample.t <= axis.dataEnd)
    .sort((a, b) => a.t - b.t);
  $('timeline-range').textContent = `(${samples.length} samples, ${(windowMs / 1000).toFixed(0)} s window)`;
  $('timeline-mode').textContent = !state.timelineView ? 'Live'
    : state.timelineView.follow ? 'Live + archive' : 'Historical view';
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

  renderSpectrumPlots(start, end, windowMs);
  drawSolutionTimeline(chart, axis, TIMELINE.top + bandIds.length * rowHeight, width);

  appendTimeAxis(chart, axis, {
    left: TIMELINE.left,
    top: TIMELINE.top,
    bottom: TIMELINE.height - TIMELINE.bottom,
    labelY: TIMELINE.height - 32,
    nowLabelY: TIMELINE.top - 8,
    gridClass: 'tl-grid',
    labelClass: 'tl-axis',
  }, now);

  chart.append(svg('text', { x: TIMELINE.left, y: TIMELINE.height - 5, class: 'tl-title' },
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
      if (sample.count > 0 && classifyBand(sample.signal, []) === band) {
        result.push(sample);
        hit = true;
      }
    }
    if (!hit) result.push({ t: first.t, signal: 'ALL', count: 0, maxPower: null });
  }
  return result;
}

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
      if (sample.count <= 0 || classifyBand(sample.signal, []) !== band) continue;
      const pixel = Math.round(axis.x(sample.t));
      const previous = pixels.get(pixel);
      if (!previous || (Number.isFinite(sample.maxPower)
        && (!Number.isFinite(previous.maxPower) || sample.maxPower > previous.maxPower))) {
        pixels.set(pixel, sample);
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
  const xFor = (time) => Math.max(TIMELINE.left, Math.min(right, TIMELINE.left + axis.x(time)));
  const samples = timelineSolutionSamples(axis.start, axis.dataEnd);
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

function spectrumAllocation([label, system, centerOrStart, widthOrEnd]) {
  return {
    label,
    min: widthOrEnd > centerOrStart ? centerOrStart : centerOrStart - widthOrEnd / 2,
    max: widthOrEnd > centerOrStart ? widthOrEnd : centerOrStart + widthOrEnd / 2,
  };
}

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
    const xFor = (time) => left + axis.x(time);
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
    const visibleHits = plotHits.slice(-400);
    const visibleArchiveHits = archivePlotHits.slice(-400);
    hitSummary.textContent = plotHits.length ? `${plotHits.length} hit${plotHits.length === 1 ? '' : 's'}` : 'No frequency hits';
    if (plotHits.length > visibleHits.length) hitSummary.textContent += ` · showing latest ${visibleHits.length}`;
    if (archivePlotHits.length) {
      hitSummary.textContent += ` · ${archivePlotHits.length} archive`
        + (archivePlotHits.length > visibleArchiveHits.length ? ` (latest ${visibleArchiveHits.length} shown)` : '');
    }

    const hitMarkers = [
      ...visibleArchiveHits.map((hit) => ({ ...hit, archive: true })),
      ...visibleHits.map((hit) => ({ ...hit, archive: false })),
    ];
    for (const { sample, detection, archive } of hitMarkers) {
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
        + `, ${formatTimestamp(sample.t, true)}`);
      marker.append(title);
      svgChart.append(marker);
    }

    for (let tick = 0; tick <= 4; tick++) {
      const frequency = plot.min + ((plot.max - plot.min) * tick) / 4;
      for (const [x, className] of [[left - 8, 'spectrum-label'], [left + plotWidth + 8, 'spectrum-label spectrum-label-right']]) {
        svgChart.append(svg('text', { x, y: yFor(frequency) + 4, class: className }, frequency.toFixed(1)));
      }
    }
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

function utcLabel(timestamp, windowMs = timelineViewport().windowMs) {
  return timelineTimeLabel(timestamp, windowMs);
}

function timelineTimeLabel(timestamp, windowMs) {
  return dateFormatter({
    timeZone: state.timeZone, hour: '2-digit', minute: '2-digit',
    ...(windowMs < 3600000 ? { second: '2-digit' } : {}),
    ...(windowMs > 86400000 ? { day: '2-digit', month: 'short' } : {}),
    hourCycle: 'h23',
  }).format(new Date(timestamp));
}

function powerColour(powerDbm) {
  if (!Number.isFinite(powerDbm)) return '#ffb02e';
  if (powerDbm > -95) return '#ff5f56';
  if (powerDbm > -110) return '#ffb02e';
  return '#ffd98a';
}

function formatWindow(minutes) {
  if (minutes >= 60) return `${Math.round(minutes / 60)} h`;
  return `${minutes} min`;
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

// --- historic archive -------------------------------------------------------

const ARCHIVE_BUSY = new Set(['listing', 'scanning']);
const archiveFetch = { timer: null, delay: 0, controller: null, wanted: null, generation: 0, startedAt: 0 };

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function applyArchiveStatus(status) {
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
    const clock = (time) => dateFormatter({ timeZone: state.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .format(new Date(time));
    parts.push(`Keep loaded: on, every ${formatSpan(auto.refreshMs || 900000)}`
      + `${Number.isFinite(auto.lastRunAt) ? ` · last refresh ${clock(auto.lastRunAt)}` : ''}`
      + `${Number.isFinite(auto.nextRunAt) ? ` · next ${clock(auto.nextRunAt)}` : ''}.`
      + `${auto.lastError ? ` Last refresh problem: ${auto.lastError}.` : ''}`);
  }
  $('archive-status').textContent = parts.join(' ');
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
  state.timelineView = { end: Date.now(), windowMs: Date.now() - status.from, follow: true };
  timelineDirty = true;
}

async function loadArchiveSettings() {
  try {
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
  archiveRequest('/api/archive/cancel').catch((error) => { $('archive-status').textContent = error.message; });
});

$('archive-clear').addEventListener('click', () => {
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
setInterval(() => {
  if (ARCHIVE_BUSY.has(state.archive.status?.state)) renderArchiveStatus();
}, 1000);

function renderSkyplot() {
  const satellites = buildSatelliteList();
  const plot = $('skyplot');
  const fallback = $('sky-fallback');

  if (!satellites.length) {
    plot.classList.remove('ready');
    fallback.hidden = false;
    return;
  }
  fallback.hidden = true;
  plot.classList.add('ready');
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

  const counts = { used: 0, tracked: 0, visible: 0, missing: 0, unhealthy: 0 };
  const perSystem = {};
  let plotted = 0;

  if (state.showTraces) {
    for (const sat of satellites) {
      if (state.hiddenSystems.has(sat.system) || sat.state === 'visible') continue;
      for (const path of tracePaths(sat)) plot.append(path);
    }
  }

  for (const sat of satellites) {
    perSystem[sat.system] = perSystem[sat.system] || { visible: 0, used: 0 };
    if (state.hiddenSystems.has(sat.system)) continue;

    counts[sat.state]++;
    perSystem[sat.system].visible++;
    if (sat.state === 'used') perSystem[sat.system].used++;

    if (sat.state === 'visible'
      || !Number.isFinite(sat.elevation) || !Number.isFinite(sat.azimuth) || sat.elevation < 0) continue;
    plotted++;
    plot.append(buildSatMarker(sat));
  }

  $('sv-used').textContent = counts.used;
  $('sv-tracked').textContent = counts.tracked;
  $('sv-missing').textContent = counts.missing;
  $('sv-unhealthy').textContent = counts.unhealthy;
  $('sv-missing').classList.toggle('alert', counts.missing > 0);
  $('sv-unhealthy').classList.toggle('alert', counts.unhealthy > 0);
  $('sky-count').textContent = `(${plotted} plotted)`;

  renderSkyLegend(perSystem);
  renderSignalLegend(signalBreakdown(satellites));
  renderSatelliteTable(satellites);
}

const STATE_TEXT = {
  used: 'Used in solution',
  tracked: 'Tracked, not used',
  visible: 'Above horizon, not tracked',
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

function buildSatMarker(sat) {
  const { x, y } = skyPosition(sat.elevation, sat.azimuth);
  const colour = constellationColor(sat.system);
  const group = svg('g', { class: `sat ${sat.state}` });

  const style = {
    used: { fill: colour, stroke: 'none', label: '#12151a' },
    tracked: { fill: 'rgba(27,32,41,.9)', stroke: colour, label: colour },
    visible: { fill: 'none', stroke: 'rgba(140,148,164,.7)', label: '#8c94a4' },
    missing: { fill: 'none', stroke: '#ffb02e', label: '#ffb02e' },
    unhealthy: { fill: 'none', stroke: '#ff5f56', label: '#ff5f56' },
  }[sat.state];

  group.append(svg('circle', {
    cx: x, cy: y, r: 11,
    fill: style.fill,
    stroke: style.stroke,
    'stroke-width': 2,
    'stroke-dasharray': sat.state === 'visible' ? '3 2' : 'none',
  }));
  group.append(svg('text', { x, y: y + 4, class: 'sat-label', fill: style.label }, sat.prn));
  group.append(svg('title', {}, `${sat.system} ${sat.prn}\n${STATE_TEXT[sat.state]}`
    + `\nElevation ${sat.elevation.toFixed(1)}° · Azimuth ${sat.azimuth.toFixed(1)}°`
    + (sat.carrierToNoise ? `\nC/No ${sat.carrierToNoise.toFixed(1)} dB-Hz` : '')
    + (sat.detail ? `\n${sat.detail}` : '')));
  return group;
}

/** Merges SATVIS2 (sky geometry), RANGE (tracking) and BESTSATS (solution usage). */
function buildSatelliteList() {
  const byKey = new Map();
  const key = (system, prn) => `${system}:${normalisePrn(system, prn)}`;

  for (const [system, record] of Object.entries(state.satvis)) {
    for (const sat of (record.data && record.data.satellites) || []) {
      if (!isValidSkyPosition(sat.elevation, sat.azimuth)) continue;
      byKey.set(key(system, sat.prn), {
        system,
        prn: String(normalisePrn(system, sat.prn)),
        elevation: sat.elevation,
        azimuth: sat.azimuth,
        health: sat.health,
        carrierToNoise: null,
        state: 'visible',
        detail: '',
      });
    }
  }

  const range = latestByName.RANGE;
  for (const obs of (range && range.data && range.data.observations) || []) {
    if (!obs.system || obs.system === 'RESERVED') continue;
    const id = key(obs.system, obs.prn);
    const entry = byKey.get(id) || {
      system: obs.system, prn: String(normalisePrn(obs.system, obs.prn)),
      elevation: null, azimuth: null, health: '0', detail: '',
    };
    entry.carrierToNoise = Math.max(entry.carrierToNoise || 0, obs.carrierToNoise || 0) || null;
    entry.state = 'tracked';
    byKey.set(id, entry);
  }

  const best = latestByName.BESTSATS;
  for (const sat of (best && best.data && best.data.satellites) || []) {
    const id = key(sat.system, sat.prn);
    const entry = byKey.get(id) || {
      system: sat.system, prn: String(normalisePrn(sat.system, sat.prn)),
      elevation: null, azimuth: null, health: '0', carrierToNoise: null,
    };
    entry.state = bestSatState(sat.status);
    entry.detail = sat.status;
    byKey.set(id, entry);
  }

  return [...byKey.values()].sort((a, b) => a.system.localeCompare(b.system) || Number(a.prn) - Number(b.prn));
}

function bestSatState(status) {
  if (status === 'GOOD') return 'used';
  if (status === 'BADHEALTH') return 'unhealthy';
  if (['NA', 'NOEPHEMERIS', 'LOSSOFLOCK'].includes(status)) return 'missing';
  return 'tracked';
}

/** RANGE reports GLONASS as slot + 37; SATVIS2 and BESTSATS use the slot number. */
function normalisePrn(system, prn) {
  const value = Number(prn);
  if (!Number.isFinite(value)) return prn;
  if (system === 'GLONASS' && value > 37) return value - 37;
  return value;
}

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
      : `${system} — ${perSystem[system].used} used / ${perSystem[system].visible}`;

    button.append(dot, label);
    button.addEventListener('click', () => toggleSystem(system));
    li.append(button);
    list.append(li);
  }
}

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

function signalBreakdown(satellites) {
  const used = new Set(satellites
    .filter((sat) => sat.state === 'used' && !state.hiddenSystems.has(sat.system))
    .map((sat) => `${sat.system}:${normalisePrn(sat.system, sat.prn)}`));
  const counts = Object.fromEntries(SIGNAL_BANDS.map((band) => [band, new Set()]));
  const range = latestByName.RANGE;

  for (const obs of (range && range.data && range.data.observations) || []) {
    if (!obs.system || obs.system === 'RESERVED') continue;
    const key = `${obs.system}:${normalisePrn(obs.system, obs.prn)}`;
    if (!used.has(key)) continue;
    const band = signalBand(obs.system, obs.trackingStatus);
    counts[band].add(key);
  }

  return Object.fromEntries(SIGNAL_BANDS.map((band) => [band, counts[band].size]));
}

function renderSignalLegend(counts) {
  const list = $('signal-legend');
  list.replaceChildren();
  if (!Object.values(counts).some(Boolean)) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No used RANGE signals yet.';
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

function signalBand(system, trackingStatus) {
  const value = typeof trackingStatus === 'number' ? trackingStatus : parseInt(trackingStatus, 16);
  if (!Number.isFinite(value)) return 'Other';
  const code = (value >>> 21) & 0x1f;
  const bandsBySystem = {
    GPS: { 0: 'L1', 1: 'L1', 5: 'L2', 9: 'L2', 14: 'L5', 16: 'L1', 17: 'L1' },
    GLONASS: { 0: 'L1', 1: 'L2', 5: 'L2' },
    SBAS: { 0: 'L1', 14: 'L5' },
    GALILEO: { 2: 'L1', 12: 'L5', 17: 'L5', 20: 'L5' },
    BEIDOU: { 0: 'L1', 1: 'L5', 4: 'L1', 5: 'L5', 7: 'L5' },
    QZSS: { 0: 'L1', 1: 'L1', 5: 'L2', 9: 'L2', 14: 'L5', 16: 'L1', 17: 'L1' },
    NAVIC: { 0: 'L5' },
  };
  return (bandsBySystem[system] && bandsBySystem[system][code]) || 'Other';
}

function renderSatelliteTable(satellites) {
  const body = document.querySelector('#sv-table tbody');
  body.replaceChildren();
  const shown = satellites.filter((s) => !state.hiddenSystems.has(s.system));
  if (!shown.length) {
    emptyRow(body, 7, 'No satellite data yet.');
    return;
  }

  const order = { used: 0, tracked: 1, missing: 2, unhealthy: 3, visible: 4 };
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

function renderSatVis(record) {
  if (!record.data || !record.data.system) return;
  state.satvis[record.data.system] = record;
  renderSkyplot();
}

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

function renderVersionSummary(record) {
  const main = record.data?.components?.[0];
  if (main) $('version-line').textContent = `${main.model} · SW ${main.softwareVersion} · S/N ${main.serialNumber}`;
}

function renderItDetect(record) {
  const d = record.data;
  if (!d) return;
  $('it-time').textContent = formatTime(record);
  $('it-total').textContent = state.counts.ITDETECTSTATUS || 0;
  renderBands();
}

// --- interference bands -----------------------------------------------------

const BANDS = [
  { id: 'L1', title: 'L1 / E1 / B1 / G1', range: '1559 – 1610 MHz', note: 'GPS/QZSS L1, Galileo E1, BeiDou B1, GLONASS G1' },
  { id: 'L2', title: 'L2 / G2', range: '1215 – 1260 MHz', note: 'GPS/QZSS L2, GLONASS G2' },
  { id: 'L5', title: 'L5 / E5 / B2', range: '1164 – 1215 MHz', note: 'GPS L5, GAL E5a/E5b, BDS B2a, NavIC L5' },
  { id: 'L6', title: 'L6 / E6 / B3', range: '1260 – 1300 MHz', note: 'GAL E6, QZSS L6, BDS B3' },
  { id: 'SBAS', title: 'SBAS', range: 'L1 / L5 overlay', note: 'WAAS, EGNOS, MSAS, GAGAN' },
  { id: 'SBAND', title: 'S-Band', range: '2483 – 2500 MHz', note: 'NavIC S' },
  { id: 'LBAND', title: 'L-Band', range: '1525 – 1560 MHz', note: 'TerraStar corrections' },
  { id: 'OTHER', title: 'Unclassified', range: '—', note: 'Signal type not recognised' },
];

/** Maps an ITDETECTSTATUS signal type onto a band, falling back to detection frequency. */
function classifyBand(signalType, detections) {
  const s = (signalType || '').toUpperCase();

  if (s.includes('SBAS') || s.includes('WAAS') || s.includes('EGNOS')) return 'SBAS';
  if (s.includes('LBAND') || s.includes('TERRASTAR')) return 'LBAND';
  if (/NAVICS|SBAND|\bS\b/.test(s)) return 'SBAND';
  if (/L6|E6|B3/.test(s)) return 'L6';
  if (/L5|E5|B2/.test(s)) return 'L5';
  if (/L2|G2/.test(s)) return 'L2';
  if (/L1|E1|B1|G1/.test(s)) return 'L1';

  const freq = detections.map((d) => d.centerFrequencyHz).find(Number.isFinite);
  if (freq) {
    const mhz = freq / 1e6;
    if (mhz >= 2483 && mhz <= 2500) return 'SBAND';
    if (mhz >= 1559 && mhz <= 1610) return 'L1';
    if (mhz >= 1525 && mhz < 1559) return 'LBAND';
    if (mhz >= 1260 && mhz <= 1300) return 'L6';
    if (mhz >= 1215 && mhz < 1260) return 'L2';
    if (mhz >= 1164 && mhz < 1215) return 'L5';
  }
  return 'OTHER';
}

function renderBands() {
  const now = Date.now();
  const groups = {};
  const stats = bandStats(now);
  const record = latestByName.ITDETECTSTATUS;
  const detections = (record && record.data && record.data.detections) || [];

  for (const detection of detections) {
    const band = classifyBand(detection.signalType, [detection]);
    const group = groups[band] || (groups[band] = { signals: new Map(), detections: [] });
    group.signals.set(detection.signalType, (group.signals.get(detection.signalType) || 0) + 1);
    group.detections.push(detection);
  }

  const container = $('bands');
  container.replaceChildren();
  let jammedBands = [];
  let totalDetections = 0;

  for (const band of BANDS) {
    const group = groups[band.id];
    const bandDetections = group ? group.detections : [];
    const status = !record ? 'unmonitored' : bandDetections.length ? 'jammed' : 'clear';
    if (status === 'jammed') {
      jammedBands.push(band.id);
      totalDetections += bandDetections.length;
    }
    const card = buildBandCard(band, group, bandDetections, status, stats[band.id]);
    card.dataset.band = band.id;
    container.append(card);
  }

  renderVerdict(jammedBands, totalDetections, Boolean(record));
}

/** Detection rate, peak power and time since the last hit over the selected window. */
function bandStats(now) {
  const cutoff = now - state.windowMinutes * 60000;
  const stats = {};

  for (const sample of state.interferenceHistory) {
    if (sample.t < cutoff) continue;
    const bands = sample.signal === 'ALL'
      ? BANDS.map((band) => band.id)
      : [classifyBand(sample.signal, [])];
    for (const band of bands) {
      const entry = stats[band] || (stats[band] = { samples: 0, hits: 0, peak: null, lastHit: null });
      entry.samples++;
      if (sample.count > 0) {
        entry.hits++;
        entry.lastHit = Math.max(entry.lastHit || 0, sample.t);
        if (Number.isFinite(sample.maxPower)) {
          entry.peak = entry.peak === null ? sample.maxPower : Math.max(entry.peak, sample.maxPower);
        }
      }
    }
  }
  return stats;
}

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

function detectionTypeLabel(type) {
  return DETECTION_TYPE_TEXT[type] || type || 'Unknown detector';
}

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

function renderVerdict(jammedBands, totalDetections, hasData) {
  const banner = $('it-banner');
  const verdict = $('it-verdict');
  const detail = $('it-detail');

  $('it-bands-hit').textContent = jammedBands.length ? jammedBands.join(', ') : 'None';
  $('it-bands-hit').classList.toggle('alert', jammedBands.length > 0);
  $('it-count').textContent = totalDetections;
  $('it-count').classList.toggle('alert', totalDetections > 0);

  if (!hasData) {
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

function ephemerisSystem(name) {
  return EPHEMERIS_SYSTEMS[name] || name;
}

function ephemerisConstellation(name) {
  if (name.startsWith('GAL')) return 'GALILEO';
  return ephemerisSystem(name);
}

function ephemerisSourceLabel(name) {
  const labels = {
    GALINAVEPHEMERIS: 'I/NAV',
    GALFNAVEPHEMERIS: 'F/NAV',
  };
  return labels[name] || ephemerisSystem(name);
}

function ephemerisParameters(data) {
  return Object.fromEntries((data.parameters || []).map((parameter) => [parameter.name, parameter.value]));
}

function ephemerisHealth(name, data) {
  const values = ephemerisParameters(data);
  if (name === 'GLOEPHEMERIS') return values.health >= 0 && values.health <= 3;
  if (name === 'GALINAVEPHEMERIS') {
    return values.e1Health === 0 && values.e5Health === 0;
  }
  if (name === 'GALFNAVEPHEMERIS') return values.e5Health === 0;
  if (name === 'NAVICEPHEMERIS') return values.l5Health === 0 && values.sHealth === 0 && values.alert === 0;
  return values.health === null || values.health === undefined ? null : values.health === 0;
}

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

function buildEphemerisColumnGroup(parameterCount) {
  const group = document.createElement('colgroup');
  group.append(tableColumn('prn-col'));
  for (let index = 0; index < parameterCount; index++) group.append(tableColumn('parameter-col'));
  group.append(tableColumn('health-col'));
  group.append(tableColumn('updated-col'));
  return group;
}

function ephemerisTableWidth(parameterCount) {
  return `${5.5 + (parameterCount * 5.75) + 6.5 + 8}rem`;
}

function tableColumn(className) {
  const column = document.createElement('col');
  column.className = className;
  return column;
}

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

function toggleParameterCell(cellElement) {
  const expanded = cellElement.classList.toggle('expanded');
  cellElement.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

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

function tableHeader(text, title, className) {
  const th = document.createElement('th');
  th.textContent = text;
  if (title) th.title = title;
  if (className) th.className = className;
  return th;
}

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

function shouldShowEphemerisParameter(parameter) {
  return parameter.name !== 'satelliteId' && !parameter.name.startsWith('reserved');
}

function isIonoParameter(name) {
  return /(?:iono|groupDelay|timeOffset|frequencyCorrection)$/i.test(name);
}

function ephemerisHealthLabel(records) {
  const health = ephemerisMergedHealth(records);
  return health === false ? 'Unhealthy' : health === true ? 'Healthy' : 'Unknown';
}

function ephemerisHealthClass(records) {
  const health = ephemerisMergedHealth(records);
  return health === false ? 'bad' : health === true ? 'good' : 'unknown';
}

function ephemerisMergedHealth(records) {
  const values = records.map((record) => ephemerisHealth(record.name, record.data));
  if (values.includes(false)) return false;
  if (values.includes(true)) return true;
  return null;
}

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

function applyRawFilter() {
  for (const item of $('raw-log').children) {
    item.hidden = Boolean(state.filter) && item.dataset.name !== state.filter;
  }
}

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

function cell(row, text, className) {
  const td = row.insertCell();
  td.textContent = text === null || text === undefined ? '—' : String(text);
  if (className) td.className = className;
  return td;
}

function emptyRow(body, span, text) {
  const row = body.insertRow();
  row.className = 'empty';
  const td = row.insertCell();
  td.colSpan = span;
  td.textContent = text;
}

function crcLabel(valid) {
  if (valid === true) return 'OK';
  if (valid === false) return 'FAIL';
  return '—';
}

function fmt(value, digits, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(digits)}${suffix}`;
}

function formatFrequency(hz) {
  if (hz === null || hz === undefined) return '—';
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(4)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz} Hz`;
}

function formatTime(record) {
  const iso = (record.header && record.header.utc) || record.receivedAt;
  return formatTimestamp(iso);
}

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
function dateFormatter(options) {
  const key = JSON.stringify(options);
  if (!dateFormatters.has(key)) {
    const formatter = new Intl.DateTimeFormat('en-GB', options);
    if (dateFormatters.size >= 12) dateFormatters.clear();
    dateFormatters.set(key, formatter);
  }
  return dateFormatters.get(key);
}

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

setInterval(() => flushUpdates(), 250);
setInterval(() => {
  pruneClientHistory();
  timelineDirty = true;
}, 15000);
window.addEventListener('resize', () => { timelineDirty = true; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    source?.close();
    source = null;
    historyRequest++;
    historyController?.abort();
  } else {
    connectStream();
    loadHistory();
  }
});
window.addEventListener('error', (event) => reportClientError('Display error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportClientError('Asynchronous display error', event.reason));
$('retry-display').addEventListener('click', () => {
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
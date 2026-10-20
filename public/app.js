'use strict';

const $ = (id) => document.getElementById(id);
const MAX_RAW_ROWS = 300;
const MAX_IT_ROWS = 50;
const MAX_INTERFERENCE_SAMPLES = 10000;
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

connectionTransport.addEventListener('change', () => {
  updateConnectionFields();
  if (connectionTransport.value === 'serial') refreshSerialPorts();
});

$('disconnect').addEventListener('click', async () => {
  const message = $('connection-message');
  const button = $('disconnect');
  button.disabled = true;
  message.textContent = 'Disconnecting...';
  try {
    const response = await request('/api/disconnect', { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    message.textContent = 'Disconnected; connection closed';
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

connectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('connection-message');
  const button = connectionForm.querySelector('button[type="submit"]');
  const isSerial = connectionTransport.value === 'serial';
  const settings = isSerial
    ? {
      transport: 'serial',
      serialPath: serialPathSelect.value,
      serialBaudRate: Number($('serial-baud-rate').value),
    }
    : {
      transport: 'tcp',
      receiverHost: $('receiver-host').value,
      receiverPort: Number($('receiver-port').value),
    };

  button.disabled = true;
  message.textContent = 'Applying connection settings...';
  try {
    const response = await request('/api/connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error(await response.text());
    message.textContent = 'Connection settings applied';
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function updateConnectionFields() {
  const serial = connectionTransport.value === 'serial';
  $('tcp-fields').hidden = serial;
  $('serial-fields').hidden = !serial;
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
  source.addEventListener('error', () => {
    $('status').className = 'status disconnected';
    $('status-text').textContent = 'Lost connection to local server — retrying...';
  });
}

function applySnapshot(snap) {
  if (snap.status) renderStatus(snap.status);
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
  $('status').className = `status ${status.connected ? 'connected' : 'disconnected'}`;
  const target = status.transport === 'serial'
    ? `${status.serialPath} @ ${status.baudRate}`
    : `${status.host}:${status.port}`;
  $('status-text').textContent = status.connected
    ? `Connected via ${target}`
    : `Disconnected from ${target}${status.lastError ? ` — ${status.lastError}` : ''}`;
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
state.showTraces = readPreference('showTraces', 'true') !== 'false';

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
    const data = await request(`/api/history?minutes=${state.windowMinutes}&limit=${MAX_INTERFERENCE_SAMPLES}`,
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
}

// --- interference timeline --------------------------------------------------

const TIMELINE = { width: 900, height: 500, left: 142, right: 12, top: 28, bottom: 46 };
const TIMELINE_BANDS = ['L1', 'L2', 'L5'];
const TIMELINE_BAND_INFO = {
  L1: { coverage: 'E1 / B1 / G1', range: '1559–1610 MHz' },
  L2: { coverage: 'G2', range: '1215–1260 MHz' },
  L5: { coverage: 'E5 / B2', range: '1164–1215 MHz' },
};

function timelineViewport(now = Date.now()) {
  const historyMs = state.windowMinutes * 60000;
  const windowMs = Math.min(historyMs, Math.max(10000, state.timelineView?.windowMs || historyMs));
  const end = state.timelineView
    ? Math.max(now - historyMs + windowMs, Math.min(now, state.timelineView.end))
    : now;
  return { start: end - windowMs, end, windowMs };
}

// Fraction of the time axis kept to the right of the viewport end so "now" sits inset from the edge.
const TIMELINE_NOW_INSET = 0.1;
const TIMELINE_TICK_STEPS = [
  10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3,
  3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3,
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
  const windowMs = Math.max(10000, Math.min(state.windowMinutes * 60000, view.windowMs * factor));
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

function renderTimeline() {
  const chart = $('timeline');
  chart.replaceChildren();

  const width = Math.min(1920, Math.max(360, Math.round(chart.getBoundingClientRect().width) || TIMELINE.width));
  chart.setAttribute('viewBox', `0 0 ${width} ${TIMELINE.height}`);
  const { start, end, windowMs } = timelineViewport();
  const bandIds = TIMELINE_BANDS;
  const rowHeight = (TIMELINE.height - TIMELINE.top - TIMELINE.bottom) / bandIds.length;
  const plotWidth = width - TIMELINE.left - TIMELINE.right;
  const now = Date.now();
  const axis = timelineAxis(start, windowMs, plotWidth, now);

  const samples = state.interferenceHistory.filter((sample) => sample.t >= start && sample.t <= axis.dataEnd
    && (sample.signal === 'ALL' || bandIds.includes(classifyBand(sample.signal, []))))
    .sort((a, b) => a.t - b.t);
  $('timeline-range').textContent = `(${samples.length} samples, ${(windowMs / 1000).toFixed(0)} s window)`;
  $('timeline-mode').textContent = state.timelineView ? 'Historical view' : 'Live';

  bandIds.forEach((bandId, index) => {
    const y = TIMELINE.top + index * rowHeight;
    chart.append(svg('rect', {
      x: TIMELINE.left, y: y + 1, width: plotWidth, height: rowHeight - 2, class: 'tl-row',
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
      chart.append(svg('text', { x: TIMELINE.left - 8, y: py + 4, class: 'tl-label' }, String(power)));
    }
    chart.append(svg('text', { x: TIMELINE.left - 8, y: y + rowHeight - 10, class: 'tl-label' }, 'Status'));
  });

  for (const [index, band] of bandIds.entries()) {
    const pixels = new Map();
    let segment = 0;
    let lastTime = null;
    for (const sample of samples) {
      if (sample.signal !== 'ALL' && classifyBand(sample.signal, []) !== band) continue;
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
        y: y + rowHeight - 20, width: 3, height: 12,
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

    const plotHits = [];
    for (const sample of historyHits) {
      const detections = Array.isArray(sample.detections) && sample.detections.length
        ? sample.detections
        : Number.isFinite(sample.freq) ? [{ freq: sample.freq, bandwidth: null, power: sample.maxPower }] : [];
      for (const detection of detections) {
        if (!Number.isFinite(detection.freq)) continue;
        const halfBandwidth = Number.isFinite(detection.bandwidth) && detection.bandwidth > 0 ? detection.bandwidth / 2e6 : 0;
        if (detection.freq / 1e6 + halfBandwidth < plot.min || detection.freq / 1e6 - halfBandwidth > plot.max) continue;
        plotHits.push({ sample, detection });
      }
    }
    const visibleHits = plotHits.slice(-400);
    hitSummary.textContent = plotHits.length ? `${plotHits.length} hit${plotHits.length === 1 ? '' : 's'}` : 'No frequency hits';
    if (plotHits.length > visibleHits.length) hitSummary.textContent += ` · showing latest ${visibleHits.length}`;

    for (const { sample, detection } of visibleHits) {
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
        class: 'spectrum-detection',
      });
      const title = svg('title', {}, `${sample.signal}: ${centerMHz.toFixed(3)} MHz`
        + (Number.isFinite(detection.bandwidth) ? `, ${(detection.bandwidth / 1e6).toFixed(3)} MHz bandwidth` : '')
        + (Number.isFinite(detection.power) ? `, ${detection.power.toFixed(1)} dBm` : '')
        + `, ${formatTimestamp(sample.t, true)}`);
      marker.append(title);
      svgChart.append(marker);
    }

    for (let tick = 0; tick <= 4; tick++) {
      const frequency = plot.min + ((plot.max - plot.min) * tick) / 4;
      svgChart.append(svg('text', {
        x: left - 8, y: yFor(frequency) + 4, class: 'spectrum-label',
      }, frequency.toFixed(1)));
    }
    appendTimeAxis(svgChart, axis, {
      left, top, bottom: top + plotHeight,
      labelY: height - 19,
      nowLabelY: 12,
      gridClass: 'spectrum-grid',
      labelClass: 'spectrum-axis',
    }, now);
    svgChart.append(svg('text', { x: left - 8, y: 11, class: 'spectrum-label' }, 'MHz'));
  }
}

function utcLabel(timestamp, windowMs = timelineViewport().windowMs) {
  return timelineTimeLabel(timestamp, windowMs);
}

function timelineTimeLabel(timestamp, windowMs) {
  return dateFormatter({
    timeZone: state.timeZone, hour: '2-digit', minute: '2-digit',
    ...(windowMs < 3600000 ? { second: '2-digit' } : {}),
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

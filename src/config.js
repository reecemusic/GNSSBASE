'use strict';

/**
 * Environment configuration for the GNSSBASE receiver bridge and local web UI.
 * Each setting below names its environment variable and default. Integer
 * settings are checked when this module is loaded. NOVATEL_TRANSPORT must be
 * auto, tcp, or serial. ARCHIVE_DAYS must not exceed ARCHIVE_MAX_DAYS.
 * Saved connection JSON can be loaded and written through the two functions
 * attached to the exported object. This module emits no events.
 */

const fs = require('node:fs');
const path = require('node:path');
const { replaceFileSync } = require('./history');

/**
 * Reads an integer environment variable.
 * An unset or empty value returns `fallback`. A present value must be a safe
 * integer inside the inclusive bounds.
 * @param {string} name Environment variable name.
 * @param {number} fallback Value used when the variable is unset or empty.
 * @param {number} minimum Inclusive lower bound.
 * @param {number} [maximum=Number.MAX_SAFE_INTEGER] Inclusive upper bound.
 * @returns {number} The parsed integer, or `fallback`.
 * Side effects: throws Error when the variable is set and is not a safe integer in range. Does not log.
 * Events: none.
 */
function integerSetting(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

// 31 days, expressed in minutes. historyRetentionMinutes clamps to this.
const HISTORY_RETENTION_CEILING = 31 * 24 * 60;

/**
 * Reads HISTORY_RETENTION_MIN.
 * Unset or empty returns 1440 minutes. A safe integer of at least 1 is returned
 * until it passes HISTORY_RETENTION_CEILING (31 days). A larger value is clamped
 * to that ceiling.
 * @returns {number} Retention in minutes.
 * Side effects: throws Error when the variable is set and is not a safe integer
 *   of at least 1. console.warn when a value is clamped. Does not mutate the environment.
 * Events: none.
 */
function historyRetentionMinutes() {
  const name = 'HISTORY_RETENTION_MIN';
  const raw = process.env[name];
  if (raw === undefined || raw === '') return 1440;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer of at least 1`);
  }
  if (value > HISTORY_RETENTION_CEILING) {
    console.warn(`[config] ${name} ${value} exceeds ${HISTORY_RETENTION_CEILING} minutes (31 days); clamping`);
    return HISTORY_RETENTION_CEILING;
  }
  return value;
}

/**
 * Checks a connection object and returns a normalized copy.
 * Transport must be auto, tcp, or serial. The host and serial path are trimmed
 * and must be non-empty. The port must be an integer from 1 to 65535. The baud
 * rate must be an integer of at least 1.
 * @param {object} saved Candidate settings. Arrays and non-objects are rejected.
 * @returns {{ transport: string, receiverHost: string, receiverPort: number, serialPath: string, serialBaudRate: number }}
 * Side effects: throws Error when a check fails. Does not log. Does not mutate `saved`.
 * Events: none.
 */
function validateConnectionSettings(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('connection settings must be an object');
  const transportMode = saved.transport;
  if (!['auto', 'tcp', 'serial'].includes(transportMode)) throw new Error('transport must be auto, tcp or serial');
  const receiverHost = String(saved.receiverHost || '').trim();
  const receiverPort = Number(saved.receiverPort);
  const serialPath = String(saved.serialPath || '').trim();
  const serialBaudRate = Number(saved.serialBaudRate);
  if (!receiverHost) throw new Error('receiver host is required');
  if (!Number.isInteger(receiverPort) || receiverPort < 1 || receiverPort > 65535) {
    throw new Error('receiver port must be an integer from 1 to 65535');
  }
  if (!serialPath) throw new Error('serial path is required');
  if (!Number.isInteger(serialBaudRate) || serialBaudRate < 1) throw new Error('serial baud rate must be an integer of at least 1');
  return { transport: transportMode, receiverHost, receiverPort, serialPath, serialBaudRate };
}

/**
 * Formats a validated connection for a log line.
 * @param {{ transport: string, serialPath: string, serialBaudRate: number, receiverHost: string, receiverPort: number }} saved
 * @returns {string} `serial PATH @ BAUD`, `tcp HOST:PORT`, or, for auto, `auto PATH @ BAUD, HOST:PORT`.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function describeConnection(saved) {
  const serial = `${saved.serialPath} @ ${saved.serialBaudRate}`;
  const tcp = `${saved.receiverHost}:${saved.receiverPort}`;
  if (saved.transport === 'serial') return `serial ${serial}`;
  if (saved.transport === 'tcp') return `tcp ${tcp}`;
  return `auto ${serial}, ${tcp}`;
}

/**
 * Reads one connection JSON file and validates it.
 * @param {string} file Path of the primary file or of its `.bak`.
 * @returns {object|null} The validated settings, or null. A missing file (ENOENT)
 *   returns null with no warning. Invalid JSON, a failed validation, or any other
 *   read error returns null after console.warn.
 * Side effects: reads the file. console.warn for every error other than ENOENT. Does not throw.
 * Events: none.
 */
function readConnectionFile(file) {
  try {
    return validateConnectionSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.warn(`[config] ignoring connection settings ${file}: ${error.message}`);
    return null;
  }
}

/**
 * Loads saved connection settings.
 * Uses the primary file when it exists and validates. Falls back to `file.bak`
 * only when the primary is missing or invalid (readConnectionFile returned null).
 * A falsy `file` returns null without reading either path.
 * @param {string} file Primary JSON path.
 * @returns {object|null} Validated settings from the primary, else from the `.bak`, else null.
 * Side effects: reads the filesystem. console.log when a file is accepted.
 *   Invalid files are warned about inside readConnectionFile. Does not throw.
 * Events: none.
 */
function loadConnectionOverrides(file) {
  if (!file) return null;
  const saved = readConnectionFile(file);
  if (saved) {
    console.log(`[config] using saved connection settings from ${file} (${describeConnection(saved)})`);
    return saved;
  }
  const backup = readConnectionFile(`${file}.bak`);
  if (!backup) return null;
  console.log(`[config] using saved connection settings from ${file}.bak (${describeConnection(backup)})`);
  return backup;
}

/**
 * Validates connection settings and writes them.
 * A falsy `file` returns without writing. Otherwise the parent directory is
 * created, the validated object is written to `file.<pid>.<timestamp>.tmp`,
 * and replaceFileSync moves that temp into place. When the destination already
 * exists, replaceFileSync moves it aside to `file.bak` and then renames the temp.
 * @param {string} file Destination path.
 * @param {object} settings Candidate settings passed to validateConnectionSettings.
 * @returns {void}
 * Side effects: creates directories and writes files. Throws when validation or a filesystem call throws. Does not log.
 * Events: none.
 */
function saveConnectionSettings(file, settings) {
  if (!file) return;
  const validated = validateConnectionSettings(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(validated));
  replaceFileSync(file, temporary);
}

// NOVATEL_TRANSPORT defaults to auto. Any other value must be tcp or serial, or loading this module throws.
const transport = process.env.NOVATEL_TRANSPORT || 'auto';
if (!['auto', 'tcp', 'serial'].includes(transport)) {
  throw new Error('NOVATEL_TRANSPORT must be auto, tcp or serial');
}

const config = {
  // 'auto' tries USB serial first and falls back to TCP when serial does not connect.
  // NOVATEL_TRANSPORT default: auto.
  transport,

  // PwrPak ICOM port (raw TCP pass-through to the receiver's command interpreter).
  // NOVATEL_HOST defaults to 20.20.20.50. NOVATEL_PORT defaults to 3001.
  receiverHost: process.env.NOVATEL_HOST || '20.20.20.50',
  receiverPort: integerSetting('NOVATEL_PORT', 3001, 1, 65535),
  // NOVATEL_SERIAL_PATH defaults to COM11. NOVATEL_SERIAL_BAUD defaults to 9600.
  serialPath: process.env.NOVATEL_SERIAL_PATH || 'COM11',
  serialBaudRate: integerSetting('NOVATEL_SERIAL_BAUD', 9600, 1),
  // In auto mode, an open serial port without a decodable log within this time falls back to TCP.
  // NOVATEL_SERIAL_PROBE_MS defaults to 5000.
  serialProbeMs: integerSetting('NOVATEL_SERIAL_PROBE_MS', 5000, 1),

  // logCommands is sent only when this is on. It is off unless NOVATEL_SEND_LOG_CMD
  // is the string 'true'. The GNSSBASE profile already pushes these logs to ICOM1,
  // and UNLOGALL THISPORT (the first logCommands entry) would remove them.
  sendLogCommands: process.env.NOVATEL_SEND_LOG_CMD === 'true',
  // Ephemeris log command list: one LOG <name>A ONALL entry per constellation.
  ephemerisLogCommands: [
    'LOG GPSEPHEMA ONALL',
    'LOG GLOEPHEMERISA ONALL',
    'LOG GALINAVEPHEMERISA ONALL',
    'LOG GALFNAVEPHEMERISA ONALL',
    'LOG BDSEPHEMERISA ONALL',
    'LOG QZSSEPHEMERISA ONALL',
    'LOG NAVICEPHEMERISA ONALL',
  ],
  // Log command list sent only when sendLogCommands is on. It starts with UNLOGALL THISPORT.
  logCommands: [
    'UNLOGALL THISPORT',
    'LOG VERSIONA ONCE',
    'LOG RXSTATUSA ONCHANGED',
    'LOG BESTPOSA ONTIME 1',
    'LOG BESTGNSSPOSA ONTIME 1',
    'LOG RANGEA ONTIME 5',
    'LOG SATVIS2A ONTIME 10',
    'LOG BESTSATSA ONTIME 1',
    'LOG ITDETECTSTATUSA ONCHANGED',
  ],

  // NOVATEL_RECONNECT_MS defaults to 3000.
  reconnectDelayMs: integerSetting('NOVATEL_RECONNECT_MS', 3000, 1),
  // No data at all for this long => assume a dead socket and recycle it.
  // NOVATEL_IDLE_MS defaults to 30000.
  idleTimeoutMs: integerSetting('NOVATEL_IDLE_MS', 30000, 1),

  // Local web UI. WEB_HOST defaults to 127.0.0.1. WEB_PORT defaults to 8080
  // and accepts an integer from 0 to 65535.
  webHost: process.env.WEB_HOST || '127.0.0.1',
  webPort: integerSetting('WEB_PORT', 8080, 0, 65535),

  // How many recent ITDETECTSTATUS messages to replay to a newly opened browser.
  // HISTORY_SIZE defaults to 50.
  historySize: integerSetting('HISTORY_SIZE', 50, 1),

  // Rolling raw-log window shared with the browser.
  // RAW_LOG_SIZE defaults to 200.
  rawLogSize: integerSetting('RAW_LOG_SIZE', 200, 1),

  // Long-term history for skyplot traces and the interference timeline.
  // This is the longest window a browser can ask for. 24 h so the newest hours, which reach the NAS
  // archive only hours later, are always covered by live data.
  // HISTORY_RETENTION_MIN defaults to 1440 minutes and is clamped at 31 days.
  historyRetentionMinutes: historyRetentionMinutes(),
  // TRACK_SAMPLE_SEC defaults to 20.
  trackSampleSeconds: integerSetting('TRACK_SAMPLE_SEC', 20, 1),
  // MAX_IT_SAMPLES defaults to 100000.
  maxInterferenceSamples: integerSetting('MAX_IT_SAMPLES', 100000, 1),
  // HISTORY_FILE defaults to data/history.json. Set HISTORY_FILE='' to keep history in memory only.
  historyFile: process.env.HISTORY_FILE === undefined
    ? path.join(__dirname, '..', 'data', 'history.json')
    : process.env.HISTORY_FILE || null,
  // HISTORY_SAVE_SEC defaults to 60.
  historySaveSeconds: integerSetting('HISTORY_SAVE_SEC', 60, 1),

  // Historic interference, BESTPOS and BESTSATS archive: root\YYYY\DDD\*.LOG, loaded on demand.
  // NOVATEL_ARCHIVE_ROOT defaults to \\20.20.20.1\novatel\pwrpak1.
  archiveRoot: process.env.NOVATEL_ARCHIVE_ROOT || '\\\\20.20.20.1\\novatel\\pwrpak1',
  // ARCHIVE_DAYS defaults to 1.
  archiveDefaultDays: integerSetting('ARCHIVE_DAYS', 1, 1, 366),
  // ARCHIVE_MAX_DAYS defaults to 31.
  archiveMaxDays: integerSetting('ARCHIVE_MAX_DAYS', 31, 1, 366),
  // Separate bounds for detections, BESTPOS and BESTSATS intervals; coarsened beyond this.
  // ARCHIVE_MAX_SAMPLES defaults to 300000.
  archiveMaxSamples: integerSetting('ARCHIVE_MAX_SAMPLES', 300000, 1000),
  // Default for "Keep loaded": reload the selected window (default the last 24 h) in the background
  // at startup and every ARCHIVE_REFRESH_MIN minutes. The choice made in the web UI is saved and wins.
  // ARCHIVE_AUTO is on unless the value is the string 'false'.
  archiveAuto: process.env.ARCHIVE_AUTO !== 'false',
  // ARCHIVE_REFRESH_MIN defaults to 15.
  archiveRefreshMinutes: integerSetting('ARCHIVE_REFRESH_MIN', 15, 1, 1440),
  // NAS calls that take longer than this are abandoned, so an unreachable share cannot wedge loading.
  // ARCHIVE_TIMEOUT_SEC defaults to 20.
  archiveTimeoutSeconds: integerSetting('ARCHIVE_TIMEOUT_SEC', 20, 1, 600),
  // Per-file summaries so each NAS file is only read once. Set ARCHIVE_CACHE_DIR='' to disable.
  // ARCHIVE_CACHE_DIR defaults to data/archive-cache.
  archiveCacheDir: process.env.ARCHIVE_CACHE_DIR === undefined
    ? path.join(__dirname, '..', 'data', 'archive-cache')
    : process.env.ARCHIVE_CACHE_DIR || null,
  // ARCHIVE_SETTINGS_FILE defaults to data/archive-settings.json. An empty string disables the file.
  archiveSettingsFile: process.env.ARCHIVE_SETTINGS_FILE === undefined
    ? path.join(__dirname, '..', 'data', 'archive-settings.json')
    : process.env.ARCHIVE_SETTINGS_FILE || null,
  // Set CONNECTION_SETTINGS_FILE='' to ignore the saved Apply & reconnect choice.
  // CONNECTION_SETTINGS_FILE defaults to data/connection-settings.json.
  connectionSettingsFile: process.env.CONNECTION_SETTINGS_FILE === undefined
    ? path.join(__dirname, '..', 'data', 'connection-settings.json')
    : process.env.CONNECTION_SETTINGS_FILE || null,
};

config.loadConnectionOverrides = loadConnectionOverrides;
config.saveConnectionSettings = saveConnectionSettings;

// Loading fails when the default archive window is longer than the maximum.
if (config.archiveDefaultDays > config.archiveMaxDays) {
  throw new Error('ARCHIVE_DAYS must not exceed ARCHIVE_MAX_DAYS');
}

module.exports = config;

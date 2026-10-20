'use strict';

function integerSetting(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

const transport = process.env.NOVATEL_TRANSPORT || 'tcp';
if (!['tcp', 'serial'].includes(transport)) {
  throw new Error('NOVATEL_TRANSPORT must be tcp or serial');
}

const config = {
  transport,

  // PwrPak ICOM port (raw TCP pass-through to the receiver's command interpreter).
  receiverHost: process.env.NOVATEL_HOST || '20.20.20.50',
  receiverPort: integerSetting('NOVATEL_PORT', 3001, 1, 65535),
  serialPath: process.env.NOVATEL_SERIAL_PATH || 'COM11',
  serialBaudRate: integerSetting('NOVATEL_SERIAL_BAUD', 115200, 1),

  // Commands sent after every (re)connect so the receiver starts emitting the logs.
  // Off by default: the GNSSBASE profile already pushes these logs to ICOM1, and
  // `UNLOGALL THISPORT` would remove them. Set NOVATEL_SEND_LOG_CMD=true to drive a
  // port that is not configured by the profile.
  sendLogCommands: process.env.NOVATEL_SEND_LOG_CMD === 'true',
  ephemerisLogCommands: [
    'LOG GPSEPHEMA ONALL',
    'LOG GLOEPHEMERISA ONALL',
    'LOG GALINAVEPHEMERISA ONALL',
    'LOG GALFNAVEPHEMERISA ONALL',
    'LOG BDSEPHEMERISA ONALL',
    'LOG QZSSEPHEMERISA ONALL',
    'LOG NAVICEPHEMERISA ONALL',
  ],
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

  reconnectDelayMs: integerSetting('NOVATEL_RECONNECT_MS', 3000, 1),
  // No data at all for this long => assume a dead socket and recycle it.
  idleTimeoutMs: integerSetting('NOVATEL_IDLE_MS', 30000, 1),

  // Local web UI.
  webHost: process.env.WEB_HOST || '127.0.0.1',
  webPort: integerSetting('WEB_PORT', 8080, 0, 65535),

  // How many recent ITDETECTSTATUS messages to replay to a newly opened browser.
  historySize: integerSetting('HISTORY_SIZE', 50, 1),

  // Rolling raw-log window shared with the browser.
  rawLogSize: integerSetting('RAW_LOG_SIZE', 200, 1),

  // Long-term history for skyplot traces and the interference timeline.
  // This is the longest window a browser can ask for.
  historyRetentionMinutes: integerSetting('HISTORY_RETENTION_MIN', 360, 1),
  trackSampleSeconds: integerSetting('TRACK_SAMPLE_SEC', 20, 1),
  maxInterferenceSamples: integerSetting('MAX_IT_SAMPLES', 50000, 1),
  // Set HISTORY_FILE='' to keep history in memory only.
  historyFile: process.env.HISTORY_FILE === undefined
    ? require('node:path').join(__dirname, '..', 'data', 'history.json')
    : process.env.HISTORY_FILE || null,
  historySaveSeconds: integerSetting('HISTORY_SAVE_SEC', 60, 1),
};

module.exports = config;

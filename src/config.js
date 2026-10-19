'use strict';

const config = {
  // PwrPak ICOM port (raw TCP pass-through to the receiver's command interpreter).
  receiverHost: process.env.NOVATEL_HOST || '20.20.20.50',
  receiverPort: Number(process.env.NOVATEL_PORT || 3001),

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

  reconnectDelayMs: Number(process.env.NOVATEL_RECONNECT_MS || 3000),
  // No data at all for this long => assume a dead socket and recycle it.
  idleTimeoutMs: Number(process.env.NOVATEL_IDLE_MS || 30000),

  // Local web UI.
  webHost: process.env.WEB_HOST || '127.0.0.1',
  webPort: Number(process.env.WEB_PORT || 8080),

  // How many recent ITDETECTSTATUS messages to replay to a newly opened browser.
  historySize: Number(process.env.HISTORY_SIZE || 50),

  // Rolling raw-log window shared with the browser.
  rawLogSize: Number(process.env.RAW_LOG_SIZE || 200),

  // Long-term history for skyplot traces and the interference timeline.
  // This is the longest window a browser can ask for.
  historyRetentionMinutes: Number(process.env.HISTORY_RETENTION_MIN || 360),
  trackSampleSeconds: Number(process.env.TRACK_SAMPLE_SEC || 20),
  maxInterferenceSamples: Number(process.env.MAX_IT_SAMPLES || 50000),
  // Set HISTORY_FILE='' to keep history in memory only.
  historyFile: process.env.HISTORY_FILE === undefined
    ? require('node:path').join(__dirname, '..', 'data', 'history.json')
    : process.env.HISTORY_FILE || null,
  historySaveSeconds: Number(process.env.HISTORY_SAVE_SEC || 60),
};

module.exports = config;

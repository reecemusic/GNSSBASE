'use strict';

const CRC32_POLYNOMIAL = 0xedb88320;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ CRC32_POLYNOMIAL : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/** NovAtel 32-bit CRC over the ASCII sentence body (everything between '#'/'%' and '*'). */
function novatelCrc32(str) {
  let crc = 0;
  for (let i = 0; i < str.length; i++) {
    crc = (crcTable[(crc ^ str.charCodeAt(i)) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

/** Same CRC over raw bytes, used for binary (0xAA 0x44 0x12) logs. */
function novatelCrc32Buffer(buf, start, end) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = (crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

const TIME_STATUS_NAMES = new Set([
  'UNKNOWN', 'APPROXIMATE', 'COARSEADJUSTING', 'COARSE', 'COARSESTEERING',
  'FREEWHEELING', 'FINEADJUSTING', 'FINE', 'FINEBACKUPSTEERING', 'FINESTEERING',
  'SATTIME',
]);

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const LEAP_SECONDS = 18;

function gpsToUtc(week, seconds) {
  if (!Number.isFinite(week) || !Number.isFinite(seconds)) return null;
  const ms = GPS_EPOCH_MS + week * 604800000 + (seconds - LEAP_SECONDS) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8640000000000000) return null;
  return new Date(ms).toISOString();
}

/**
 * Parses one NovAtel ASCII sentence (long or short header form).
 * Returns null for anything that is not a recognisable ASCII log
 * (command prompts, `<OK` responses, binary garbage, etc.).
 */
function parseAsciiLog(line) {
  const raw = line.trim();
  if (raw.length < 4) return null;

  const sync = raw[0];
  if (sync !== '#' && sync !== '%') return null;

  const bodyStart = 1;
  const starIndex = raw.lastIndexOf('*');
  const hasCrc = starIndex > bodyStart;
  const body = raw.slice(bodyStart, hasCrc ? starIndex : undefined);

  let crcValid = null;
  if (hasCrc) {
    const expected = parseInt(raw.slice(starIndex + 1).trim(), 16);
    crcValid = Number.isNaN(expected) ? null : novatelCrc32(body) === expected >>> 0;
  }

  const semicolon = body.indexOf(';');
  if (semicolon === -1) return null;

  const headerFields = body.slice(0, semicolon).split(',');
  const dataFields = splitFields(body.slice(semicolon + 1));

  const messageName = (headerFields[0] || '').replace(/[AB]$/, '');
  let header;

  if (sync === '%' || !TIME_STATUS_NAMES.has(headerFields[4])) {
    // Short header: %NAMEA,week,seconds;
    const week = Number(headerFields[1]);
    const seconds = Number(headerFields[2]);
    header = { messageName, week, seconds, utc: gpsToUtc(week, seconds) };
  } else {
    const week = Number(headerFields[5]);
    const seconds = Number(headerFields[6]);
    header = {
      messageName,
      port: headerFields[1],
      sequence: Number(headerFields[2]),
      idleTime: Number(headerFields[3]),
      timeStatus: headerFields[4],
      week,
      seconds,
      utc: gpsToUtc(week, seconds),
      receiverStatus: headerFields[7],
    };
  }

  return { format: 'ascii', raw, header, fields: dataFields, crcValid };
}

/** Splits a data body on commas, keeping quoted strings and {}/[] groups intact. */
function splitFields(text) {
  const out = [];
  let current = '';
  let inQuotes = false;
  let depth = 0;

  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === '[' || ch === '{')) depth++;
    if (!inQuotes && (ch === ']' || ch === '}')) depth = Math.max(0, depth - 1);
    if (ch === ',' && !inQuotes && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter((f, i, arr) => !(f === '' && i === arr.length - 1));
}

/**
 * Interprets an ITDETECTSTATUS body.
 *
 * Supports a detection count followed by detection blocks, and a signal name followed
 * by a count and detection blocks. The block size is derived so unknown firmware
 * extensions remain available in the raw fields.
 */
function interpretItDetectStatus(message) {
  const fields = message.fields || [];

  if (fields.length > 1 && Number.isFinite(Number(fields[1]))) {
    const signalType = fields[0];
    const count = Number(fields[1]);
    const rest = fields.slice(2);
    const blockSize = count > 0 ? Math.floor(rest.length / count) : 0;
    const detections = [];

    for (let index = 0; index < count && blockSize > 0; index++) {
      detections.push(describeSignalDetection(signalType, rest.slice(index * blockSize, (index + 1) * blockSize)));
    }

    return {
      detectionCount: count,
      detections,
      extraFields: rest.slice(count * blockSize),
    };
  }

  const count = Number(fields[0]);
  const rest = fields.slice(1);

  const detections = [];
  if (Number.isFinite(count) && count > 0 && rest.length >= count) {
    const blockSize = Math.floor(rest.length / count);
    for (let index = 0; index < count; index++) {
      detections.push(describeDetection(rest.slice(index * blockSize, (index + 1) * blockSize)));
    }
  }

  return {
    detectionCount: Number.isFinite(count) ? count : detections.length,
    detections,
    extraFields: rest.length === 0 ? [] : rest,
  };
}

function describeSignalDetection(signalType, block) {
  const centerFrequency = Number(block[1]);
  const bandwidth = Number(block[2]);
  const spectrum = block[0] === 'SPECTRUMANALYSIS';
  const toHz = (value) => Number.isFinite(value) ? value * (Math.abs(value) < 100000 ? 1e6 : 1) : null;

  return {
    fields: [signalType, ...block],
    signalType,
    type: block[0] || '',
    centerFrequencyHz: toHz(centerFrequency),
    bandwidthHz: toHz(bandwidth),
    powerDbm: Number.isFinite(Number(block[3])) ? Number(block[3]) : null,
    noiseFloorDbm: spectrum && Number.isFinite(Number(block[4])) ? Number(block[4]) : null,
    metrics: [],
    affectedSignals: block.slice(spectrum ? 5 : 4),
  };
}

function describeDetection(block) {
  const spectrum = block[1] === 'SPECTRUMANALYSIS';
  return {
    fields: block,
    signalType: block[0] || '',
    type: block[1] || '',
    centerFrequencyHz: spectrum && Number.isFinite(Number(block[2])) ? Number(block[2]) * 1e6 : null,
    bandwidthHz: spectrum && Number.isFinite(Number(block[3])) ? Number(block[3]) * 1e6 : null,
    powerDbm: spectrum && Number.isFinite(Number(block[4])) ? Number(block[4]) : null,
    noiseFloorDbm: spectrum && Number.isFinite(Number(block[5])) ? Number(block[5]) : null,
    metrics: spectrum ? [] : block.slice(2, 6).map(Number),
    affectedSignals: block.slice(6),
  };
}

const SYNC_LONG = Buffer.from([0xaa, 0x44, 0x12]);
const SYNC_SHORT = Buffer.from([0xaa, 0x44, 0x13]);
const LONG_HEADER_LENGTH = 28;
const SHORT_HEADER_LENGTH = 12;

const TIME_STATUS_BY_CODE = {
  20: 'UNKNOWN', 60: 'APPROXIMATE', 80: 'COARSEADJUSTING', 100: 'COARSE',
  120: 'COARSESTEERING', 130: 'FREEWHEELING', 140: 'FINEADJUSTING', 160: 'FINE',
  170: 'FINEBACKUPSTEERING', 180: 'FINESTEERING', 200: 'SATTIME',
};

// OEM7 message IDs for the logs this tool cares about.
const MESSAGE_NAMES_BY_ID = {
  7: 'GPSEPHEM',
  37: 'VERSION',
  42: 'BESTPOS',
  43: 'RANGE',
  93: 'RXSTATUS',
  128: 'RXCONFIG',
  723: 'GLOEPHEMERIS',
  1309: 'GALINAVEPHEMERIS',
  1310: 'GALFNAVEPHEMERIS',
  1336: 'QZSSEPHEMERIS',
  1429: 'BESTGNSSPOS',
  1532: 'ITDETECTSTATUS',
  1696: 'BDSEPHEMERIS',
  2123: 'NAVICEPHEMERIS',
};

/**
 * Reads one binary log starting at offset 0 of `buf`.
 * Returns { message, consumed } when a whole log is present, { need } when more
 * bytes are required, or null when the buffer does not start with a sync pattern.
 */
function readBinaryLog(buf) {
  const isLong = buf.length >= 3 && buf.compare(SYNC_LONG, 0, 3, 0, 3) === 0;
  const isShort = buf.length >= 3 && buf.compare(SYNC_SHORT, 0, 3, 0, 3) === 0;
  if (!isLong && !isShort) return null;

  const headerLength = isLong ? (buf.length > 3 ? buf[3] : LONG_HEADER_LENGTH) : SHORT_HEADER_LENGTH;
  const minimum = isLong ? LONG_HEADER_LENGTH : SHORT_HEADER_LENGTH;
  if (buf.length < minimum) return { need: minimum };

  const messageLength = isLong ? buf.readUInt16LE(8) : buf[3];
  const total = headerLength + messageLength + 4;
  if (total > 1 << 16) return null; // implausible framing, treat as noise
  if (buf.length < total) return { need: total };

  const expectedCrc = buf.readUInt32LE(total - 4);
  const crcValid = novatelCrc32Buffer(buf, 0, total - 4) === expectedCrc;

  const messageId = isLong ? buf.readUInt16LE(4) : buf.readUInt16LE(4);
  const week = isLong ? buf.readUInt16LE(14) : buf.readUInt16LE(6);
  const seconds = (isLong ? buf.readUInt32LE(16) : buf.readUInt32LE(8)) / 1000;

  const header = {
    messageName: MESSAGE_NAMES_BY_ID[messageId] || `UNKNOWN_${messageId}`,
    messageId,
    week,
    seconds,
    utc: gpsToUtc(week, seconds),
  };

  if (isLong) {
    header.port = String(buf[7]);
    header.sequence = buf.readUInt16LE(10);
    header.idleTime = buf[12] / 2;
    header.timeStatus = TIME_STATUS_BY_CODE[buf[13]] || String(buf[13]);
    header.receiverStatus = buf.readUInt32LE(20).toString(16).padStart(8, '0');
  }

  return {
    consumed: total,
    message: {
      format: 'binary',
      header,
      crcValid,
      body: buf.subarray(headerLength, total - 4),
      byteLength: total,
    },
  };
}

function findSyncIndex(buf, from = 0) {
  const long = buf.indexOf(SYNC_LONG, from);
  const short = buf.indexOf(SYNC_SHORT, from);
  if (long === -1) return short;
  if (short === -1) return long;
  return Math.min(long, short);
}

module.exports = {
  novatelCrc32,
  novatelCrc32Buffer,
  parseAsciiLog,
  interpretItDetectStatus,
  splitFields,
  readBinaryLog,
  findSyncIndex,
  gpsToUtc,
  MESSAGE_NAMES_BY_ID,
};

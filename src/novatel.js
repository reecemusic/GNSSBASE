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
// GPS-UTC offset. 18 seconds since 2017-01-01. Update when the IERS announces a
// leap second; until then, archive GPS timestamps shift by 1 s against live reception time.
const LEAP_SECONDS = 18;

function gpsToMs(week, seconds) {
  if (!Number.isFinite(week) || !Number.isFinite(seconds)) return null;
  const ms = GPS_EPOCH_MS + week * 604800000 + (seconds - LEAP_SECONDS) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? ms : null;
}

function gpsToUtc(week, seconds) {
  const ms = gpsToMs(week, seconds);
  return ms === null ? null : new Date(ms).toISOString();
}

// Week 0 is 1980. Live charts end at the computer's clock, so a GPS header is used only
// when it is after 2020, no more than a couple of seconds ahead, and no more than five
// minutes behind. A header further ahead would be stored and then clipped off the chart.
const SANE_GPS_EARLIEST_MS = Date.UTC(2020, 0, 1);
const SANE_GPS_SKEW_MS = 5 * 60 * 1000;
const SANE_GPS_AHEAD_MS = 2 * 1000;

function saneTimestamp(headerUtc, receivedAt, now = Date.now()) {
  const headerMs = typeof headerUtc === 'number' ? headerUtc : Date.parse(headerUtc);
  const usable = Number.isFinite(headerMs) && headerMs >= SANE_GPS_EARLIEST_MS
    && headerMs >= now - SANE_GPS_SKEW_MS && headerMs <= now + SANE_GPS_AHEAD_MS;
  if (usable) return headerMs;
  const receivedMs = typeof receivedAt === 'number' ? receivedAt : Date.parse(receivedAt);
  return Number.isFinite(receivedMs) ? receivedMs : now;
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
    const checksum = raw.slice(starIndex + 1).trim();
    crcValid = /^[0-9a-fA-F]{8}$/.test(checksum) && novatelCrc32(body) === (parseInt(checksum, 16) >>> 0);
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
  const signalFirst = /^[A-Z][A-Z0-9_]*$/i.test(fields[0] || '');
  const countField = fields[signalFirst ? 1 : 0];
  const declaredCount = Number(countField);
  const dataLength = fields.length - (signalFirst ? 2 : 1);
  if (!/^\d+$/.test(countField || '') || !Number.isInteger(declaredCount) || declaredCount > 256
    || (declaredCount === 0 ? dataLength !== 0
      : dataLength < declaredCount * (signalFirst ? 1 : 2) || dataLength % declaredCount !== 0)) {
    throw new Error('ITDETECTSTATUS has an invalid detection count or incomplete detection data');
  }

  if (signalFirst) {
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

/**
 * Converts a receiver frequency field to Hz.
 * Center: values in [1100, 2700] are MHz (L1/L2/L5 and S-band near 2492); values at or above 1e6 are already Hz.
 * Bandwidth: values below 1000 are MHz; values at or above 1000 are already Hz (kHz-scale and multi-MHz widths).
 * Anything else is rejected rather than scaled blindly.
 */
function scaleFrequencyHz(value, role) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (role === 'bandwidth') return abs < 1000 ? value * 1e6 : value;
  if (abs >= 1100 && abs <= 2700) return value * 1e6;
  if (abs >= 1e6) return value;
  return null;
}

function describeSignalDetection(signalType, block) {
  const centerFrequency = Number(block[1]);
  const bandwidth = Number(block[2]);
  const spectrum = block[0] === 'SPECTRUMANALYSIS';

  return {
    fields: [signalType, ...block],
    signalType,
    type: block[0] || '',
    centerFrequencyHz: scaleFrequencyHz(centerFrequency, 'center'),
    bandwidthHz: scaleFrequencyHz(bandwidth, 'bandwidth'),
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
    centerFrequencyHz: spectrum ? scaleFrequencyHz(Number(block[2]), 'center') : null,
    bandwidthHz: spectrum ? scaleFrequencyHz(Number(block[3]), 'bandwidth') : null,
    powerDbm: spectrum && Number.isFinite(Number(block[4])) ? Number(block[4]) : null,
    noiseFloorDbm: spectrum && Number.isFinite(Number(block[5])) ? Number(block[5]) : null,
    metrics: spectrum ? [] : block.slice(2, 6).map(Number),
    affectedSignals: block.slice(6),
  };
}

const IT_RF_PATHS = { 2: 'L1', 3: 'L2', 5: 'L5' };
const IT_DETECTION_TYPES = { 0: 'SPECTRUMANALYSIS', 1: 'STATISTICANALYSIS' };
const IT_ENTRY_BYTES = 36;
const IT_MAX_ENTRIES = 256;

/** Decodes an OEM7 binary ITDETECTSTATUS body (message ID 2065) into the ASCII decoder's shape. */
function decodeItDetectStatusBinary(body) {
  if (!body || body.length < 4) throw new Error('ITDETECTSTATUS binary body is incomplete');
  const declared = body.readUInt32LE(0);
  if (declared > IT_MAX_ENTRIES || body.length !== 4 + declared * IT_ENTRY_BYTES) {
    throw new Error('ITDETECTSTATUS binary body has an invalid detection count or incomplete detection data');
  }
  const count = Math.min(declared, IT_MAX_ENTRIES, Math.floor((body.length - 4) / IT_ENTRY_BYTES));
  const detections = [];
  for (let index = 0; index < count; index++) {
    const offset = 4 + index * IT_ENTRY_BYTES;
    const rfPath = body.readUInt32LE(offset);
    const typeCode = body.readUInt32LE(offset + 4);
    const spectrum = typeCode === 0;
    const parameter = (byte) => {
      const value = body.readFloatLE(offset + byte);
      return spectrum && Number.isFinite(value) ? value : null;
    };
    const centerMHz = parameter(8);
    const bandwidthMHz = parameter(12);
    detections.push({
      fields: [],
      signalType: IT_RF_PATHS[rfPath] || `RF${rfPath}`,
      type: IT_DETECTION_TYPES[typeCode] || String(typeCode),
      centerFrequencyHz: centerMHz === null ? null : centerMHz * 1e6,
      bandwidthHz: bandwidthMHz === null ? null : bandwidthMHz * 1e6,
      powerDbm: parameter(16),
      noiseFloorDbm: null,
      metrics: [],
      affectedSignals: [],
    });
  }
  return { detectionCount: declared, detections, extraFields: [] };
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
  1696: 'BDSEPHEMERIS',
  2065: 'ITDETECTSTATUS',
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
  if (headerLength < minimum) return null;
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
  scaleFrequencyHz,
  decodeItDetectStatusBinary,
  splitFields,
  readBinaryLog,
  findSyncIndex,
  gpsToUtc,
  gpsToMs,
  saneTimestamp,
  SANE_GPS_EARLIEST_MS,
  SANE_GPS_SKEW_MS,
  SANE_GPS_AHEAD_MS,
  MESSAGE_NAMES_BY_ID,
};

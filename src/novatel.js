'use strict';

/**
 * NovAtel OEM framing and a few body decoders used by GNSSBASE.
 * ASCII sentences start with '#' (long header) or '%' (short header). Binary
 * logs start with sync AA 44 12 (long header) or AA 44 13 (short header).
 * The CRC-32 polynomial is 0xEDB88320. On a binary log it covers the bytes
 * before the trailing CRC. This module does not open a port and emits no events.
 */

const CRC32_POLYNOMIAL = 0xedb88320;

/**
 * Builds the 256-entry reflected CRC-32 table for polynomial 0xEDB88320.
 * @returns {Uint32Array} Lookup table shared by the ASCII and binary CRC helpers.
 * Side effects: none. Does not throw.
 * Events: none.
 */
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

/**
 * NovAtel 32-bit CRC over an ASCII sentence body (everything between '#'/'%' and '*').
 * The running value starts at 0 and is not inverted at the end. Each step mixes
 * the low 8 bits of the character code.
 * @param {string} str Body characters, excluding the sync character and the '*' checksum.
 * @returns {number} Unsigned 32-bit CRC.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function novatelCrc32(str) {
  let crc = 0;
  for (let i = 0; i < str.length; i++) {
    crc = (crcTable[(crc ^ str.charCodeAt(i)) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Same CRC-32 (polynomial 0xEDB88320) over raw bytes. Binary logs pass every
 * byte before the trailing CRC, from the sync through the end of the body.
 * @param {Buffer|Uint8Array} buf
 * @param {number} start Inclusive start index.
 * @param {number} end Exclusive end index.
 * @returns {number} Unsigned 32-bit CRC. The accumulator starts at 0 and is not inverted.
 * Side effects: none. Does not throw.
 * Events: none.
 */
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

// GPS epoch is 1980-01-06 UTC. gpsToMs adds week * 604800000 (one week in
// milliseconds) and subtracts LEAP_SECONDS.
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
// GPS-UTC offset. LEAP_SECONDS is 18 since 2017-01-01. NOVATEL_LEAP_SECONDS overrides
// it. A receiver-provided offset, once a decoded log actually carries one, wins over
// both via setReceiverLeapSeconds. None of the logs this process already decodes
// include that offset: ephemeris clockOffset is the satellite clock bias, not UTC.
// Until one of those is set, archive GPS time is 1 s off live reception after a new leap second.
const LEAP_SECONDS = 18;
/** Set by setReceiverLeapSeconds when a decoded log reports the offset. Null uses the env or 18. */
let receiverLeapSeconds = null;

/**
 * GPS-UTC leap seconds used by gpsToMs.
 * A value passed to setReceiverLeapSeconds wins. Otherwise NOVATEL_LEAP_SECONDS
 * when it is an integer from 0 through 60. Otherwise LEAP_SECONDS (18).
 * @returns {number}
 * Side effects: reads process.env.NOVATEL_LEAP_SECONDS. Does not throw.
 * Events: none.
 */
function currentLeapSeconds() {
  if (Number.isInteger(receiverLeapSeconds) && receiverLeapSeconds >= 0 && receiverLeapSeconds <= 60) {
    return receiverLeapSeconds;
  }
  const raw = process.env.NOVATEL_LEAP_SECONDS;
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0 && value <= 60) return value;
  }
  return LEAP_SECONDS;
}

/**
 * Remembers a leap-second offset reported by the receiver.
 * Ignored unless value is an integer from 0 through 60. No decoded log currently
 * calls this. It is the hook for a future TIME or CLOCK offset field.
 * @param {number} value GPS-UTC leap seconds.
 * @returns {void}
 * Side effects: assigns receiverLeapSeconds when value is in range. Does not log.
 * Events: none.
 */
function setReceiverLeapSeconds(value) {
  // null clears a previous receiver value so the environment or the default is used again.
  if (value === null || value === undefined) {
    receiverLeapSeconds = null;
    return;
  }
  if (Number.isInteger(value) && value >= 0 && value <= 60) receiverLeapSeconds = value;
}

/**
 * Converts a GPS week and seconds-of-week to Unix milliseconds.
 * The formula is GPS_EPOCH_MS (1980-01-06) + week * 604800000 + (seconds - LEAP_SECONDS) * 1000.
 * @param {number} week GPS week number.
 * @param {number} seconds Seconds of week. The fractional part is kept.
 * @returns {number|null} Milliseconds since the Unix epoch, or null when either
 *   input is not finite or the absolute value of the result exceeds 8640000000000000.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function gpsToMs(week, seconds) {
  if (!Number.isFinite(week) || !Number.isFinite(seconds)) return null;
  // 1980-01-06 plus week * 604800000 ms, then subtract the configured leap seconds.
  const ms = GPS_EPOCH_MS + week * 604800000 + (seconds - currentLeapSeconds()) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? ms : null;
}

/**
 * Converts a GPS week and seconds-of-week to a UTC ISO-8601 string.
 * @param {number} week GPS week number.
 * @param {number} seconds Seconds of week.
 * @returns {string|null} `toISOString()` of the gpsToMs result, or null when that result is null.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function gpsToUtc(week, seconds) {
  const ms = gpsToMs(week, seconds);
  return ms === null ? null : new Date(ms).toISOString();
}

// Header time is used only when it is finite, >= 2020-01-01 UTC, >= now - 5 min,
// and <= now + 2 s. Otherwise a finite reception time is used, otherwise `now`.
// A header further ahead than 2 seconds is rejected because live charts clip
// at the computer clock.
const SANE_GPS_EARLIEST_MS = Date.UTC(2020, 0, 1);
const SANE_GPS_SKEW_MS = 5 * 60 * 1000;
const SANE_GPS_AHEAD_MS = 2 * 1000;

/**
 * Chooses a millisecond timestamp for a log.
 * The header is used only if it is finite, >= 2020-01-01 UTC, >= now - 5 minutes,
 * and <= now + 2 seconds. Otherwise the reception time is used when that is
 * finite, and otherwise `now`. A header further ahead is rejected because live
 * charts clip at the computer clock.
 * @param {number|string} headerUtc Header time as milliseconds, or a string for Date.parse.
 * @param {number|string} receivedAt Reception time as milliseconds, or a string for Date.parse.
 * @param {number} [now=Date.now()] Clock used for the window.
 * @returns {number} Milliseconds.
 * Side effects: reads the clock when `now` is omitted. Does not throw.
 * Events: none.
 */
function saneTimestamp(headerUtc, receivedAt, now = Date.now()) {
  const headerMs = typeof headerUtc === 'number' ? headerUtc : Date.parse(headerUtc);
  // Finite, >= 2020-01-01 UTC, >= now - 5 min, and <= now + 2 s.
  const usable = Number.isFinite(headerMs) && headerMs >= SANE_GPS_EARLIEST_MS
    && headerMs >= now - SANE_GPS_SKEW_MS && headerMs <= now + SANE_GPS_AHEAD_MS;
  if (usable) return headerMs;
  // Header rejected: use reception time when it is finite, otherwise `now`.
  const receivedMs = typeof receivedAt === 'number' ? receivedAt : Date.parse(receivedAt);
  return Number.isFinite(receivedMs) ? receivedMs : now;
}

/**
 * Parses one NovAtel ASCII sentence (long '#' or short '%' header).
 * Returns null when the line is shorter than 4 characters, does not start with
 * '#' or '%', or has no ';'. A checksum is the text after the last '*'. It is
 * accepted only when it is eight hex digits and matches novatelCrc32 of the body.
 * A missing or bad checksum does not reject the sentence: crcValid is null or false.
 * A '%' sentence, or a '#' sentence whose fifth header field is not a time-status
 * name, uses the short header (week, seconds). Otherwise the long header carries
 * port, sequence, idle time, time status, week, seconds, and receiver status.
 * The trailing A or B on the message name is removed.
 * @param {string} line One ASCII log line.
 * @returns {object|null} `{ format: 'ascii', raw, header, fields, crcValid }`, or null.
 * Side effects: none. Does not throw.
 * Events: none.
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
    // Short header: name, week, seconds. Used for '%' and for a '#' whose fifth field is not a time status.
    const week = Number(headerFields[1]);
    const seconds = Number(headerFields[2]);
    header = { messageName, week, seconds, utc: gpsToUtc(week, seconds) };
  } else {
    // Long header: name, port, sequence, idle time, time status, week, seconds, receiver status.
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

/**
 * Splits a data body on commas, keeping quoted strings and {}/[] groups intact.
 * Quote characters are not copied into the field. A comma splits only outside
 * quotes at brace depth 0. A trailing empty field is dropped; an empty field
 * earlier in the body is kept.
 * @param {string} text Text after the header semicolon.
 * @returns {string[]} Trimmed fields.
 * Side effects: none. Does not throw.
 * Events: none.
 */
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
 * Two layouts are accepted. If the first field matches a signal name
 * (`/^[A-Z][A-Z0-9_]*$/i`), the count is the second field and each detection
 * needs at least one following field. Otherwise the count is the first field
 * and each detection needs at least two. The count must be an integer of digits,
 * at most 256. Zero requires no data fields. A positive count requires the data
 * length to be a multiple of the count and at least the minimum block size.
 * Signal-first blocks go to describeSignalDetection. The other layout goes to
 * describeDetection. Block size is the data length divided by the count, so
 * extra columns stay on each detection's fields. Signal-first extraFields is
 * the unused tail. Count-first extraFields is the whole data-field list when
 * that list is non-empty.
 * @param {object} message Parsed log. `message.fields` is used; a missing array is treated as empty.
 * @returns {{ detectionCount: number, detections: object[], extraFields: string[] }}
 * Side effects: throws Error when the count or the data length fails the checks above. Does not log.
 * Events: none.
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
 * Comparisons use the absolute value. A scaled result keeps the sign of `value`.
 * Center (any role other than 'bandwidth'): absolute value in [1100, 2700] is
 * treated as MHz and multiplied by 1e6; absolute value >= 1e6 stays Hz; any
 * other finite value returns null.
 * Bandwidth: absolute value < 1000 is treated as MHz and multiplied by 1e6;
 * absolute value >= 1000 stays Hz.
 * @param {number} value Raw center or bandwidth field.
 * @param {string} role `'bandwidth'` selects the bandwidth rule. Any other role is a center frequency.
 * @returns {number|null} Hertz, the original value when it is already in Hz, or null.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function scaleFrequencyHz(value, role) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  // Bandwidth: below 1000 is MHz (* 1e6); 1000 or above stays Hz.
  if (role === 'bandwidth') return abs < 1000 ? value * 1e6 : value;
  // Center: 1100..2700 is MHz (* 1e6); >= 1e6 stays Hz; otherwise null.
  if (abs >= 1100 && abs <= 2700) return value * 1e6;
  if (abs >= 1e6) return value;
  return null;
}

/**
 * Describes one detection block that follows a leading signal name.
 * block[0] is the type, block[1] the center, block[2] the bandwidth, block[3]
 * the power. Center and bandwidth always go through scaleFrequencyHz. Power is
 * numeric or null and is not limited to spectrum. Noise floor is read from
 * block[4] only when the type is SPECTRUMANALYSIS. Affected signals start at
 * index 5 for spectrum and index 4 otherwise.
 * @param {string} signalType Signal name taken from the field before the blocks.
 * @param {string[]} block One detection's fields, not including that signal name.
 * @returns {object} Detection record. `fields` is `[signalType, ...block]`.
 * Side effects: none. Does not throw.
 * Events: none.
 */
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

/**
 * Describes one detection block that starts with its own signal name.
 * block[0] is the signal, block[1] the type. Spectrum is block[1] === 'SPECTRUMANALYSIS'.
 * Center, bandwidth, power, and noise are filled only for spectrum; center and
 * bandwidth then use scaleFrequencyHz. A non-spectrum block sets those to null
 * and maps block[2] through block[5] with Number() into metrics (missing slots
 * become NaN). affectedSignals is block.slice(6) for either type.
 * @param {string[]} block One detection's fields.
 * @returns {object} Detection record. `fields` is the block unchanged.
 * Side effects: none. Does not throw.
 * Events: none.
 */
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

// Binary ITDETECTSTATUS RF path codes: 2 is L1, 3 is L2, 5 is L5.
const IT_RF_PATHS = { 2: 'L1', 3: 'L2', 5: 'L5' };
// Binary detection type: 0 is spectrum, 1 is statistic.
const IT_DETECTION_TYPES = { 0: 'SPECTRUMANALYSIS', 1: 'STATISTICANALYSIS' };
// Each binary entry is 36 bytes after the leading uint32 count. Message id is 2065.
const IT_ENTRY_BYTES = 36;
const IT_MAX_ENTRIES = 256;

/**
 * Decodes an OEM7 binary ITDETECTSTATUS body (message id 2065) into the ASCII decoder's shape.
 * The body is a uint32 count followed by that many 36-byte entries. The count
 * must be at most 256 and the body length must be exactly 4 + count * 36.
 * RF path 2, 3, and 5 become L1, L2, and L5; any other path is `RF` plus the code.
 * Type 0 is spectrum and type 1 is statistic. The center and bandwidth floats
 * are MHz and are multiplied by 1e6. They are kept only for a spectrum entry.
 * The power float is not multiplied. noiseFloorDbm, metrics, affectedSignals,
 * and fields are left empty.
 * @param {Buffer} body Binary message body, excluding the header and the CRC.
 * @returns {{ detectionCount: number, detections: object[], extraFields: Array }}
 *   detectionCount is the uint32 count. extraFields is always empty.
 * Side effects: throws Error when the body is missing, shorter than 4 bytes, or the count/length check fails. Does not log.
 * Events: none.
 */
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
    /**
     * Reads one little-endian float from this 36-byte entry.
     * Center is byte 8, bandwidth byte 12, power byte 16. The value is returned
     * only when the entry type is spectrum (0) and the float is finite.
     * @param {number} byte Offset of the float within the entry.
     * @returns {number|null} The float, or null for a statistic entry or a non-finite value.
     * Side effects: none. Does not throw.
     * Events: none.
     */
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
      // Spectrum center and bandwidth floats are MHz, then converted with * 1e6.
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

// Binary sync: AA 44 12 is the long header, AA 44 13 is the short header.
const SYNC_LONG = Buffer.from([0xaa, 0x44, 0x12]);
const SYNC_SHORT = Buffer.from([0xaa, 0x44, 0x13]);
// Long-header minimum. The header-length byte at index 3 may make the header longer than 28.
const LONG_HEADER_LENGTH = 28;
// Short header is fixed at 12 bytes. Its byte at index 3 is the message length, not a header length.
const SHORT_HEADER_LENGTH = 12;

const TIME_STATUS_BY_CODE = {
  20: 'UNKNOWN', 60: 'APPROXIMATE', 80: 'COARSEADJUSTING', 100: 'COARSE',
  120: 'COARSESTEERING', 130: 'FREEWHEELING', 140: 'FINEADJUSTING', 160: 'FINE',
  170: 'FINEBACKUPSTEERING', 180: 'FINESTEERING', 200: 'SATTIME',
};

// OEM7 message IDs for the logs this tool cares about. 2065 is ITDETECTSTATUS.
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
 * Long sync is AA 44 12 and short sync is AA 44 13. The long header length is
 * the byte at index 3 and is rejected when it is shorter than 28. The short
 * header length is 12, and its byte at index 3 is the message length. Message
 * id is the uint16 at offset 4 in both layouts. Long message length is the
 * uint16 at offset 8. Week is the uint16 at offset 14 (long) or 6 (short).
 * Milliseconds are the uint32 at offset 16 (long) or 8 (short) and are divided
 * by 1000 into header.seconds. The CRC-32 (polynomial 0xEDB88320) covers the
 * bytes before the trailing CRC. A CRC mismatch is reported as crcValid false
 * and the log is still returned.
 * @param {Buffer} buf Bytes that may begin with a sync pattern.
 * @returns {{ message: object, consumed: number }|{ need: number }|null}
 *   A whole log and its byte count, `{ need }` when more bytes are required,
 *   or null when the buffer does not start with a sync or the framing is rejected.
 * Side effects: none. Does not throw. The returned body is a subarray view of `buf`.
 * Events: none.
 */
function readBinaryLog(buf) {
  const isLong = buf.length >= 3 && buf.compare(SYNC_LONG, 0, 3, 0, 3) === 0;
  const isShort = buf.length >= 3 && buf.compare(SYNC_SHORT, 0, 3, 0, 3) === 0;
  if (!isLong && !isShort) return null;

  // Long: header-length byte at index 3. Short: fixed 12-byte header.
  const headerLength = isLong ? (buf.length > 3 ? buf[3] : LONG_HEADER_LENGTH) : SHORT_HEADER_LENGTH;
  const minimum = isLong ? LONG_HEADER_LENGTH : SHORT_HEADER_LENGTH;
  if (headerLength < minimum) return null;
  if (buf.length < minimum) return { need: minimum };

  // Long message length is the uint16 at offset 8. Short message length is the byte at index 3.
  const messageLength = isLong ? buf.readUInt16LE(8) : buf[3];
  const total = headerLength + messageLength + 4;
  if (total > 1 << 16) return null; // implausible framing, treat as noise
  if (buf.length < total) return { need: total };

  // CRC-32 over the bytes before the trailing 4-byte CRC. A mismatch does not drop the log.
  const expectedCrc = buf.readUInt32LE(total - 4);
  const crcValid = novatelCrc32Buffer(buf, 0, total - 4) === expectedCrc;

  // Message id is the uint16 at offset 4 for both the long and short headers.
  const messageId = isLong ? buf.readUInt16LE(4) : buf.readUInt16LE(4);
  // Week uint16, then milliseconds as a uint32. Stored seconds are milliseconds / 1000.
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
    // Remaining long-header fields. Idle time is the byte at index 12 divided by 2.
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

/**
 * Finds the next binary sync (AA 44 12 or AA 44 13) at or after `from`.
 * @param {Buffer} buf
 * @param {number} [from=0] Index passed to Buffer.indexOf.
 * @returns {number} The earlier of the two sync indexes, or -1 when neither is present.
 * Side effects: none. Does not throw.
 * Events: none.
 */
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
  currentLeapSeconds,
  setReceiverLeapSeconds,
  LEAP_SECONDS,
  saneTimestamp,
  SANE_GPS_EARLIEST_MS,
  SANE_GPS_SKEW_MS,
  SANE_GPS_AHEAD_MS,
  MESSAGE_NAMES_BY_ID,
};

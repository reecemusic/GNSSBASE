'use strict';

/**
 * Turns a parsed NovAtel ASCII or binary log into a display record.
 * ASCII field decoders and OEM7 binary body decoders live here for position,
 * version, receiver status, range, satellites, visibility, and ephemeris.
 * Interference bodies are decoded in novatel.js. This module does not frame
 * bytes and emits no events.
 */

const { interpretItDetectStatus, decodeItDetectStatusBinary } = require('./novatel');

// --- enum tables (OEM7) -----------------------------------------------------

const SOLUTION_STATUS = {
  0: 'SOL_COMPUTED', 1: 'INSUFFICIENT_OBS', 2: 'NO_CONVERGENCE', 3: 'SINGULARITY',
  4: 'COV_TRACE', 5: 'TEST_DIST', 6: 'COLD_START', 7: 'V_H_LIMIT', 8: 'VARIANCE',
  9: 'RESIDUALS', 13: 'INTEGRITY_WARNING', 18: 'PENDING', 19: 'INVALID_FIX',
  20: 'UNAUTHORIZED', 22: 'INVALID_RATE',
};

const POSITION_TYPE = {
  0: 'NONE', 1: 'FIXEDPOS', 2: 'FIXEDHEIGHT', 8: 'DOPPLER_VELOCITY',
  16: 'SINGLE', 17: 'PSRDIFF', 18: 'WAAS', 19: 'PROPAGATED',
  32: 'L1_FLOAT', 34: 'NARROW_FLOAT', 48: 'L1_INT', 50: 'NARROW_INT',
  51: 'RTK_DIRECT_INS', 52: 'INS_SBAS', 53: 'INS_PSRSP', 54: 'INS_PSRDIFF',
  55: 'INS_RTKFLOAT', 56: 'INS_RTKFIXED', 68: 'PPP_CONVERGING', 69: 'PPP',
  70: 'OPERATIONAL', 71: 'WARNING', 72: 'OUT_OF_BOUNDS',
  77: 'PPP_BASIC_CONVERGING', 78: 'PPP_BASIC',
};

// RXSTATUS receiver-status word. describeReceiverStatus reports only the bits
// in RECEIVER_STATUS_BITS. A set bit contributes its label, in this order:
// 0 Error flag set, 1 Temperature warning, 2 Voltage supply warning,
// 3 Primary antenna not powered, 4 LNA failure, 5 Primary antenna open circuit,
// 6 Primary antenna short circuit, 7 CPU overload, 8 COM buffer overrun,
// 11 Link overrun, 12 Input overrun, 13 Aux transmit overrun,
// 14 Antenna gain out of range, 15 Jammer detected, 16 INS reset,
// 17 IMU communication failure, 18 GPS almanac / UTC invalid,
// 19 Position solution invalid, 20 Position not fixed,
// 21 Clock steering disabled, 22 Clock model invalid,
// 23 External oscillator locked, 24 Software resource warning,
// 31 Auxiliary status event.
// Bits that are not in this list are ignored.
const RECEIVER_STATUS_BITS = [
  [0, 'Error flag set'],
  [1, 'Temperature warning'],
  [2, 'Voltage supply warning'],
  [3, 'Primary antenna not powered'],
  [4, 'LNA failure'],
  [5, 'Primary antenna open circuit'],
  [6, 'Primary antenna short circuit'],
  [7, 'CPU overload'],
  [8, 'COM buffer overrun'],
  [11, 'Link overrun'],
  [12, 'Input overrun'],
  [13, 'Aux transmit overrun'],
  [14, 'Antenna gain out of range'],
  [15, 'Jammer detected'],
  [16, 'INS reset'],
  [17, 'IMU communication failure'],
  [18, 'GPS almanac / UTC invalid'],
  [19, 'Position solution invalid'],
  [20, 'Position not fixed'],
  [21, 'Clock steering disabled'],
  [22, 'Clock model invalid'],
  [23, 'External oscillator locked'],
  [24, 'Software resource warning'],
  [31, 'Auxiliary status event'],
];

const EPHEMERIS_MESSAGES = new Set([
  'GPSEPHEM', 'GLOEPHEMERIS', 'GALINAVEPHEMERIS', 'GALFNAVEPHEMERIS',
  'BDSEPHEMERIS', 'QZSSEPHEMERIS', 'NAVICEPHEMERIS',
]);

// --- ASCII decoders ---------------------------------------------------------

/**
 * Parses one ASCII numeric field.
 * @param {*} value Field text or a missing value.
 * @returns {number|null} A finite number, or null when the value is missing, blank, or not finite.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function num(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decodes an ASCII BESTPOS or BESTGNSSPOS body.
 * Fields, in order: solution status, position type, latitude, longitude,
 * height above mean sea level, undulation, datum, latitude sigma, longitude
 * sigma, height sigma, station id, differential age, solution age, satellites
 * tracked, satellites used. Numeric slots go through num(). No length check.
 * @param {string[]} fields Data fields after the header semicolon.
 * @returns {object} The position record. Unset numeric fields are null.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function decodeBestPosAscii(fields) {
  return {
    solutionStatus: fields[0],
    positionType: fields[1],
    latitude: num(fields[2]),
    longitude: num(fields[3]),
    heightMsl: num(fields[4]),
    undulation: num(fields[5]),
    datum: fields[6],
    latitudeSigma: num(fields[7]),
    longitudeSigma: num(fields[8]),
    heightSigma: num(fields[9]),
    stationId: fields[10],
    differentialAge: num(fields[11]),
    solutionAge: num(fields[12]),
    satellitesTracked: num(fields[13]),
    satellitesUsed: num(fields[14]),
  };
}

/**
 * Decodes an ASCII VERSION body.
 * fields[0] is a component count. The remaining fields are split into equal
 * blocks. A component is recorded only when that block has at least five fields:
 * type, model, serial number, hardware version, software version, then optional
 * boot version and a compile date made from the next two fields joined by a space.
 * @param {string[]} fields
 * @returns {{ componentCount: number, components: object[] }}
 *   componentCount is the numeric count, or 0 when that field is not numeric.
 *   components is empty when the block size is below 5.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function decodeVersionAscii(fields) {
  const count = num(fields[0]) || 0;
  const rest = fields.slice(1);
  const blockSize = count > 0 ? Math.floor(rest.length / count) : 0;
  const components = [];
  for (let i = 0; i < count && blockSize >= 5; i++) {
    const block = rest.slice(i * blockSize, (i + 1) * blockSize);
    components.push({
      type: block[0],
      model: block[1],
      serialNumber: block[2],
      hardwareVersion: block[3],
      softwareVersion: block[4],
      bootVersion: block[5] || '',
      compileDate: [block[6], block[7]].filter(Boolean).join(' '),
    });
  }
  return { componentCount: count, components };
}

/**
 * Decodes an ASCII RXSTATUS body.
 * Requires two 8-hex-digit words: fields[0] is the error word and fields[2] is
 * the receiver status word. fields[1] is not read. The returned word strings are
 * the original fields. hasError is true when the error word parses as non-zero.
 * activeFlags comes from describeReceiverStatus on the status word.
 * @param {string[]} fields
 * @returns {{ errorWord: string, receiverStatusWord: string, hasError: boolean, activeFlags: string[] }}
 * Side effects: throws Error when fields[0] or fields[2] is not exactly eight hex digits. Does not log.
 * Events: none.
 */
function decodeRxStatusAscii(fields) {
  if (!/^[0-9a-fA-F]{8}$/.test(fields[0] || '') || !/^[0-9a-fA-F]{8}$/.test(fields[2] || '')) {
    throw new Error('RXSTATUS error or status word is not an 8-digit hex value');
  }
  const errorWord = parseInt(fields[0], 16);
  const statusWord = parseInt(fields[2], 16);
  return {
    errorWord: fields[0],
    receiverStatusWord: fields[2],
    hasError: errorWord !== 0,
    activeFlags: describeReceiverStatus(statusWord),
  };
}

/**
 * Lists labels from RECEIVER_STATUS_BITS whose bit is set in `word`.
 * Only the bits stored in that array are considered.
 * @param {number} word Receiver status word.
 * @returns {string[]} Labels of the set bits, in RECEIVER_STATUS_BITS order.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function describeReceiverStatus(word) {
  return RECEIVER_STATUS_BITS.filter(([bit]) => (word >>> bit) & 1).map(([, label]) => label);
}

// Channel tracking status bits 16-18 select the constellation.
// (value >>> 16) & 0x7 indexes this list: 0 GPS, 1 GLONASS, 2 SBAS, 3 GALILEO,
// 4 BEIDOU, 5 QZSS, 6 NAVIC, 7 OTHER.
const TRACKING_SYSTEMS = ['GPS', 'GLONASS', 'SBAS', 'GALILEO', 'BEIDOU', 'QZSS', 'NAVIC', 'OTHER'];

/**
 * Reads constellation bits 16-18 of a channel tracking-status word.
 * A number is shifted as-is. Any other value is parsed as hexadecimal first.
 * @param {number|string} status Tracking-status word, or an ASCII hex field.
 * @returns {string} A TRACKING_SYSTEMS entry, or '' when the value is not finite.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function systemFromTrackingStatus(status) {
  const value = typeof status === 'number' ? status : parseInt(status, 16);
  if (!Number.isFinite(value)) return '';
  return TRACKING_SYSTEMS[(value >>> 16) & 0x7];
}

/**
 * Decodes an ASCII RANGE body. The count is fields[0] and each observation is
 * 10 fields: PRN, GLONASS frequency, pseudorange, then carrier-to-noise at
 * index 7, lock time at index 8, and tracking status at index 9.
 * The GLONASS frequency is the signed field as parsed by num(). This path does
 * not subtract 7. The binary decoder does that, and only for GLONASS.
 * @param {string[]} fields
 * @returns {{ observationCount: number, observations: object[] }}
 *   Observations are sorted by carrier-to-noise, largest first.
 * Side effects: throws Error when the count is not an integer from 0 to 2048
 *   or fields.length is not 1 + count * 10. Does not log.
 * Events: none.
 */
function decodeRangeAscii(fields) {
  const count = num(fields[0]);
  if (!Number.isInteger(count) || count < 0 || count > 2048 || fields.length !== 1 + count * 10) {
    throw new Error('RANGE has an invalid observation count or incomplete observation data');
  }
  const rest = fields.slice(1);
  const blockSize = 10;
  const observations = [];
  for (let i = 0; i < count && blockSize >= 10; i++) {
    const block = rest.slice(i * blockSize, (i + 1) * blockSize);
    observations.push({
      prn: num(block[0]),
      // ASCII keeps the signed GLONASS frequency as parsed. 7 is not subtracted here.
      gloFrequency: num(block[1]),
      pseudorange: num(block[2]),
      carrierToNoise: num(block[7]),
      lockTime: num(block[8]),
      trackingStatus: block[9],
      system: systemFromTrackingStatus(block[9]),
    });
  }
  observations.sort((a, b) => (b.carrierToNoise || 0) - (a.carrierToNoise || 0));
  return { observationCount: count, observations };
}

/**
 * Decodes an ASCII BESTSATS body. The count is fields[0] and each satellite is
 * four fields: system, satellite id, status, signal mask.
 * GLONASS ids may end in a signed channel suffix. The suffix is allowed by the
 * id check and is not used as a frequency; the stored prn is the original field.
 * The dedup key uses the leading digits. A repeated system and PRN is kept when
 * the status and signal mask match, and throws when they do not. satelliteCount
 * is the number of unique keys. System OTHER is rejected.
 * @param {string[]} fields
 * @returns {{ satelliteCount: number, satellites: object[] }}
 * Side effects: throws Error when the count, length, an entry, or a conflicting
 *   duplicate is invalid. Does not log.
 * Events: none.
 */
function decodeBestSatsAscii(fields) {
  const count = Number(fields[0]);
  if (!/^\d+$/.test(fields[0] || '') || !Number.isSafeInteger(count)
    || count > 2048 || fields.length !== 1 + count * 4) {
    throw new Error('BESTSATS has an invalid satellite count or incomplete satellite data');
  }
  const byKey = new Map();
  for (let i = 0; i < count; i++) {
    const offset = 1 + i * 4;
    const [system, satelliteId, status, signalMask] = fields.slice(offset, offset + 4);
    const id = String(satelliteId).match(system === 'GLONASS' ? /^(\d+)(?:[+-]\d+)?$/ : /^(\d+)$/);
    if (!TRACKING_SYSTEMS.includes(system) || system === 'OTHER'
      || !id || !Number.isSafeInteger(Number(id[1])) || Number(id[1]) <= 0
      || !/^[A-Z][A-Z0-9_]*$/.test(status) || !/^[0-9a-fA-F]{1,8}$/.test(signalMask)) {
      throw new Error(`BESTSATS has invalid satellite data at entry ${i + 1}`);
    }
    const key = `${system}:${Number(id[1])}`;
    const previous = byKey.get(key);
    if (previous && (previous.status !== status || parseInt(previous.signalMask, 16) !== parseInt(signalMask, 16))) {
      throw new Error(`BESTSATS has conflicting duplicate satellite ${key}`);
    }
    byKey.set(key, { system, prn: satelliteId, status, signalMask });
  }
  const satellites = [...byKey.values()];
  return { satelliteCount: satellites.length, satellites };
}

/**
 * Decodes an ASCII TRACKSTAT body.
 * The first four fields are solution status, position type, cutoff, and channel
 * count. Each channel is 10 fields. PRN, GLONASS frequency, and tracking status
 * are the first three of those; carrier-to-noise is index 5 and status is index 8.
 * The GLONASS frequency is num() of the signed field. This path does not subtract 7.
 * The constellation comes from tracking-status bits 16-18.
 * @param {string[]} fields
 * @returns {object} solutionStatus, positionType, cutoff, observationCount, observations.
 * Side effects: throws Error when the count is not an integer >= 0 or
 *   fields.length is not 4 + count * 10. Does not log.
 * Events: none.
 */
function decodeTrackStatAscii(fields) {
  const count = num(fields[3]);
  if (!Number.isInteger(count) || count < 0 || fields.length !== 4 + count * 10) {
    throw new Error('TRACKSTAT has an invalid channel count or incomplete channel data');
  }
  const observations = [];
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * 10;
    const trackingStatus = fields[offset + 2];
    observations.push({
      prn: num(fields[offset]),
      // ASCII keeps the signed GLONASS frequency as parsed. 7 is not subtracted here.
      gloFrequency: num(fields[offset + 1]),
      trackingStatus,
      system: systemFromTrackingStatus(trackingStatus),
      carrierToNoise: num(fields[offset + 5]),
      status: fields[offset + 8],
    });
  }
  return {
    solutionStatus: fields[0], positionType: fields[1], cutoff: num(fields[2]),
    observationCount: count, observations,
  };
}

const GPS_EPHEMERIS_FIELDS = [
  ['satelliteId'], ['tow', 's'], ['health'], ['iode1'], ['iode2'], ['week'], ['zWeek'],
  ['toe', 's'], ['semiMajorAxis', 'm'], ['deltaN', 'rad/s'], ['meanAnomaly', 'rad'],
  ['eccentricity'], ['argumentOfPerigee', 'rad'], ['cuc', 'rad'], ['cus', 'rad'],
  ['crc', 'm'], ['crs', 'm'], ['cic', 'rad'], ['cis', 'rad'], ['inclination', 'rad'],
  ['inclinationRate', 'rad/s'], ['ascendingNode', 'rad'], ['ascendingNodeRate', 'rad/s'],
  ['iodc'], ['toc', 's'], ['groupDelay', 's'], ['clockBias', 's'], ['clockDrift', 's/s'],
  ['clockDriftRate', 's/s^2'], ['antiSpoofing'], ['correctedMeanMotion', 'rad/s'], ['uraVariance', 'm^2'],
];

const GALILEO_EPHEMERIS_FIELDS = [
  ['satelliteId'], ['e5Health'], ['e5DataValidity'], ['reserved1'], ['reserved2'],
  ['e1Health'], ['e1DataValidity'], ['reserved3'], ['reserved4'], ['issueOfData'],
  ['sisaIndex'], ['source'], ['toe', 's'], ['toc', 's'], ['meanAnomaly', 'rad'],
  ['deltaN', 'rad/s'], ['eccentricity'], ['rootSemiMajorAxis', 'sqrt(m)'],
  ['inclination', 'rad'], ['inclinationRate', 'rad/s'], ['ascendingNode', 'rad'],
  ['argumentOfPerigee', 'rad'], ['ascendingNodeRate', 'rad/s'], ['cuc', 'rad'],
  ['cus', 'rad'], ['crc', 'm'], ['crs', 'm'], ['cic', 'rad'], ['cis', 'rad'],
  ['clockBias', 's'], ['clockDrift', 's/s'], ['clockDriftRate', 's/s^2'],
  ['e1E5aGroupDelay', 's'], ['e1E5bGroupDelay', 's'],
];

const GALILEO_FNAV_EPHEMERIS_FIELDS = [
  ['satelliteId'], ['e5Health'], ['e5DataValidity'], ['reserved1'], ['reserved2'],
  ['issueOfData'], ['sisaIndex'], ['reserved3'], ['toe', 's'], ['toc', 's'],
  ['meanAnomaly', 'rad'], ['deltaN', 'rad/s'], ['eccentricity'],
  ['rootSemiMajorAxis', 'sqrt(m)'], ['inclination', 'rad'], ['inclinationRate', 'rad/s'],
  ['ascendingNode', 'rad'], ['argumentOfPerigee', 'rad'], ['ascendingNodeRate', 'rad/s'],
  ['cuc', 'rad'], ['cus', 'rad'], ['crc', 'm'], ['crs', 'm'], ['cic', 'rad'],
  ['cis', 'rad'], ['clockBias', 's'], ['clockDrift', 's/s'], ['clockDriftRate', 's/s^2'],
  ['e1E5aGroupDelay', 's'],
];

const QZSS_EPHEMERIS_FIELDS = [
  ...GPS_EPHEMERIS_FIELDS,
  ['fitInterval'], ['reserved1'], ['reserved2'], ['reserved3'],
];

const BEIDOU_EPHEMERIS_FIELDS = [
  ['satelliteId'], ['week'], ['ura', 'm'], ['health'], ['b1GroupDelay', 's'],
  ['b2GroupDelay', 's'], ['clockAge'], ['toc', 's'], ['clockBias', 's'],
  ['clockDrift', 's/s'], ['clockDriftRate', 's/s^2'], ['ephemerisAge'], ['toe', 's'],
  ['rootSemiMajorAxis', 'sqrt(m)'], ['eccentricity'], ['argumentOfPerigee', 'rad'],
  ['deltaN', 'rad/s'], ['meanAnomaly', 'rad'], ['ascendingNode', 'rad'],
  ['ascendingNodeRate', 'rad/s'], ['inclination', 'rad'], ['inclinationRate', 'rad/s'],
  ['cuc', 'rad'], ['cus', 'rad'], ['crc', 'm'], ['crs', 'm'], ['cic', 'rad'], ['cis', 'rad'],
];

const NAVIC_EPHEMERIS_FIELDS = [
  ['satelliteId'], ['week'], ['clockBias', 's'], ['clockDrift', 's/s'],
  ['clockDriftRate', 's/s^2'], ['ura'], ['toc', 's'], ['groupDelay', 's'],
  ['deltaN', 'rad/s'], ['issueOfData'], ['reserved1'], ['l5Health'], ['sHealth'],
  ['cuc', 'rad'], ['cus', 'rad'], ['cic', 'rad'], ['cis', 'rad'], ['crc', 'm'],
  ['crs', 'm'], ['inclinationRate', 'rad/s'], ['reserved2'], ['meanAnomaly', 'rad'],
  ['toe', 's'], ['eccentricity'], ['rootSemiMajorAxis', 'sqrt(m)'],
  ['ascendingNode', 'rad'], ['argumentOfPerigee', 'rad'], ['ascendingNodeRate', 'rad/s'],
  ['inclination', 'rad'], ['reserved3'], ['alert'], ['autoNav'],
];

const GLONASS_EPHEMERIS_FIELDS = [
  ['satelliteId'], ['frequencyChannel'], ['satelliteType'], ['reserved'], ['week'],
  ['ephemerisTime', 'ms'], ['timeOffset', 's'], ['dayNumber'], ['reserved1'], ['reserved2'],
  ['issue'], ['health'], ['positionX', 'm'], ['positionY', 'm'], ['positionZ', 'm'],
  ['velocityX', 'm/s'], ['velocityY', 'm/s'], ['velocityZ', 'm/s'],
  ['accelerationX', 'm/s^2'], ['accelerationY', 'm/s^2'], ['accelerationZ', 'm/s^2'],
  ['clockOffset', 's'], ['groupDelay', 's'], ['frequencyCorrection', 's/s'],
  ['frameTime', 's'], ['technology'], ['userRange'], ['age', 'days'], ['flags'],
];

/**
 * Zips ASCII fields with name/unit definitions, in order.
 * The first field stays a string. Later fields go through num(). Fields past
 * the end of `definitions` are returned as extraFields and are not named.
 * @param {string[]} fields
 * @param {Array<Array<string>>} definitions Entries of `[name]` or `[name, unit]`.
 * @returns {{ satelliteId: string, parameters: object[], extraFields: string[] }}
 * Side effects: none. Does not throw when `fields` is shorter than `definitions`.
 * Events: none.
 */
function decodeFields(fields, definitions) {
  const parameters = definitions.slice(0, fields.length).map(([name, unit], index) => ({
    name,
    value: index === 0 ? fields[index] : num(fields[index]),
    unit: unit || '',
  }));
  return {
    satelliteId: fields[0] || '',
    parameters,
    extraFields: fields.slice(definitions.length),
  };
}

/**
 * Decodes an ASCII ephemeris body.
 * GPSEPHEM, QZSSEPHEMERIS, GLOEPHEMERIS, GALINAVEPHEMERIS, GALFNAVEPHEMERIS,
 * BDSEPHEMERIS, and NAVICEPHEMERIS use the field tables above. Any other name
 * keeps only a satellite id. For GLOEPHEMERIS, a numeric satellite id greater
 * than 37 is reduced by 37, the original string is saved as rawSatelliteId,
 * and parameters[0] is updated. The GLONASS frequency-channel field is left as
 * num() parsed it. This function does not subtract 7.
 * @param {string} name Message name without a trailing A or B.
 * @param {string[]} fields
 * @returns {object} The decodeFields result, with the GLONASS slot adjustment when it applies.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function decodeEphemerisAscii(name, fields) {
  let definitions;
  if (name === 'GPSEPHEM') definitions = GPS_EPHEMERIS_FIELDS;
  else if (name === 'QZSSEPHEMERIS') definitions = QZSS_EPHEMERIS_FIELDS;
  else if (name === 'GLOEPHEMERIS') definitions = GLONASS_EPHEMERIS_FIELDS;
  else if (name === 'GALINAVEPHEMERIS') definitions = GALILEO_EPHEMERIS_FIELDS;
  else if (name === 'GALFNAVEPHEMERIS') definitions = GALILEO_FNAV_EPHEMERIS_FIELDS;
  else if (name === 'BDSEPHEMERIS') definitions = BEIDOU_EPHEMERIS_FIELDS;
  else if (name === 'NAVICEPHEMERIS') definitions = NAVIC_EPHEMERIS_FIELDS;
  const decoded = decodeFields(fields, definitions || [['satelliteId']]);
  if (name === 'GLOEPHEMERIS' && Number(decoded.satelliteId) > 37) {
    decoded.rawSatelliteId = decoded.satelliteId;
    decoded.satelliteId = String(Number(decoded.satelliteId) - 37);
    decoded.parameters[0].value = decoded.satelliteId;
  }
  return decoded;
}

/**
 * Splits a SATVIS2 satellite id into a PRN and an optional signed GLONASS channel.
 * A trailing +N or -N is parsed with Number(), which keeps the sign. 7 is not
 * subtracted. With no suffix the channel is 0. A value that does not match is
 * returned as the prn unchanged.
 * @param {*} value Satellite-id field.
 * @returns {{ prn: *, gloFrequency: number }}
 * Side effects: none. Does not throw.
 * Events: none.
 */
function decodeSatVisSatelliteId(value) {
  const match = String(value || '').match(/^(\d+)([+-]\d+)?$/);
  return {
    prn: match ? match[1] : value,
    gloFrequency: match && match[2] ? Number(match[2]) : 0,
  };
}

/**
 * Decodes an ASCII SATVIS2 body.
 * Fields are system, visibility valid (TRUE or FALSE), almanac used (TRUE or
 * FALSE), satellite count, then six fields per satellite. The satellite id may
 * carry a signed GLONASS channel via decodeSatVisSatelliteId. System OTHER is
 * rejected. Elevation and azimuth go through num().
 * @param {string[]} fields
 * @returns {object} system, visibilityValid, almanacUsed, satelliteCount, satellites.
 * Side effects: throws Error when the system, the two flags, the count, or the
 *   field length is invalid. Does not log.
 * Events: none.
 */
function decodeSatVis2Ascii(fields) {
  const system = fields[0] || '';
  const count = num(fields[3]);
  if (!TRACKING_SYSTEMS.includes(system) || system === 'OTHER'
    || !['TRUE', 'FALSE'].includes(fields[1]) || !['TRUE', 'FALSE'].includes(fields[2])
    || !Number.isInteger(count) || count < 0 || count > 2048 || fields.length !== 4 + count * 6) {
    throw new Error('SATVIS2 has invalid visibility fields or incomplete satellite data');
  }
  const rest = fields.slice(4);
  const blockSize = 6;
  const satellites = [];
  for (let i = 0; i < count && blockSize >= 4; i++) {
    const block = rest.slice(i * blockSize, (i + 1) * blockSize);
    const satelliteId = decodeSatVisSatelliteId(block[0]);
    satellites.push({
      prn: satelliteId.prn,
      gloFrequency: satelliteId.gloFrequency,
      health: block[1],
      elevation: num(block[2]),
      azimuth: num(block[3]),
    });
  }
  return {
    system,
    visibilityValid: fields[1] === 'TRUE',
    almanacUsed: fields[2] === 'TRUE',
    satelliteCount: count,
    satellites,
  };
}

const ASCII_DECODERS = {
  BESTPOS: decodeBestPosAscii,
  BESTGNSSPOS: decodeBestPosAscii,
  VERSION: decodeVersionAscii,
  RXSTATUS: decodeRxStatusAscii,
  RANGE: decodeRangeAscii,
  SATVIS2: decodeSatVis2Ascii,
  BESTSATS: decodeBestSatsAscii,
  TRACKSTAT: decodeTrackStatAscii,
  /**
   * Passes the parsed message to the ASCII ITDETECTSTATUS interpreter.
   * `fields` is ignored; interpretItDetectStatus reads message.fields.
   * @param {string[]} fields Unused.
   * @param {object} message Parsed ASCII log.
   * @returns {object} The interpretItDetectStatus result.
   * Side effects: throws when interpretItDetectStatus throws. Does not log.
   * Events: none.
   */
  ITDETECTSTATUS: (fields, message) => interpretItDetectStatus(message),
};

// --- binary decoders --------------------------------------------------------

/**
 * Decodes a binary BESTPOS or BESTGNSSPOS body.
 * Offsets: solution status uint32 at 0, position type uint32 at 4, latitude
 * double at 8, longitude double at 16, height double at 24, undulation float
 * at 32, datum uint32 at 36 rendered with String(), sigmas at 40, 44, and 48,
 * station id as ASCII bytes 52 through 55 with NUL bytes removed, differential
 * age and solution age floats at 56 and 60, tracked and used counts as the
 * bytes at 64 and 65. Unknown status and type codes are returned as decimal strings.
 * @param {Buffer} body
 * @returns {object|null} The position record, or null when body.length is less than 72.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function decodeBestPosBinary(body) {
  if (body.length < 72) return null;
  return {
    solutionStatus: SOLUTION_STATUS[body.readUInt32LE(0)] || String(body.readUInt32LE(0)),
    positionType: POSITION_TYPE[body.readUInt32LE(4)] || String(body.readUInt32LE(4)),
    latitude: body.readDoubleLE(8),
    longitude: body.readDoubleLE(16),
    heightMsl: body.readDoubleLE(24),
    undulation: body.readFloatLE(32),
    datum: String(body.readUInt32LE(36)),
    latitudeSigma: body.readFloatLE(40),
    longitudeSigma: body.readFloatLE(44),
    heightSigma: body.readFloatLE(48),
    stationId: body.toString('ascii', 52, 56).replace(/\0/g, ''),
    differentialAge: body.readFloatLE(56),
    solutionAge: body.readFloatLE(60),
    satellitesTracked: body[64],
    satellitesUsed: body[65],
  };
}

/**
 * Decodes a binary RXSTATUS body.
 * A missing body or one shorter than 16 bytes is rejected. The error word is
 * the uint32 at offset 0. The receiver status word is the uint32 at offset 8.
 * Bytes 4 through 7 are not read. Both words are returned as eight lowercase
 * hex digits. hasError is true when the error word is non-zero. activeFlags
 * uses the same RECEIVER_STATUS_BITS list as the ASCII decoder.
 * @param {Buffer} body
 * @returns {{ errorWord: string, receiverStatusWord: string, hasError: boolean, activeFlags: string[] }}
 * Side effects: throws Error when the body is missing or shorter than 16 bytes. Does not log.
 * Events: none.
 */
function decodeRxStatusBinary(body) {
  if (!body || body.length < 16) throw new Error('RXSTATUS binary body is incomplete');
  const errorWord = body.readUInt32LE(0);
  const statusWord = body.readUInt32LE(8);
  return {
    errorWord: errorWord.toString(16).padStart(8, '0'),
    receiverStatusWord: statusWord.toString(16).padStart(8, '0'),
    hasError: errorWord !== 0,
    activeFlags: describeReceiverStatus(statusWord),
  };
}

/**
 * Decodes a binary RANGE body. The count is a uint32, and each observation is
 * 44 bytes: PRN uint16 at 0, GLONASS frequency uint16 at 2, pseudorange double
 * at 4, carrier-to-noise float at 32, lock time float at 36, tracking status
 * uint32 at 40.
 * The binary frequency is that unsigned field minus 7, and only when tracking
 * status bits 16-18 select GLONASS. Other constellations keep the unsigned
 * field. ASCII RANGE keeps its signed field and does not subtract 7.
 * @param {Buffer} body
 * @returns {{ observationCount: number, observations: object[] }}
 *   Observations are sorted by carrier-to-noise, largest first.
 * Side effects: throws Error when the body is shorter than 4 bytes, the count
 *   is above 2048, or the length is not 4 + count * 44. Does not log.
 * Events: none.
 */
function decodeRangeBinary(body) {
  if (body.length < 4) throw new Error('RANGE binary body is incomplete');
  const count = body.readUInt32LE(0);
  if (count > 2048 || body.length !== 4 + count * 44) {
    throw new Error('RANGE binary body has an invalid observation count or incomplete observation data');
  }
  const observations = [];
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * 44;
    if (offset + 44 > body.length) break;
    const trackingStatus = body.readUInt32LE(offset + 40);
    const system = systemFromTrackingStatus(trackingStatus);
    // Binary only: the unsigned GLONASS frequency field is the channel plus 7.
    // Subtract 7 when bits 16-18 select GLONASS. ASCII does not subtract 7.
    const gloFrequency = body.readUInt16LE(offset + 2);
    observations.push({
      prn: body.readUInt16LE(offset),
      gloFrequency: system === 'GLONASS' ? gloFrequency - 7 : gloFrequency,
      pseudorange: body.readDoubleLE(offset + 4),
      carrierToNoise: body.readFloatLE(offset + 32),
      lockTime: body.readFloatLE(offset + 36),
      trackingStatus: trackingStatus.toString(16).padStart(8, '0'),
      system,
    });
  }
  observations.sort((a, b) => (b.carrierToNoise || 0) - (a.carrierToNoise || 0));
  return { observationCount: count, observations };
}

const BINARY_DECODERS = {
  ITDETECTSTATUS: decodeItDetectStatusBinary,
  BESTPOS: decodeBestPosBinary,
  BESTGNSSPOS: decodeBestPosBinary,
  RXSTATUS: decodeRxStatusBinary,
  RANGE: decodeRangeBinary,
};

/**
 * Turns a parsed log into a display record.
 * Ephemeris names use decodeEphemerisAscii for ASCII. A binary ephemeris keeps
 * only the first uint32 as a satellite id when the body has at least 4 bytes,
 * and leaves parameters empty. Other names use ASCII_DECODERS or BINARY_DECODERS.
 * An ASCII log with no decoder keeps `{ fields }`. A binary log with no decoder
 * leaves data null and still returns the header, CRC flag, and size.
 * receivedAt is the ISO time of this call, not the header time.
 * @param {object} message Parsed log with header, format, and either fields or body.
 * @returns {object} Display record. `kind` is `'ephemeris'` only for ephemeris names.
 *   data may be null, including when binary BESTPOS is shorter than 72 bytes.
 * Side effects: reads the clock. Throws when the selected decoder throws.
 *   Does not log. Does not mutate `message`.
 * Events: none.
 */
function decode(message) {
  const name = message.header.messageName;
  const base = {
    name,
    format: message.format,
    receivedAt: new Date().toISOString(),
    header: message.header,
    crcValid: message.crcValid,
    raw: message.format === 'ascii' ? message.raw : `<binary ${message.byteLength} bytes, id ${message.header.messageId}>`,
    data: null,
  };

  if (EPHEMERIS_MESSAGES.has(name)) {
    base.data = message.format === 'ascii'
      ? decodeEphemerisAscii(name, message.fields)
      : { satelliteId: message.body.length >= 4 ? String(message.body.readUInt32LE(0)) : '', parameters: [] };
    base.kind = 'ephemeris';
    return base;
  }

  const decoder = message.format === 'ascii' ? ASCII_DECODERS[name] : BINARY_DECODERS[name];
  if (decoder) {
    base.data = message.format === 'ascii'
      ? decoder(message.fields, message)
      : decoder(message.body);
  } else if (message.format === 'ascii') {
    base.data = { fields: message.fields };
  }

  return base;
}

module.exports = { decode, EPHEMERIS_MESSAGES, describeReceiverStatus };

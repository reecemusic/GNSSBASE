'use strict';

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

// RXSTATUS receiver-status word bits that matter for an unattended base station.
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

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function decodeRxStatusAscii(fields) {
  const errorWord = parseInt(fields[0], 16) || 0;
  const statusWord = parseInt(fields[2], 16) || 0;
  return {
    errorWord: fields[0],
    receiverStatusWord: fields[2],
    hasError: errorWord !== 0,
    activeFlags: describeReceiverStatus(statusWord),
  };
}

function describeReceiverStatus(word) {
  return RECEIVER_STATUS_BITS.filter(([bit]) => (word >>> bit) & 1).map(([, label]) => label);
}

// Channel tracking status bits 16-18 identify the constellation.
const TRACKING_SYSTEMS = ['GPS', 'GLONASS', 'SBAS', 'GALILEO', 'BEIDOU', 'QZSS', 'RESERVED', 'OTHER'];

function systemFromTrackingStatus(status) {
  const value = typeof status === 'number' ? status : parseInt(status, 16);
  if (!Number.isFinite(value)) return '';
  return TRACKING_SYSTEMS[(value >>> 16) & 0x7];
}

function decodeRangeAscii(fields) {
  const count = num(fields[0]) || 0;
  const rest = fields.slice(1);
  const blockSize = count > 0 ? Math.floor(rest.length / count) : 0;
  const observations = [];
  for (let i = 0; i < count && blockSize >= 10; i++) {
    const block = rest.slice(i * blockSize, (i + 1) * blockSize);
    observations.push({
      prn: num(block[0]),
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

function decodeBestSatsAscii(fields) {
  const count = num(fields[0]) || 0;
  const rest = fields.slice(1);
  const blockSize = count > 0 ? Math.floor(rest.length / count) : 0;
  const satellites = [];
  for (let i = 0; i < count && blockSize >= 3; i++) {
    const block = rest.slice(i * blockSize, (i + 1) * blockSize);
    satellites.push({
      system: block[0],
      prn: block[1],
      status: block[2],
      signalMask: block[3] || '',
    });
  }
  return { satelliteCount: count, satellites };
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

function decodeSatVisSatelliteId(value) {
  const match = String(value || '').match(/^(\d+)([+-]\d+)?$/);
  return {
    prn: match ? match[1] : value,
    gloFrequency: match && match[2] ? Number(match[2]) : 0,
  };
}

function decodeSatVis2Ascii(fields) {
  const system = fields[0] || '';
  const count = num(fields[3]) || 0;
  const rest = fields.slice(4);
  const blockSize = count > 0 ? Math.floor(rest.length / count) : 0;
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
  ITDETECTSTATUS: (fields, message) => interpretItDetectStatus(message),
};

// --- binary decoders --------------------------------------------------------

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

function decodeRxStatusBinary(body) {
  if (body.length < 8) return null;
  const errorWord = body.readUInt32LE(0);
  const statusWord = body.length >= 16 ? body.readUInt32LE(8) : 0;
  return {
    errorWord: errorWord.toString(16).padStart(8, '0'),
    receiverStatusWord: statusWord.toString(16).padStart(8, '0'),
    hasError: errorWord !== 0,
    activeFlags: describeReceiverStatus(statusWord),
  };
}

function decodeRangeBinary(body) {
  if (body.length < 4) return null;
  const count = body.readUInt32LE(0);
  const observations = [];
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * 44;
    if (offset + 44 > body.length) break;
    observations.push({
      prn: body.readUInt16LE(offset),
      gloFrequency: body.readUInt16LE(offset + 2),
      pseudorange: body.readDoubleLE(offset + 4),
      carrierToNoise: body.readFloatLE(offset + 32),
      lockTime: body.readFloatLE(offset + 36),
      trackingStatus: body.readUInt32LE(offset + 40).toString(16).padStart(8, '0'),
      system: systemFromTrackingStatus(body.readUInt32LE(offset + 40)),
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
 * Turns a parsed log into a display record. Binary logs that have no dedicated
 * decoder still produce a record with header/size info so nothing is silently lost.
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

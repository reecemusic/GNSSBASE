'use strict';

// Fake PwrPak: serves the GNSSBASE profile's core logs (ASCII and binary) on a TCP
// port so the viewer can be exercised without hardware.
//   npm run sim
//   NOVATEL_HOST=127.0.0.1 npm start

const net = require('node:net');
const { novatelCrc32, novatelCrc32Buffer } = require('../src/novatel');

const PORT = Number(process.env.SIM_PORT || 3001);
const HOST = process.env.SIM_HOST || '127.0.0.1';
const WEEK = 2222;

const BASE_LAT = 51.1163;
const BASE_LON = -114.0387;
const BASE_HGT = 1064.5;

function ascii(name, week, seconds, body) {
  const sentence = `${name}A,COM1,0,72.5,FINESTEERING,${week},${seconds.toFixed(3)},02000020,0000,32768;${body}`;
  return Buffer.from(`#${sentence}*${novatelCrc32(sentence).toString(16).padStart(8, '0')}\r\n`, 'ascii');
}

function binary(messageId, week, seconds, body) {
  const frame = Buffer.alloc(28 + body.length + 4);
  frame[0] = 0xaa; frame[1] = 0x44; frame[2] = 0x12; frame[3] = 28;
  frame.writeUInt16LE(messageId, 4);
  frame[6] = 0x00; // message type: binary, original
  frame[7] = 0x20;
  frame.writeUInt16LE(body.length, 8);
  frame.writeUInt16LE(0, 10);
  frame[12] = 145;
  frame[13] = 180; // FINESTEERING
  frame.writeUInt16LE(week, 14);
  frame.writeUInt32LE(Math.round(seconds * 1000), 16);
  frame.writeUInt32LE(0x02000020, 20);
  frame.writeUInt16LE(32768, 26);
  body.copy(frame, 28);
  frame.writeUInt32LE(novatelCrc32Buffer(frame, 0, frame.length - 4), frame.length - 4);
  return frame;
}

function bestPosBinary(week, seconds) {
  const body = Buffer.alloc(72);
  body.writeUInt32LE(0, 0); // SOL_COMPUTED
  body.writeUInt32LE(50, 4); // NARROW_INT
  body.writeDoubleLE(BASE_LAT + (Math.random() - 0.5) * 1e-7, 8);
  body.writeDoubleLE(BASE_LON + (Math.random() - 0.5) * 1e-7, 16);
  body.writeDoubleLE(BASE_HGT + (Math.random() - 0.5) * 0.02, 24);
  body.writeFloatLE(-16.27, 32);
  body.writeUInt32LE(61, 36);
  body.writeFloatLE(0.008, 40);
  body.writeFloatLE(0.007, 44);
  body.writeFloatLE(0.014, 48);
  body.write('BASE', 52, 4, 'ascii');
  body.writeFloatLE(1.0, 56);
  body.writeFloatLE(0.0, 60);
  body[64] = 31; body[65] = 28; body[66] = 28; body[67] = 26;
  return binary(42, week, seconds, body);
}

function rangeAscii(week, seconds) {
  const tracked = trackedSats();
  const parts = [String(tracked.length)];
  for (const { system, sat, cno } of tracked) {
    // RANGE reports GLONASS as slot + 37.
    const prn = system === 'GLONASS' ? sat.prn + 37 : sat.prn;
    parts.push(String(prn), '0', (20000000 + Math.random() * 5e6).toFixed(3), '0.050',
      '-12345678.9', '0.008', '-1234.5', cno.toFixed(3), (1000 + Math.random() * 2000).toFixed(3),
      trackingStatus(system).toString(16).padStart(8, '0'));
  }
  return ascii('RANGE', week, seconds, parts.join(','));
}

// Signal types spread across the bands the viewer groups by.
const IT_SIGNALS = [
  ['GPSL1', 1575.42e6],
  ['GPSL2', 1227.60e6],
  ['GPSL5', 1176.45e6],
  ['SBASL1', 1575.42e6],
  ['GALE6', 1278.75e6],
  ['NAVICS', 2492.028e6],
];

function itDetectAscii(week, seconds, signalType, centerHz) {
  const detections = Math.random() < 0.65 ? 0 : 1 + Math.floor(Math.random() * 2);
  const parts = [signalType, String(detections)];
  for (let i = 0; i < detections; i++) {
    parts.push(i % 2 ? 'CW' : 'NBAND',
      String(Math.round(centerHz + (Math.random() - 0.5) * 2e6)),
      String(1000 * (10 + Math.floor(Math.random() * 90))),
      String(-(85 + Math.random() * 40).toFixed(1)), 'TRUE');
  }
  return ascii('ITDETECTSTATUS', week, seconds, parts.join(','));
}

const EPHEMERIS_LOGS = [
  ['GPSEPHEM', 32], ['GLOEPHEMERIS', 24], ['GALINAVEPHEMERIS', 36],
  ['GALFNAVEPHEMERIS', 36], ['BDSEPHEMERIS', 46], ['QZSSEPHEMERIS', 7], ['NAVICEPHEMERIS', 14],
];

// Stable constellation so the skyplot drifts instead of jumping each update.
const CONSTELLATIONS = [
  ['GPS', 10], ['GLONASS', 7], ['GALILEO', 8], ['BEIDOU', 9], ['QZSS', 2], ['SBAS', 2],
];

const SKY = CONSTELLATIONS.map(([system, count]) => ({
  system,
  sats: Array.from({ length: count }, (unused, i) => ({
    prn: system === 'GLONASS' ? 1 + i : system === 'SBAS' ? 131 + i : 1 + i,
    elevation: 5 + Math.random() * 80,
    azimuth: Math.random() * 360,
    rate: (Math.random() - 0.5) * 0.4,
    health: Math.random() < 0.06 ? '1' : '0',
  })),
}));

const SYSTEM_CODE = { GPS: 0, GLONASS: 1, SBAS: 2, GALILEO: 3, BEIDOU: 4, QZSS: 5 };

function trackingStatus(system) {
  return ((0x08109c04 & ~(0x7 << 16)) | (SYSTEM_CODE[system] << 16)) >>> 0;
}

/** Satellites above 10 degrees are "tracked"; C/No rises with elevation. */
function trackedSats() {
  const out = [];
  for (const entry of SKY) {
    for (const sat of entry.sats) {
      if (sat.elevation < 10) continue;
      out.push({
        system: entry.system,
        sat,
        cno: 30 + (sat.elevation / 90) * 20 + Math.random() * 2,
      });
    }
  }
  return out;
}

function satVisAscii(week, seconds, entry) {
  const parts = [entry.system, 'TRUE', 'FALSE', String(entry.sats.length)];
  for (const sat of entry.sats) {
    sat.azimuth = (sat.azimuth + sat.rate + 360) % 360;
    sat.elevation = Math.max(0, Math.min(89, sat.elevation + sat.rate / 4));
    parts.push(String(sat.prn), sat.health, sat.elevation.toFixed(1), sat.azimuth.toFixed(1), '0.000', '0.000');
  }
  return ascii('SATVIS2', week, seconds, parts.join(','));
}

function bestSatsAscii(week, seconds) {
  const tracked = trackedSats();
  const parts = [String(tracked.length)];
  for (const { system, sat } of tracked) {
    const status = sat.health !== '0' ? 'BADHEALTH'
      : sat.elevation < 15 ? 'ELEVATIONERROR'
      : system === 'SBAS' ? 'NOTUSED'
      : 'GOOD';
    parts.push(system, String(sat.prn), status, '0000000f');
  }
  return ascii('BESTSATS', week, seconds, parts.join(','));
}

const server = net.createServer((socket) => {
  console.log(`[sim] client connected from ${socket.remoteAddress}`);
  let seconds = 243000;
  let tick = 0;

  socket.on('data', (data) => {
    for (const line of data.toString('ascii').split(/\r?\n/).filter(Boolean)) {
      console.log(`[sim] command: ${line}`);
    }
    socket.write('<OK\r\n');
  });

  socket.write(ascii('VERSION', WEEK, seconds,
    '2,GPSCARD,"FDNRNNTBN","BMHR17140021P","OEM7700-1.00","OEM7MR0801RN0000","OEM060S0008","2021/Jan/28","15:29:47",'
    + 'DB_WWWDB,"WWWDB","0","0.000","WMC020201RN0001","","2021/Jan/28","15:31:01"'));
  for (const entry of SKY) socket.write(satVisAscii(WEEK, seconds, entry));

  const timer = setInterval(() => {
    seconds += 1;
    tick += 1;

    socket.write(bestPosBinary(WEEK, seconds));
    socket.write(ascii('BESTGNSSPOS', WEEK, seconds,
      `SOL_COMPUTED,NARROW_INT,${(BASE_LAT).toFixed(11)},${(BASE_LON).toFixed(11)},${BASE_HGT.toFixed(4)},`
      + '-16.2712,WGS84,0.0081,0.0074,0.0139,"BASE",1.000,0.000,31,28,28,26,00,06,39,33'));

    if (tick % 5 === 0) socket.write(rangeAscii(WEEK, seconds));
    if (tick % 10 === 1) for (const entry of SKY) socket.write(satVisAscii(WEEK, seconds, entry));
    socket.write(bestSatsAscii(WEEK, seconds));

    for (const [signalType, centerHz] of IT_SIGNALS) {
      if (Math.random() < 0.4) socket.write(itDetectAscii(WEEK, seconds, signalType, centerHz));
    }

    if (tick % 3 === 0) {
      const [name, maxPrn] = EPHEMERIS_LOGS[tick % EPHEMERIS_LOGS.length];
      socket.write(ascii(name, WEEK, seconds, `${1 + Math.floor(Math.random() * maxPrn)},${seconds.toFixed(1)},0,TRUE`));
    }

    if (tick % 10 === 0) {
      const jammer = Math.random() < 0.3 ? 1 << 15 : 0;
      socket.write(ascii('RXSTATUS', WEEK, seconds,
        `00000000,4,${(0x00000020 | jammer).toString(16).padStart(8, '0')},00000000,00000000,00000000`));
    }
  }, 1000);

  socket.on('close', () => clearInterval(timer));
  socket.on('error', () => clearInterval(timer));
});

server.listen(PORT, HOST, () => console.log(`[sim] listening on ${HOST}:${PORT}`));

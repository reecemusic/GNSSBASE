/**
 * Scans NovAtel receiver logs stored on an SMB/NAS share.
 *
 * Logs live in YYYY/DDD folders under the archive root (DDD is the day of
 * year). The scanner keeps bounded summaries of interference (ITDETECTSTATUS),
 * BESTPOS, and BESTSATS, gzip-caches each summary as JSON, and
 * InterferenceArchive emits 'status' while a load progresses.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const {
  parseAsciiLog, interpretItDetectStatus, decodeItDetectStatusBinary, novatelCrc32Buffer, gpsToMs,
} = require('./novatel');
const { decode } = require('./messages');
const { logLimited } = require('./loglimit');
const { solutionSample, replaceFile } = require('./history');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DAY_MS = 86400000;
const IT_MESSAGE_ID = 2065;
const BESTPOS_MESSAGE_ID = 42;
const BESTSATS_MESSAGE_ID = 1194;
const LONG_HEADER_LENGTH = 28;
const MAX_FRAME_BYTES = 1 << 16;
const MAX_ASCII_LINE_BYTES = 16 * 1024;
const SYNC = Buffer.from([0xaa, 0x44, 0x12]);
const ASCII_MARKERS = [Buffer.from('#ITDETECTSTATUSA,'), Buffer.from('#BESTPOSA,'), Buffer.from('#BESTSATSA,'),
  // Abbreviated ASCII ("LOG BESTSATS"): '<NAME header' then one '<   fields' line per row, without a CRC.
  Buffer.from('<ITDETECTSTATUS '), Buffer.from('<BESTPOS '), Buffer.from('<BESTSATS ')];
const MAX_ABBREVIATED_BYTES = 32 * 1024;
const ASCII_CARRY_BYTES = Math.max(...ASCII_MARKERS.map((marker) => marker.length));
// Reports further apart than this are treated as a gap in coverage, matching the live timeline.
const COVERAGE_GAP_MS = 15000;
const CACHE_VERSION = 5;
const SOLUTION_HOLD_MS = 35000;
const MAX_SOLUTION_SAMPLES = 300000;
const MAX_DETECTIONS_PER_SAMPLE = 32;
const MAX_ERRORS = 20;
const MAX_QUERY_BUCKETS = 4000;
const READ_CHUNK_BYTES = 1 << 20;
// Case-insensitive suffix _YYYY-MM-DD_HH-MM-SS.LOG. fileNameTime reads it as UTC.
const FILE_NAME_TIME = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.LOG$/i;
// File names and day folders may use local time; allow for any time zone offset.
const FILE_TIME_TOLERANCE_MS = 14 * 3600000;
const PROGRESS_INTERVAL_MS = 500;
// While a background refresh runs, these come from the refresh; everything else describes the shown data.
const PROGRESS_FIELDS = ['state', 'filesTotal', 'filesDone', 'filesCached', 'filesSkipped', 'bytesTotal', 'bytesDone',
  'currentFile', 'message', 'errors', 'startedAt'];
const DATA_FIELDS = ['coverage', 'samples', 'solution', 'solutionResolutionMs', 'bestsats', 'bestsatsResolutionMs',
  'sorted', 'resolutionMs'];
const NETWORK_ERRORS = new Set(['EIO', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH',
  'ENOTCONN', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'UNKNOWN']);

/**
 * Builds an Error that archive loading treats as a failed load rather than a per-file skip.
 * @param {string} message Error text.
 * @returns {Error} The error, with `fatal` set true.
 * Side effects: none. Does not throw.
 * Events: none.
 */
function fatalError(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

/**
 * Reports whether sample `a` should replace `b` as the strongest sample in a bucket.
 * A sample with count > 0 beats a sample whose count is not > 0. Otherwise a finite
 * maxPower beats a missing one, a higher maxPower wins, and then the higher count wins.
 * @param {{count: number, maxPower: number|null}} a Candidate sample.
 * @param {{count: number, maxPower: number|null}} b Sample already kept.
 * @returns {boolean} True when `a` replaces `b`. Equal count and power returns false.
 * Side effects: none.
 * Events: none.
 */
function stronger(a, b) {
  if ((a.count > 0) !== (b.count > 0)) return a.count > 0;
  const aPower = Number.isFinite(a.maxPower);
  const bPower = Number.isFinite(b.maxPower);
  if (aPower !== bPower) return aPower;
  if (aPower && a.maxPower !== b.maxPower) return a.maxPower > b.maxPower;
  return a.count > b.count;
}

/**
 * Collapses intervals into buckets of `resolutionMs`, keeping contiguous reporting only.
 * The bucket key is Math.floor(sample.t / resolutionMs). When the previous interval in
 * that bucket ends at or after sample.t, the bucket keeps the previous start, takes the
 * newer sample's other fields, and extends end to the later end. When sample.t is past
 * the previous end, the bucket is replaced by sample, so the gap is not bridged.
 * Used for BESTPOS and BESTSATS intervals.
 * @param {Array<{t: number, end: number}>} samples Intervals in fold order.
 * @param {number} resolutionMs Bucket width in milliseconds.
 * @returns {Array<object>} One interval per occupied bucket, in first-seen key order.
 * Side effects: none.
 * Events: none.
 */
function reduceSolutions(samples, resolutionMs) {
  const kept = new Map();
  for (const sample of samples) {
    const key = Math.floor(sample.t / resolutionMs);
    const previous = kept.get(key);
    kept.set(key, previous && previous.end >= sample.t
      ? { ...sample, t: previous.t, end: Math.max(previous.end, sample.end) } : sample);
  }
  return [...kept.values()];
}

/**
 * Converts one ITDETECTSTATUS report into per-signal samples in the live-history shape.
 * Detections are grouped by signalType, or 'OTHER' when signalType is missing. count is
 * the group length. maxPower is the max finite powerDbm, or null. freq is the first
 * detection's centerFrequencyHz, or null. detections keeps at most
 * MAX_DETECTIONS_PER_SAMPLE entries, each with freq, bandwidth, power, and type.
 * @param {number} t Report time in milliseconds.
 * @param {Array<object>} detections Detections on that report.
 * @returns {Array<object>} One sample per signal present in the report.
 * Side effects: none.
 * Events: none.
 */
function reportSamples(t, detections) {
  const bySignal = new Map();
  for (const detection of detections) {
    const signal = detection.signalType || 'OTHER';
    const list = bySignal.get(signal) || [];
    list.push(detection);
    bySignal.set(signal, list);
  }
  const samples = [];
  for (const [signal, list] of bySignal) {
    const powers = list.map((d) => d.powerDbm).filter(Number.isFinite);
    samples.push({
      t,
      signal,
      count: list.length,
      maxPower: powers.length ? Math.max(...powers) : null,
      freq: Number.isFinite(list[0].centerFrequencyHz) ? list[0].centerFrequencyHz : null,
      detections: list.slice(0, MAX_DETECTIONS_PER_SAMPLE).map((d) => ({
        freq: Number.isFinite(d.centerFrequencyHz) ? d.centerFrequencyHz : null,
        bandwidth: Number.isFinite(d.bandwidthHz) ? d.bandwidthHz : null,
        power: Number.isFinite(d.powerDbm) ? d.powerDbm : null,
        type: d.type || '',
      })),
    });
  }
  return samples;
}

/**
 * Bounded per-file summary: ITDETECTSTATUS coverage and the strongest detection per
 * signal per second, plus BESTPOS solution intervals and BESTSATS counts.
 * Not an EventEmitter. Methods mutate the summary and emit nothing.
 * @param {number} [maxSolutions=MAX_SOLUTION_SAMPLES] Constructor cap on solution intervals before coarsening.
 * @returns {FileSummary} The constructed summary.
 * Side effects: the constructor initializes empty coverage, samples, solution, and bestsats holders. No I/O.
 * Events: none.
 */
class FileSummary {
  /**
   * Creates an empty summary. Solution intervals coarsen once they pass maxSolutions.
   * @param {number} [maxSolutions=MAX_SOLUTION_SAMPLES] Cap on solution intervals before coarsening.
   * @returns {FileSummary}
   * Side effects: initializes empty coverage, samples, solution, and bestsats holders.
   * Events: none.
   */
  constructor(maxSolutions = MAX_SOLUTION_SAMPLES) {
    this.reportCount = 0;
    this.crcErrors = 0;
    this.coverage = [];
    this.samples = [];
    this.lastBySignal = new Map();
    this.solution = [];
    this.solutionReports = 0;
    this.solutionResolutionMs = 1000;
    this.maxSolutions = maxSolutions;
    this.lastSolution = null;
    this.bestsatsSummary = null;
  }

  /**
   * Records a BESTSATS used-satellite count at time `t`.
   * Creates a nested FileSummary on first use and stores the count as a solution
   * interval whose only populated field is satellitesUsed.
   * @param {number} t Report time in milliseconds.
   * @param {number} used Count passed through to addSolution as satellitesUsed.
   * @returns {void}
   * Side effects: mutates this.bestsatsSummary.
   * Events: none.
   */
  addBestSats(t, used) {
    if (!this.bestsatsSummary) this.bestsatsSummary = new FileSummary(this.maxSolutions);
    this.bestsatsSummary.addSolution(t, { satellitesUsed: used });
  }

  /**
   * Records a BESTPOS-style solution interval.
   * solutionSample returning null leaves the summary unchanged. Otherwise
   * solutionReports increments. When the last interval has the same used, tracked,
   * status, and type and `t` is inside [last.t, last.end], its end moves to
   * t + SOLUTION_HOLD_MS. Otherwise, when a last interval exists and t >= last.t,
   * last.end is clipped to min(last.end, t) and a new interval ending at
   * t + SOLUTION_HOLD_MS is pushed. Past maxSolutions the
   * intervals are sorted and solutionResolutionMs doubles, via reduceSolutions,
   * until the length is at most 75% of maxSolutions.
   * @param {number} t Report time in milliseconds.
   * @param {object} data Fields consumed by solutionSample (satellitesUsed, and so on).
   * @returns {void}
   * Side effects: mutates solution, solutionReports, lastSolution, and maybe solutionResolutionMs.
   * Events: none.
   */
  addSolution(t, data) {
    const sample = solutionSample(data, t);
    if (!sample) return;
    this.solutionReports++;
    const last = this.lastSolution;
    if (last && t >= last.t && t <= last.end && last.used === sample.used
      && last.tracked === sample.tracked && last.status === sample.status && last.type === sample.type) {
      last.end = t + SOLUTION_HOLD_MS;
      return;
    }
    if (last && t >= last.t) last.end = Math.min(last.end, t);
    const interval = { ...sample, end: t + SOLUTION_HOLD_MS };
    this.solution.push(interval);
    this.lastSolution = interval;
    if (this.solution.length > this.maxSolutions) {
      this.solution.sort((a, b) => a.t - b.t);
      do {
        this.solutionResolutionMs *= 2;
        this.solution = reduceSolutions(this.solution, this.solutionResolutionMs);
      } while (this.solution.length > this.maxSolutions * 0.75);
      this.lastSolution = this.solution[this.solution.length - 1];
    }
  }

  /**
   * Records one interference report.
   * A non-finite `t` returns immediately. Otherwise reportCount increments and the
   * last coverage run is extended when `t` is within COVERAGE_GAP_MS of that run;
   * if not, a new [t, t] run is pushed. Each per-signal sample in the same
   * 1-second bucket as the previous sample for that signal (Math.floor(t / 1000))
   * replaces it only when stronger() says so. A new second is appended.
   * @param {number} t Report time in milliseconds.
   * @param {Array<object>} detections Detections passed to reportSamples.
   * @returns {void}
   * Side effects: mutates reportCount, coverage, samples, and lastBySignal.
   * Events: none.
   */
  addReport(t, detections) {
    if (!Number.isFinite(t)) return;
    this.reportCount++;
    const last = this.coverage[this.coverage.length - 1];
    if (last && t >= last[0] - COVERAGE_GAP_MS && t - last[1] <= COVERAGE_GAP_MS) {
      last[0] = Math.min(last[0], t);
      last[1] = Math.max(last[1], t);
    } else {
      this.coverage.push([t, t]);
    }
    for (const sample of reportSamples(t, detections)) {
      const previous = this.lastBySignal.get(sample.signal);
      if (previous && Math.floor(previous.t / 1000) === Math.floor(t / 1000)) {
        if (stronger(sample, previous)) Object.assign(previous, sample);
        continue;
      }
      this.samples.push(sample);
      this.lastBySignal.set(sample.signal, sample);
    }
  }

  /**
   * Plain JSON shape stored in the gzip cache and merged by addSummary.
   * bestsats comes from the nested summary's solution array, or [] when no BESTSATS
   * report has been added. bestsatsResolutionMs is 1000 in that empty case.
   * No parameters.
   * @returns {object} reportCount, crcErrors, coverage, samples, solution, solutionReports,
   *   solutionResolutionMs, bestsats, bestsatsReports, bestsatsResolutionMs.
   * Side effects: none. Does not include lastBySignal or lastSolution.
   * Events: none.
   */
  toJSON() {
    return {
      reportCount: this.reportCount,
      crcErrors: this.crcErrors,
      coverage: this.coverage,
      samples: this.samples,
      solution: this.solution,
      solutionReports: this.solutionReports,
      solutionResolutionMs: this.solutionResolutionMs,
      bestsats: this.bestsatsSummary ? this.bestsatsSummary.solution : [],
      bestsatsReports: this.bestsatsSummary ? this.bestsatsSummary.solutionReports : 0,
      bestsatsResolutionMs: this.bestsatsSummary ? this.bestsatsSummary.solutionResolutionMs : 1000,
    };
  }
}

/**
 * True when `index` begins a log, false when it does not, null when more bytes are required.
 * '#' (0x23) and '<' (0x3c) are boundaries. Any other byte that is not 0xAA is not.
 * 0xAA needs two more bytes: true when they are 0x44 and either 0x12 or 0x13 (a binary
 * sync), null when those bytes are not in the buffer yet, false otherwise.
 * @param {Buffer} buf Buffer to inspect.
 * @param {number} index Index of the candidate first byte.
 * @returns {boolean|null}
 * Side effects: none.
 * Events: none.
 */
function frameBoundary(buf, index) {
  if (index >= buf.length) return null;
  const byte = buf[index];
  if (byte === 0x23 || byte === 0x3c) return true;
  if (byte !== 0xaa) return false;
  if (index + 2 >= buf.length) return null;
  return buf[index + 1] === 0x44 && (buf[index + 2] === 0x12 || buf[index + 2] === 0x13);
}

/**
 * True when a cached or scanned summary has the arrays the merger reads.
 * coverage and samples must be arrays, and every sample needs a finite t.
 * solution and bestsats must be arrays of objects with finite t and end.
 * @param {object|null|undefined} summary Value returned by readCache or toJSON.
 * @returns {boolean} False when summary is missing or any of those checks fail.
 * Side effects: none.
 * Events: none.
 */
function summaryUsable(summary) {
  if (!summary) return false;
  /**
   * True when `samples` is an array and every entry has finite `t` and `end`.
   * @param {object[]|undefined} samples
   * @returns {boolean}
   * Side effects: none. Events: none.
   */
  const finiteEnds = (samples) => Array.isArray(samples)
    && samples.every((sample) => sample && Number.isFinite(sample.t) && Number.isFinite(sample.end));
  return Array.isArray(summary.coverage)
    && Array.isArray(summary.samples)
    && summary.samples.every((sample) => sample && Number.isFinite(sample.t))
    && finiteEnds(summary.solution)
    && finiteEnds(summary.bestsats);
}

/**
 * Incremental scanner for one NovAtel log. Decodes only ITDETECTSTATUS, BESTPOS,
 * and BESTSATS. Other binary frames are skipped by their declared length only when
 * frameBoundary accepts the following bytes, without CRC work.
 * push() consumes chunks. end() finishes a carried tail at EOF.
 * @param {FileSummary} summary Summary mutated as reports are accepted.
 * @returns {{push: function(Buffer): void, end: function(): void}}
 * Side effects: none until push or end is called. Those mutate `summary`.
 * Events: none.
 */
function createItDetectScanner(summary) {
  let carry = null;

  /**
   * Decodes one binary frame that the sync loop already classified as ITDETECTSTATUS,
   * BESTPOS, or BESTSATS.
   * Returns immediately, before the CRC check, when the low 5 bits of header byte 6
   * are nonzero (marked in source as the secondary antenna). A CRC32 that does not
   * equal the trailer uint32 increments crcErrors and returns; the report is not
   * stored. GPS week 0 returns without storing. Week is the uint16 at offset 14.
   * The uint32 at offset 16 is milliseconds and is passed to gpsToMs as seconds (divided by 1000).
   * BESTSATS requires a count of 0..255 and a body of 4 + count * 16 bytes, then
   * counts records whose uint32 at offset 12 is 0 and calls addBestSats.
   * BESTPOS requires a body of at least 72 bytes, then decode() and addSolution.
   * A BESTPOS decode error propagates. ITDETECTSTATUS uses decodeItDetectStatusBinary;
   * a thrown decode increments crcErrors, logs a warning, and returns.
   * Shape failures on BESTSATS and BESTPOS also increment crcErrors and return.
   * @param {Buffer} buf Chunk that contains the frame.
   * @param {number} start Index of the AA 44 12 sync.
   * @param {number} total Frame length in bytes, including the 4-byte CRC.
   * @returns {void}
   * Side effects: mutates `summary` and may console.warn.
   * Events: none.
   */
  function handleBinary(buf, start, total) {
    if ((buf[start + 6] & 0x1f) !== 0) return; // secondary antenna (ITDETECTSTATUS_1)
    // Counted binary samples require the CRC32 of the frame to equal the trailer uint32.
    // A mismatch increments crcErrors and returns. There is no null-checksum path here.
    if (novatelCrc32Buffer(buf, start, start + total - 4) !== buf.readUInt32LE(start + total - 4)) {
      summary.crcErrors++;
      return;
    }
    const week = buf.readUInt16LE(start + 14);
    if (week === 0) return;
    const t = gpsToMs(week, buf.readUInt32LE(start + 16) / 1000);
    const body = buf.subarray(start + LONG_HEADER_LENGTH, start + total - 4);
    const messageId = buf.readUInt16LE(start + 4);
    if (messageId === BESTSATS_MESSAGE_ID) {
      const count = body.length >= 4 ? body.readUInt32LE(0) : -1;
      if (count < 0 || count > 255 || body.length !== 4 + count * 16) {
        summary.crcErrors++;
        return;
      }
      let used = 0;
      for (let index = 0; index < count; index++) {
        if (body.readUInt32LE(12 + index * 16) === 0) used++;
      }
      summary.addBestSats(t, used);
    } else if (messageId === BESTPOS_MESSAGE_ID) {
      if (body.length < 72) {
        summary.crcErrors++;
        return;
      }
      summary.addSolution(t, decode({ format: 'binary', header: { messageName: 'BESTPOS' }, body }).data);
    } else {
      let data;
      try {
        data = decodeItDetectStatusBinary(body);
      } catch (error) {
        summary.crcErrors++;
        console.warn(`[archive] skipping invalid binary ITDETECTSTATUS report: ${error.message}`);
        return;
      }
      summary.addReport(t, data.detections);
    }
  }

  /**
   * Decodes one ASCII log line (a '#' sentence, or an abbreviated block already
   * rewritten by abbreviatedToAscii).
   * The gate is `!parsed || parsed.crcValid === false`. That rejects a failed parse
   * and a checksum that failed. It does not require crcValid === true. crcValid
   * null (no '*' checksum, which is what abbreviatedToAscii produces) continues
   * and can be stored when the rest of the line is valid. crcValid true continues
   * the same way. A false checksum increments crcErrors and is not stored.
   * A falsy header.week, including week 0, returns without storing and without a crcErrors increment.
   * BESTSATS requires an integer count of 0..255 and 1 + count * 4 fields, then
   * counts decoded satellites whose status is 'GOOD'. BESTPOS requires at least
   * 15 fields, then decode() and addSolution (a decode error propagates).
   * Any other name is interpreted as ITDETECTSTATUS. A thrown interpret or
   * BESTSATS decode increments crcErrors, logs a warning, and returns.
   * @param {string} line One log line, without a trailing checksum for abbreviated input.
   * @returns {void}
   * Side effects: mutates `summary` and may console.warn.
   * Events: none.
   */
  function handleAscii(line) {
    const parsed = parseAsciiLog(line);
    // Reject a failed parse or crcValid === false (not stored; crcErrors++).
    // crcValid === null is not this check: abbreviated ASCII has no checksum and can be stored.
    // crcValid === true also continues and can be stored.
    if (!parsed || parsed.crcValid === false) {
      summary.crcErrors++;
      return;
    }
    if (!parsed.header.week) return;
    const t = gpsToMs(parsed.header.week, parsed.header.seconds);
    if (parsed.header.messageName === 'BESTSATS') {
      const count = Number(parsed.fields[0]);
      if (!Number.isInteger(count) || count < 0 || count > 255 || parsed.fields.length !== 1 + count * 4) {
        summary.crcErrors++;
        return;
      }
      let data;
      try {
        data = decode(parsed).data;
      } catch (error) {
        summary.crcErrors++;
        console.warn(`[archive] skipping invalid BESTSATS report: ${error.message}`);
        return;
      }
      summary.addBestSats(t, data.satellites.filter((satellite) => satellite.status === 'GOOD').length);
    } else if (parsed.header.messageName === 'BESTPOS') {
      if (parsed.fields.length < 15) {
        summary.crcErrors++;
        return;
      }
      summary.addSolution(t, decode(parsed).data);
    } else {
      let data;
      try {
        data = interpretItDetectStatus(parsed);
      } catch (error) {
        summary.crcErrors++;
        console.warn(`[archive] skipping invalid ASCII ITDETECTSTATUS report: ${error.message}`);
        return;
      }
      summary.addReport(t, data.detections);
    }
  }

  /**
   * Scans one chunk joined to any carried tail.
   * Binary candidates match the AA 44 12 sync. Header byte 3 must be 28
   * (LONG_HEADER_LENGTH). Message length is the uint16 at offset 8. Total size
   * is that header length plus the message length plus 4 CRC bytes. A header
   * length other than 28, or a total above MAX_FRAME_BYTES, steps one byte.
   * Only ITDETECTSTATUS, BESTPOS, and BESTSATS ids are decoded. Any other id
   * is skipped by its declared length only when frameBoundary says the next
   * bytes are '#', '<', or a binary sync. Otherwise the scan steps one byte.
   * If that declared length reaches the end of the buffer, or a target frame's
   * length runs past the buffer, the tail from the sync is carried.
   * '#' markers are read through the next LF. A '<' marker is an abbreviated
   * block (abbreviatedEnd / abbreviatedToAscii). A marker with no terminator
   * that is still under the size cap is carried; past the cap the scan steps one byte.
   * When neither a sync nor an ASCII marker remains, at most ASCII_CARRY_BYTES of the
   * unscanned tail is carried so a marker split across chunks survives.
   * @param {Buffer} input Next chunk from the file.
   * @returns {void}
   * Side effects: mutates `summary` via handleBinary / handleAscii, and the carry buffer.
   * Events: none.
   */
  function push(input) {
    const chunk = input;
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    carry = null;
    let i = 0;
    const nextAscii = ASCII_MARKERS.map(() => -2);
    let nextSync = -2;
    /**
     * Index of the nearest ASCII marker at or after `from`, or -1 when none remains.
     * @param {number} from First index to consider.
     * @returns {number}
     * Side effects: refreshes the nextAscii cache for markers that were before `from`.
     * Events: none.
     */
    const asciiFrom = (from) => {
      let nearest = -1;
      for (let index = 0; index < ASCII_MARKERS.length; index++) {
        if (nextAscii[index] !== -1 && nextAscii[index] < from) {
          nextAscii[index] = buf.indexOf(ASCII_MARKERS[index], from);
        }
        if (nextAscii[index] >= 0 && (nearest === -1 || nextAscii[index] < nearest)) nearest = nextAscii[index];
      }
      return nearest;
    };

    for (;;) {
      if (nextSync !== -1 && nextSync < i) nextSync = buf.indexOf(SYNC, i);
      const sync = nextSync;
      const ascii = asciiFrom(i);
      if (sync === -1 && ascii === -1) {
        carry = Buffer.from(buf.subarray(Math.max(i, buf.length - ASCII_CARRY_BYTES)));
        return;
      }
      if (ascii !== -1 && (sync === -1 || ascii < sync)) {
        // Abbreviated ASCII starts with '<'. Continuation lines are also '<'.
        // abbreviatedToAscii rewrites the block as an unchecksummed #NAMEA line.
        if (buf[ascii] === 0x3c) {
          const end = abbreviatedEnd(buf, ascii);
          if (end === -1) {
            if (buf.length - ascii > MAX_ABBREVIATED_BYTES) {
              i = ascii + 1;
              continue;
            }
            carry = Buffer.from(buf.subarray(ascii));
            return;
          }
          handleAscii(abbreviatedToAscii(buf.toString('latin1', ascii, end)));
          i = end;
          continue;
        }
        const newline = buf.indexOf(0x0a, ascii);
        if (newline === -1) {
          if (buf.length - ascii > MAX_ASCII_LINE_BYTES) {
            i = ascii + 1;
            continue;
          }
          carry = Buffer.from(buf.subarray(ascii));
          return;
        }
        handleAscii(buf.toString('latin1', ascii, newline));
        i = newline + 1;
        continue;
      }
      // Fewer than 28 header bytes remain after the sync: carry the tail.
      if (buf.length - sync < LONG_HEADER_LENGTH) {
        carry = Buffer.from(buf.subarray(sync));
        return;
      }
      // AA 44 12. Byte 3 is the header length. Message length is the uint16 at offset 8.
      // total = headerLength + messageLength + 4 CRC bytes.
      const total = buf[sync + 3] + buf.readUInt16LE(sync + 8) + 4;
      // Require header length 28 and a total that fits in MAX_FRAME_BYTES. Otherwise step one byte.
      if (buf[sync + 3] !== LONG_HEADER_LENGTH || total > MAX_FRAME_BYTES) {
        i = sync + 1;
        continue;
      }
      const messageId = buf.readUInt16LE(sync + 4);
      // Decode only ITDETECTSTATUS, BESTPOS, and BESTSATS. Other ids are not CRC-checked.
      if (messageId !== IT_MESSAGE_ID && messageId !== BESTPOS_MESSAGE_ID && messageId !== BESTSATS_MESSAGE_ID) {
        // Declared length reaches or passes the end of this buffer, so the next byte is unavailable. Carry the tail.
        if (sync + total >= buf.length) {
          carry = Buffer.from(buf.subarray(sync));
          return;
        }
        // Skip the frame only when the next bytes are '#', '<', or a binary sync.
        // frameBoundary false: step one byte. null: more bytes are required, so carry the tail.
        const boundary = frameBoundary(buf, sync + total);
        if (boundary === null) {
          carry = Buffer.from(buf.subarray(sync));
          return;
        }
        i = boundary ? sync + total : sync + 1;
        continue;
      }
      // A target frame whose declared length runs past the buffer: carry the tail.
      if (sync + total > buf.length) {
        carry = Buffer.from(buf.subarray(sync));
        return;
      }
      handleBinary(buf, sync, total);
      i = sync + total;
    }
  }

  /**
   * True when `buf` begins with a long header (AA 44 12), header byte 3 is 28,
   * and total = headerLength + uint16 message length at offset 8 + 4 is within
   * MAX_FRAME_BYTES and greater than buf.length. The message id is not consulted.
   * @param {Buffer|null} buf Carried tail.
   * @returns {boolean}
   * Side effects: none.
   * Events: none.
   */
  function declaredLengthOverruns(buf) {
    if (!buf || buf.length < LONG_HEADER_LENGTH) return false;
    if (buf[0] !== 0xaa || buf[1] !== 0x44 || buf[2] !== 0x12 || buf[3] !== LONG_HEADER_LENGTH) return false;
    const total = buf[3] + buf.readUInt16LE(8) + 4;
    return total <= MAX_FRAME_BYTES && total > buf.length;
  }

  /**
   * Finishes the carried tail at EOF, then clears it.
   * A carried block that starts with '<' and already contains a newline is completed
   * through abbreviatedToAscii and handleAscii. A block that starts with '<' but has
   * no newline is not completed.
   * When declaredLengthOverruns is true (long header, header length 28, total <=
   * MAX_FRAME_BYTES and total > the bytes held), the first byte is dropped and the
   * rest is pushed, so a lied length cannot swallow the tail. The loop also stops
   * when the carry does not shrink, and after carry.length passes.
   * No parameters.
   * @returns {void}
   * Side effects: may call handleAscii and push, which mutate `summary`, then sets carry to null.
   * Events: none.
   */
  function end() {
    // Stop after this many passes even when each pass shrinks the carry.
    let guard = carry ? carry.length : 0;
    while (carry && carry.length && guard-- > 0) {
      // EOF: a carried '<' block that already contains a newline is complete.
      if (carry[0] === 0x3c && carry.indexOf(0x0a) !== -1) {
        handleAscii(abbreviatedToAscii(carry.toString('latin1')));
        break;
      }
      // Not a long header whose declared length runs past the bytes we hold.
      if (!declaredLengthOverruns(carry)) break;
      // Drop the first byte and rescan the rest so a lied length cannot swallow the tail.
      const next = Buffer.from(carry.subarray(1));
      carry = null;
      push(next);
      // Guard: stop if this rescan did not shrink the carry.
      if (carry && carry.length >= next.length) break;
    }
    carry = null;
  }

  return { push, end };
}

/**
 * Index just past an abbreviated ASCII block that starts at `start`, or -1 when
 * the buffer may still end inside the block or the block exceeds MAX_ABBREVIATED_BYTES.
 * The block starts with '<' and continues while the next line starts with '<'
 * followed by a space (0x20) or a tab (0x09). A line that does not continue the
 * block ends it at the first byte of that line. Fewer than two bytes after a
 * newline, or no further newline, returns -1.
 * @param {Buffer} buf Buffer containing the block.
 * @param {number} start Index of the opening '<'.
 * @returns {number}
 * Side effects: none.
 * Events: none.
 */
function abbreviatedEnd(buf, start) {
  let newline = buf.indexOf(0x0a, start);
  while (newline !== -1) {
    const next = newline + 1;
    if (next + 1 >= buf.length) return -1;
    // A continuation line is '<' followed by a space or a tab. Anything else ends the block.
    if (buf[next] !== 0x3c || (buf[next + 1] !== 0x20 && buf[next + 1] !== 0x09)) return next;
    if (next - start > MAX_ABBREVIATED_BYTES) return -1;
    newline = buf.indexOf(0x0a, next);
  }
  return -1;
}

/**
 * Rewrites an abbreviated ASCII block as one unchecksummed '#NAMEA,header;fields' line.
 * Lines that start with '<' are kept. The first line, with the '<' removed, is the
 * header (message name, then header fields). Later lines are continuation rows of
 * fields. The result has no '*' checksum, so parseAsciiLog sets crcValid to null.
 * That null checksum is accepted by this archive scanner's handleAscii. This rewrite
 * exists for the archive scanner only.
 * @param {string} text Abbreviated block, including its newlines.
 * @returns {string} A '#' ASCII line with no checksum.
 * Side effects: none.
 * Events: none.
 */
function abbreviatedToAscii(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('<'));
  const header = lines[0].slice(1).trim().split(/\s+/);
  const fields = lines.slice(1).flatMap((line) => line.slice(1).trim().split(/\s+/)).filter(Boolean);
  // No '*' checksum. parseAsciiLog yields crcValid null, which handleAscii in this scanner accepts.
  return `#${header[0]}A,${header.slice(1).join(',')};${fields.join(',')}`;
}

/**
 * UTC time from a log file name, or null when the name does not match.
 * FILE_NAME_TIME is the case-insensitive suffix _YYYY-MM-DD_HH-MM-SS.LOG.
 * The calendar fields are read with Date.UTC (month is 1-based in the name).
 * @param {string} name String whose suffix is tested against FILE_NAME_TIME.
 * @returns {number|null} Milliseconds since the UTC epoch, or null when the suffix
 *   does not match or Date.UTC is not finite.
 * Side effects: none.
 * Events: none.
 */
function fileNameTime(name) {
  const match = FILE_NAME_TIME.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const t = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(t) ? t : null;
}

/**
 * Checks an archive root before it is stored or listed.
 * The trimmed value must be non-empty, at most 400 characters, free of NUL,
 * and an absolute path.
 * @param {string} root Candidate archive root.
 * @returns {string} The trimmed path.
 * Side effects: none. Throws Error when the check fails.
 * Events: none.
 */
function validateRoot(root) {
  const value = String(root || '').trim();
  if (!value || value.length > 400 || value.includes('\0')) throw new Error('Archive folder must be a non-empty path');
  if (!path.isAbsolute(value)) throw new Error('Archive folder must be an absolute path such as \\\\20.20.20.1\\novatel\\pwrpak1');
  return value;
}

/**
 * Historic interference archive read from an SMB/NAS tree of NovAtel logs
 * at root/YYYY/DDD/*.LOG (DDD is the day of year). Files are scanned one at
 * a time. Bounded ITDETECTSTATUS, BESTPOS, and BESTSATS summaries are
 * gzip-cached, so an unchanged file is not read from the share again.
 *
 * Extends EventEmitter. The only event this class emits is 'status', and
 * only update() calls emit. Other methods emit 'status' only by calling update().
 * @param {object} [options] Constructor overrides. See the constructor for each field.
 * @returns {InterferenceArchive} The constructed archive.
 * Side effects: the constructor may read the settings file and initializes idle state. It does not emit.
 * Events: emits 'status' via update().
 */
class InterferenceArchive extends EventEmitter {
  /**
   * Copies options over the defaults, reads settings, and resets to idle.
   * Does not schedule automatic refresh; startAuto() does that when settings.auto is set.
   * @param {object} [options] Overrides for defaultRoot, defaultDays, maxDays, maxSamples,
   *   maxFiles, maxCacheFiles, cacheDir, settingsFile, defaultAuto, refreshMs, busyRetryMs,
   *   fsTimeoutMs, stallTimeoutMs, hungResetMs, and now.
   * @returns {InterferenceArchive}
   * Side effects: may read the settings file. Initializes counters, state, and settings.
   * Events: none. Does not emit 'status'.
   */
  constructor(options) {
    super();
    this.options = {
      defaultRoot: '\\\\20.20.20.1\\novatel\\pwrpak1',
      defaultDays: 1,
      maxDays: 31,
      maxSamples: 300000,
      maxFiles: 2000,
      maxCacheFiles: 5000,
      cacheDir: null,
      settingsFile: null,
      // Automatic refresh keeps the selected window (default 24 h) loaded and rolling forward.
      defaultAuto: false,
      refreshMs: 15 * 60000,
      busyRetryMs: 60000,
      // A NAS that stops answering must never wedge loading: fs calls and stalled reads are abandoned.
      fsTimeoutMs: 20000,
      stallTimeoutMs: 120000,
      // A call that never settles must not block later loads forever. The OS request is not cancelled.
      hungResetMs: 10 * 60 * 1000,
      // A stream that never emits 'close' used to leave stuckHandles at 1 forever,
      // so assertAvailable and autoTick refused every later load. Age it out at
      // three hung-reset intervals unless the caller sets stuckHandleMs. The OS
      // read is not cancelled; the counter is what lets the next scan start.
      stuckHandleMs: null,
      now: () => Date.now(),
      ...options,
    };
    this.generation = 0;
    this.dataGeneration = 0;
    this.view = null;
    this.hung = 0;
    this.pendingFs = 0;
    this.stuckHandles = 0;
    this.autoTimer = null;
    this.autoState = { lastRunAt: null, nextRunAt: null, lastError: null };
    // Clock time of the last listing or scan that reached the share. An error
    // leaves this alone so the page can say when the NAS was last reachable.
    this.lastReachableAt = null;
    this.stream = null;
    this.cancelScan = null;
    this.lastProgressAt = 0;
    this.settings = this.readSettings();
    this.reset({ state: 'idle' });
  }

  /**
   * Loads root, days, and auto from the settings file, or the defaults.
   * A missing file (ENOENT) returns defaults quietly. Any other read or parse
   * failure logs a warning and returns defaults. Saved root and days are validated.
   * auto is kept only when it is a boolean.
   * No parameters.
   * @returns {{root: string, days: number, auto: boolean}}
   * Side effects: synchronous read of settingsFile. May console.warn.
   * Events: none.
   */
  readSettings() {
    const defaults = { root: this.options.defaultRoot, days: this.options.defaultDays, auto: this.options.defaultAuto };
    if (!this.options.settingsFile) return defaults;
    try {
      const saved = JSON.parse(fs.readFileSync(this.options.settingsFile, 'utf8'));
      return {
        root: validateRoot(saved.root),
        days: this.validateDays(saved.days),
        auto: typeof saved.auto === 'boolean' ? saved.auto : this.options.defaultAuto,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[archive] ignoring saved settings: ${error.message}`);
      return defaults;
    }
  }

  /**
   * Writes this.settings as pretty JSON to settingsFile.
   * Does nothing when settingsFile is not set. A failure is logged and swallowed.
   * No parameters.
   * @returns {void}
   * Side effects: mkdir and write of the settings file. May console.warn.
   * Events: none.
   */
  saveSettings() {
    if (!this.options.settingsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.options.settingsFile), { recursive: true });
      fs.writeFileSync(this.options.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.warn(`[archive] could not save settings: ${error.message}`);
    }
  }

  /**
   * Accepts a whole number of days from 1 through maxDays.
   * @param {number} days Requested day count.
   * @returns {number} The same number when it is in range.
   * Side effects: none. Throws Error when it is not an integer in range.
   * Events: none.
   */
  validateDays(days) {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > this.options.maxDays) {
      throw new Error(`Days must be a whole number from 1 to ${this.options.maxDays}`);
    }
    return value;
  }

  /**
   * Settings, defaults, the maxDays limit, and the current status() object.
   * No parameters.
   * @returns {object}
   * Side effects: none. status() does not emit.
   * Events: none.
   */
  info() {
    return {
      settings: this.settings,
      defaults: { root: this.options.defaultRoot, days: this.options.defaultDays, auto: this.options.defaultAuto },
      limits: { maxDays: this.options.maxDays },
      status: this.status(),
    };
  }

  /**
   * Replaces the loaded arrays and the progress state. Does not cancel a load,
   * clear a background snapshot, or touch the hung counters.
   * @param {object} patch Fields merged over the idle state object.
   * @returns {void}
   * Side effects: assigns coverage, samples, solution, bestsats, sorted, resolutionMs, and state.
   * Events: none.
   */
  reset(patch) {
    this.coverage = [];
    this.samples = [];
    this.solution = [];
    this.solutionResolutionMs = 1000;
    this.bestsats = [];
    this.bestsatsResolutionMs = 1000;
    this.sorted = true;
    this.resolutionMs = 1000;
    this.state = {
      state: 'idle',
      root: null,
      days: null,
      from: null,
      to: null,
      filesTotal: 0,
      filesDone: 0,
      filesCached: 0,
      filesSkipped: 0,
      bytesTotal: 0,
      bytesDone: 0,
      currentFile: null,
      reports: 0,
      solutionReports: 0,
      bestsatsReports: 0,
      crcErrors: 0,
      errors: [],
      message: null,
      startedAt: null,
      finishedAt: null,
      revision: 0,
      ...patch,
    };
  }

  /**
   * Status object for the UI.
   * During a background refresh, this.view holds the previous data. The returned
   * object then uses that snapshot's state, with PROGRESS_FIELDS overwritten from
   * the refresh, and reports sample counts from the snapshot. Otherwise it describes
   * this state and these arrays. generation is dataGeneration (the snapshot's
   * generation until a successful swap). refreshing is true while a snapshot exists.
   * auto echoes settings.auto, refreshMs, and autoState.
   * No parameters.
   * @returns {object}
   * Side effects: none. Copies errors rather than returning the live array.
   * Events: none.
   */
  status() {
    const view = this.view;
    const base = view ? { ...view.state } : { ...this.state };
    if (view) for (const key of PROGRESS_FIELDS) base[key] = this.state[key];
    const data = view ? view.data : this;
    return {
      ...base,
      errors: base.errors.slice(),
      refreshing: Boolean(view),
      samples: data.samples.length,
      solutionSamples: data.solution.length,
      solutionResolutionMs: data.solutionResolutionMs,
      bestsatsSamples: data.bestsats.length,
      bestsatsResolutionMs: data.bestsatsResolutionMs,
      resolutionMs: data.resolutionMs,
      generation: this.dataGeneration,
      auto: {
        enabled: this.settings.auto,
        refreshMs: this.options.refreshMs,
        ...this.autoState,
      },
      lastReachableAt: this.lastReachableAt,
    };
  }

  /**
   * True while a load is listing directories or scanning files.
   * No parameters.
   * @returns {boolean}
   * Side effects: none.
   * Events: none.
   */
  busy() {
    return this.state.state === 'listing' || this.state.state === 'scanning';
  }

  /**
   * True when any interference, coverage, solution, or BESTSATS data is loaded.
   * No parameters.
   * @returns {boolean}
   * Side effects: none.
   * Events: none.
   */
  hasData() {
    return this.samples.length > 0 || this.coverage.length > 0 || this.solution.length > 0 || this.bestsats.length > 0;
  }

  /**
   * Merges `patch` into this.state and emits 'status'.
   * This is the only method that calls emit. The event name is 'status' and the
   * payload is status(). Unless `force` is true, the emit is skipped when the
   * previous emit was less than PROGRESS_INTERVAL_MS ago. The patch is applied
   * either way.
   * @param {object} patch Fields assigned onto this.state.
   * @param {boolean} [force=false] When true, emit even inside the progress interval.
   * @returns {void}
   * Side effects: mutates this.state and lastProgressAt. Emits 'status' when not throttled.
   * Events: emits 'status'.
   */
  update(patch, force = false) {
    Object.assign(this.state, patch);
    // Listing the folder or finishing a scan means the share answered. A later
    // error keeps this timestamp. idle and error do not move it.
    if (patch.state === 'ready' || patch.state === 'scanning' || patch.state === 'cancelled') {
      this.lastReachableAt = this.options.now();
    }
    const now = Date.now();
    if (!force && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.emit('status', this.status());
  }

  /**
   * Appends a load error until MAX_ERRORS messages are stored.
   * @param {string} message Error text shown in status().
   * @returns {void}
   * Side effects: may push onto this.state.errors.
   * Events: none. The next status emit includes the error.
   */
  addError(message) {
    if (this.state.errors.length < MAX_ERRORS) this.state.errors.push(message);
  }

  /**
   * Starts a foreground load of `days` from `root`, replacing any loaded or in-progress archive.
   * Persists root and days (auto is left as it was) and then calls start() with background false.
   * @param {{root?: string, days?: number}} [request] Omitted fields fall back to this.settings.
   * @returns {object} The status() object returned by start().
   * Side effects: may throw from assertAvailable, validateRoot, or validateDays. Writes settings.
   *   Starts the asynchronous load.
   * Events: emits 'status' via update() inside start().
   */
  load(request = {}) {
    this.assertAvailable();
    const root = validateRoot(request.root === undefined ? this.settings.root : request.root);
    const days = this.validateDays(request.days === undefined ? this.settings.days : request.days);
    this.settings = { ...this.settings, root, days };
    this.saveSettings();
    return this.start(root, days, false);
  }

  /**
   * Begins a load of `days` ending at options.now() and returns status() immediately.
   * run() continues asynchronously.
   *
   * A background load snapshots the current arrays and state into this.view when
   * no snapshot exists, the archive is not busy, the state is not idle, and hasData()
   * is true. Queries and status() keep that previous data until run() finishes
   * successfully and drops this.view (the swap). On failure, the catch below
   * restores the snapshot when this generation is still current.
   * A foreground load sets this.view to null (it does not restore the snapshot)
   * and reset() replaces the arrays.
   *
   * Cancellation: this increments generation. run(), listFiles(), and scanFile()
   * return without swapping once generation has moved on. The catch below also
   * returns when generation has moved on, so it does not restore or set state
   * 'error' after cancel() or a newer start(). cancel() itself bumps generation,
   * abandons the stream, and restores the snapshot when one exists.
   * @param {string} root Archive root. Caller has already validated it.
   * @param {number} days Day count. Caller has already validated it.
   * @param {boolean} background True for an automatic refresh that may keep previous data.
   * @returns {object} this.status() after the load is marked 'listing'.
   * Side effects: stopStream(), may snapshot or clear this.view, reset(), starts run().
   * Events: emits 'status' via update(). The failure path emits again via update()
   *   when this generation is still current.
   */
  start(root, days, background) {
    this.assertAvailable();
    this.stopStream();
    const generation = ++this.generation;
    // Snapshot previous data only when this background load is not already refreshing,
    // is not busy, is not idle, and still has data. Queries read this.view until run() swaps.
    if (background && !this.view && !this.busy() && this.state.state !== 'idle' && this.hasData()) {
      this.ensureSorted();
      this.view = {
        data: Object.fromEntries(DATA_FIELDS.map((key) => [key, this[key]])),
        state: { ...this.state, errors: this.state.errors.slice() },
      };
    } else if (!background) {
      this.view = null;
    }
    if (!this.view) this.dataGeneration = generation;
    const to = this.options.now();
    this.reset({
      state: 'listing', root, days, from: to - days * DAY_MS, to, startedAt: Date.now(),
      message: `Searching ${root} for log files`,
    });
    this.update({}, true);
    this.run(generation).catch((error) => {
      // cancel(), clear(), or a newer start() moved generation: do not restore or record this error.
      if (generation !== this.generation) return;
      this.stopStream();
      this.autoState.lastError = error.message;
      // Automatic refresh retries this. The first failure is logged; later ones are counted once a minute.
      logLimited('warn', 'archive-load', `[archive] load failed: ${error.message}; live receiver data is unaffected`);
      if (this.view) {
        this.restoreView();
        this.update({ message: `Refresh failed (${error.message}); showing the previously loaded data` }, true);
      } else {
        this.update({ state: 'error', message: error.message, currentFile: null, finishedAt: Date.now() }, true);
      }
    });
    return this.status();
  }

  /**
   * Puts the background snapshot's arrays and state back and drops the snapshot.
   * No parameters.
   * @returns {void}
   * Side effects: assigns the saved data fields and this.state. Sets this.view to null.
   * Events: none. Callers that need a status event call update() afterward.
   */
  restoreView() {
    const { data, state } = this.view;
    this.view = null;
    Object.assign(this, data);
    this.state = state;
  }

  /**
   * Cancels a listing or scanning load.
   * When not busy, returns status() without changing generation or emitting.
   * When busy, increments generation, stopStream()s, and either restores the
   * background snapshot or marks the state 'cancelled'. Files already merged
   * stay in place on the non-background path.
   * No parameters.
   * @returns {object} this.status().
   * Side effects: may bump generation, abandon the stream, and restore or replace state.
   * Events: emits 'status' via update() when a busy load is cancelled. No event when not busy.
   */
  cancel() {
    if (!this.busy()) return this.status();
    this.generation++;
    this.stopStream();
    if (this.view) {
      this.restoreView();
      this.update({ message: 'Refresh cancelled; showing the previously loaded data' }, true);
      return this.status();
    }
    this.update({
      state: 'cancelled', currentFile: null, finishedAt: Date.now(),
      message: 'Loading cancelled; files already read remain available',
    }, true);
    return this.status();
  }

  /**
   * Unloads the archive and turns automatic refresh off so it stays unloaded.
   * Increments generation (a running load's catch then ignores itself), abandons
   * the stream, drops any snapshot, and clears the auto timer.
   * No parameters.
   * @returns {object} this.status() after the idle reset.
   * Side effects: may write settings when auto was on. Resets loaded data.
   * Events: emits 'status' via update().
   */
  clear() {
    this.generation++;
    this.dataGeneration = this.generation;
    this.stopStream();
    this.view = null;
    if (this.settings.auto) {
      this.settings = { ...this.settings, auto: false };
      this.saveSettings();
    }
    this.stopAuto();
    this.reset({ state: 'idle', message: 'Archive unloaded' });
    this.update({}, true);
    return this.status();
  }

  /**
   * Turns automatic loading on or off and persists settings.auto.
   * On enables scheduleAuto(0), so autoTick runs on the next timer turn unless
   * a later tick finds the archive busy or a hung request. Off calls stopAuto(),
   * which clears the timer and does not itself cancel a load already running.
   * @param {boolean} enabled Stored as a boolean.
   * @returns {object} this.status().
   * Side effects: writes settings, arms or clears the auto timer, clears lastError.
   * Events: emits 'status' via update(). autoTick may emit later.
   */
  setAuto(enabled) {
    this.settings = { ...this.settings, auto: Boolean(enabled) };
    this.saveSettings();
    this.autoState.lastError = null;
    if (this.settings.auto) this.scheduleAuto(0);
    else this.stopAuto();
    this.update({}, true);
    return this.status();
  }

  /**
   * Arms the auto timer when settings.auto is true.
   * @param {number} [delayMs=0] Delay before autoTick.
   * @returns {void}
   * Side effects: may replace this.autoTimer via scheduleAuto.
   * Events: none. autoTick may emit later.
   */
  startAuto(delayMs = 0) {
    if (this.settings.auto) this.scheduleAuto(delayMs);
  }

  /**
   * Clears the automatic-refresh timer and nextRunAt.
   * Does not increment generation and does not stop a scan already running.
   * No parameters.
   * @returns {void}
   * Side effects: clearTimeout on this.autoTimer.
   * Events: none.
   */
  stopAuto() {
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.autoState.nextRunAt = null;
  }

  /**
   * Replaces the single auto timer. The timer is unref'd when the handle supports
   * it, so it does not keep the process alive. autoTick checks settings.auto.
   * @param {number} delayMs Delay before autoTick, also reflected in nextRunAt.
   * @returns {void}
   * Side effects: clearTimeout of the previous timer, assigns this.autoTimer and nextRunAt.
   * Events: none.
   */
  scheduleAuto(delayMs) {
    clearTimeout(this.autoTimer);
    this.autoState.nextRunAt = Date.now() + delayMs;
    this.autoTimer = setTimeout(() => this.autoTick(), delayMs);
    // unref: the automatic refresh timer must not keep the process alive.
    if (typeof this.autoTimer.unref === 'function') this.autoTimer.unref();
  }

  /**
   * One automatic refresh. Does nothing when settings.auto is false.
   * busy() (listing or scanning) reschedules after busyRetryMs and does not
   * call start(), so a running load is not overlapped.
   * When hung, pendingFs, or stuckHandles is positive, this does not start a
   * scan. It reschedules after refreshMs. start() is also guarded by
   * assertAvailable(), which throws for those counters or an unclosed stream.
   * Otherwise it records lastRunAt, schedules the next refresh, and start()s
   * in the background so previous data stays until that load swaps.
   * No parameters.
   * @returns {void}
   * Side effects: may replace the auto timer, lastRunAt, and lastError, and may start a load.
   * Events: emits 'status' via update() when a hung request skips the scan, and via start()
   *   when a refresh begins. No event when auto is off or the only action is the busy reschedule.
   */
  autoTick() {
    this.autoTimer = null;
    if (!this.settings.auto) return;
    // A listing or scanning load is already running. Do not start another one.
    if (this.busy()) {
      this.scheduleAuto(this.options.busyRetryMs);
      return;
    }
    // hung, pendingFs, or stuckHandles: do not start a scan. Retry after refreshMs.
    if (this.hung > 0 || this.pendingFs > 0 || this.stuckHandles > 0) {
      if (this.hung > 0 || this.pendingFs > 0 || !this.autoState.lastError) {
        this.autoState.lastError = 'The network folder has not answered an earlier request yet; will retry';
      }
      this.scheduleAuto(this.options.refreshMs);
      this.update({}, true);
      return;
    }
    this.autoState.lastRunAt = Date.now();
    this.scheduleAuto(this.options.refreshMs);
    this.start(this.settings.root, this.settings.days, true);
  }

  /**
   * Throws when a network request is still outstanding.
   * The condition is hung > 0, pendingFs > 0, stuckHandles > 0, or a current
   * stream that is not closed. autoTick refuses to start a scan in the counter
   * case; load() and start() call this before touching the share.
   * No parameters.
   * @returns {void}
   * Side effects: none. Throws Error when a request is still outstanding.
   * Events: none.
   */
  assertAvailable() {
    // Refuse a new load while a timed-out call, an open fs call, a stuck stream, or this stream remains.
    if (this.hung > 0 || this.pendingFs > 0 || this.stuckHandles > 0 || (this.stream && !this.stream.closed)) {
      throw new Error('Archive network folder still has an outstanding request; wait before retrying. Live data is unaffected.');
    }
  }

  /**
   * Races a filesystem promise against fsTimeoutMs.
   * Increments pendingFs first. armCounterReset decrements it when `promise`
   * settles, or after hungResetMs if it never settles. The timer rejects with
   * a fatal error. On that timeout the original promise is not cancelled;
   * trackHung increments hung until the same promise settles or hungResetMs
   * drops the hung count. The OS call is not cancelled.
   * @param {Promise<*>} promise Filesystem operation already started.
   * @param {string} label Text used in the timeout error and the hung-reset warning.
   * @returns {Promise<*>} The filesystem result. Rejects with a fatal error on timeout.
   * Side effects: pendingFs, and hung when the race times out. Arms hungResetMs timers.
   * Events: none directly. armCounterReset emits 'status' via update() if a call never settles.
   */
  async withTimeout(promise, label) {
    // Count the call before the race. It stays counted until it settles or hungResetMs.
    this.pendingFs++;
    const release = this.armCounterReset('pendingFs', `${label} stayed open and was marked finished so archive loading can continue`);
    Promise.resolve(promise).then(release, release);
    let timer;
    let timedOut = false;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(fatalError(`${label} did not respond within ${Math.round(this.options.fsTimeoutMs / 1000)} s`));
      }, this.options.fsTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
      // Timeout does not cancel the OS call. trackHung increments hung until that promise settles.
      if (timedOut) this.trackHung(promise);
    }
  }

  /**
   * Counts a filesystem or close operation that outlived its waiter.
   * Increments hung and decrements it when `promise` settles. armCounterReset
   * also drops hung after hungResetMs if the promise never settles, and logs
   * that the original call may still be in flight. The OS call is not cancelled.
   * @param {Promise<*>} promise Operation to wait for. Errors are treated as settled.
   * @returns {void}
   * Side effects: increments hung and arms a hungResetMs timer.
   * Events: none directly. The reset timer emits 'status' via update() if it fires.
   */
  trackHung(promise) {
    this.hung++;
    const release = this.armCounterReset('hung', 'A network folder request stayed open and was marked finished so archive loading can continue');
    Promise.resolve(promise).then(release, release);
  }

  /**
   * Returns a function that decrements this[counter] once.
   * The decrement happens when that function runs, or after hungResetMs if it
   * never runs. The timeout path logs that the original call may still be in
   * flight, records the message, and emits 'status'. It does not cancel the
   * OS call. The timer is unref'd. A second settle is ignored.
   * @param {string} counter Property name, 'pendingFs' or 'hung'.
   * @param {string} message Warning stored on the timeout path.
   * @returns {function(): void} Decrements the counter once and clears the timer. Does not emit.
   * Side effects: arms an unref'd timer. The timer mutates the counter, errors, and autoState.
   * Events: the timeout path emits 'status' via update(). The returned function emits nothing.
   */
  armCounterReset(counter, message) {
    let settled = false;
    // If release never runs, drop the counter after hungResetMs. The OS call is not cancelled.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this[counter]--;
      console.warn(`[archive] ${message}; the original call may still be in flight`);
      this.addError(message);
      this.autoState.lastError = message;
      this.update({}, true);
    }, this.options.hungResetMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this[counter]--;
    };
  }

  /**
   * Abandons the current read stream and the scan waiting on it.
   * Clears this.stream and cancelScan, then invokes cancelScan (scanFile's
   * abandon, resolving null). When the stream exists and is not closed,
   * stuckHandles increments, the 'close' event decrements it (not below 0),
   * and trackHung is armed on that close promise. If 'close' never arrives,
   * stuckHandleMs (default three times hungResetMs) drops the counter, records
   * lastError, and lets the next scan start. destroy() is still called.
   * A stream that is already closed does not change stuckHandles.
   * No parameters.
   * @returns {void}
   * Side effects: may increment stuckHandles, arm hung via trackHung, and destroy the stream.
   * Events: none directly. trackHung's reset timer may later emit 'status' via update().
   */
  stopStream() {
    const stream = this.stream;
    this.stream = null;
    const cancel = this.cancelScan;
    this.cancelScan = null;
    if (cancel) cancel();
    if (stream) {
      // Not closed: count a stuck handle, decrement it on 'close' (not below 0),
      // and trackHung that close promise.
      if (!stream.closed) {
        this.stuckHandles++;
        const closed = new Promise((resolve) => {
          let settled = false;
          /**
           * Drops one stuck-handle count. 'close' and the age-out timer both call this.
           * The second call is ignored so the counter cannot go negative from both.
           * @returns {void}
           * Side effects: may decrement stuckHandles and clear the age-out timer.
           * Events: none.
           */
          const release = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (this.stuckHandles > 0) this.stuckHandles--;
            resolve();
          };
          stream.once('close', release);
          // Default is 3x hungResetMs, which is longer than the short wait in the
          // existing "still blocks until close" test. An explicit stuckHandleMs wins.
          const ageMs = Number.isFinite(this.options.stuckHandleMs) && this.options.stuckHandleMs >= 0
            ? this.options.stuckHandleMs
            : this.options.hungResetMs * 3;
          const timer = setTimeout(() => {
            const message = 'A network folder read did not close and was released so archive loading can continue';
            console.warn(`[archive] ${message}`);
            this.addError(message);
            this.autoState.lastError = message;
            release();
            this.update({}, true);
          }, ageMs);
          if (typeof timer.unref === 'function') timer.unref();
        });
        this.trackHung(closed);
      }
      if (typeof stream.destroy === 'function') stream.destroy();
    }
  }

  /**
   * Lists logs in the window and scans or loads each one.
   * Returns without swapping or setting an error when generation has changed
   * (cancel, clear, or a newer start). A cached summary that fails summaryUsable
   * is deleted and that file is rescanned. A scan that fails summaryUsable is
   * not cached and not merged. fatal errors and NETWORK_ERRORS fail the load;
   * other per-file errors are recorded and the next file is tried.
   * After the last file, ensureSorted and pruneCache run. When a background
   * snapshot exists it is dropped and dataGeneration becomes this generation:
   * that swap is what makes the new summaries visible. Failure throws to start()'s
   * catch, which restores the snapshot if this generation is still current.
   * @param {number} generation Generation captured by start().
   * @returns {Promise<void>}
   * Side effects: reads the share and the cache, mutates loaded arrays and state, may write caches.
   * Events: emits 'status' via update(). The per-file progress update is throttled;
   *   the scanning and ready updates pass force and emit immediately.
   */
  async run(generation) {
    const { root, from, to } = this.state;
    const files = await this.listFiles(root, from, to, generation);
    // A newer start(), cancel(), or clear() bumped generation. Stop with no swap and no error update.
    if (generation !== this.generation) return;
    const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
    this.update({
      state: 'scanning', filesTotal: files.length, bytesTotal,
      message: files.length ? null : `No .LOG files found under ${root} for the selected days`,
    }, true);

    let bytesBefore = 0;
    for (const file of files) {
      if (generation !== this.generation) return;
      this.update({ currentFile: file.path, bytesDone: bytesBefore });
      let summary = await this.readCache(file);
      if (generation !== this.generation) return;
      // A cached summary that fails summaryUsable is discarded, both cache files are removed, and the log is rescanned.
      if (summary && !summaryUsable(summary)) {
        console.warn(`[archive] discarding unusable cache for ${file.path}`);
        await this.deleteCache(file);
        if (generation !== this.generation) return;
        this.addError(`${path.basename(file.path)}: cached summary was unusable and will be rescanned`);
        summary = null;
      }
      const cached = Boolean(summary);
      try {
        if (!summary) {
          summary = await this.scanFile(file, generation, bytesBefore);
          if (!summary || generation !== this.generation) return;
          if (!summaryUsable(summary)) {
            this.addError(`${path.basename(file.path)}: scan produced an unusable summary`);
            summary = null;
          } else {
            await this.writeCache(file, summary);
          }
        }
        if (generation !== this.generation) return;
        if (summary) this.addSummary(summary, from, to);
      } catch (error) {
        if (generation !== this.generation) return;
        if (error.fatal || NETWORK_ERRORS.has(error.code)) {
          throw new Error(`${path.basename(file.path)}: ${error.message}`);
        }
        this.addError(`${path.basename(file.path)}: ${error.message}`);
        summary = null;
      }
      bytesBefore += file.size;
      this.update({
        filesDone: this.state.filesDone + 1,
        filesCached: this.state.filesCached + (cached ? 1 : 0),
        bytesDone: bytesBefore,
        reports: this.state.reports + (summary ? summary.reportCount : 0),
        solutionReports: this.state.solutionReports + (summary ? summary.solutionReports : 0),
        bestsatsReports: this.state.bestsatsReports + (summary ? summary.bestsatsReports : 0),
        crcErrors: this.state.crcErrors + (summary ? summary.crcErrors : 0),
        revision: this.state.revision + 1,
      });
    }
    this.ensureSorted();
    this.pruneCache();
    // Successful background refresh: drop the previous-data snapshot so the merged summaries become visible.
    if (this.view) {
      this.view = null;
      this.dataGeneration = generation;
    }
    this.autoState.lastError = null;
    this.update({ state: 'ready', currentFile: null, finishedAt: Date.now() }, true);
  }

  /**
   * Lists root/YYYY/DDD/*.LOG files that can contain reports between `from` and `to`.
   * Year directories are the UTC years of (from - 1 day) through (to + 1 day).
   * A child directory whose name is 1 to 3 digits is a day-of-year folder.
   * dayStart is UTC midnight of that day (1 January plus DDD - 1 days). The
   * folder is kept when that day, widened by FILE_TIME_TOLERANCE_MS on both
   * sides, overlaps [from, to]. Each .LOG file's start is fileNameTime(name)
   * (the _YYYY-MM-DD_HH-MM-SS.LOG suffix as UTC) or, when the name does not
   * match, the folder's dayStart. After sorting by start, a file is dropped
   * when its start minus the tolerance is after `to`, or when the next file's
   * start plus the tolerance is still before `from`. More than maxFiles keeps
   * the newest maxFiles. filesSkipped counts files removed by that time filter
   * and does not include the maxFiles cut.
   * A generation change returns []. The root access failure always fails the load.
   * fatal and NETWORK_ERRORS from a later directory read also fail the load.
   * ENOENT for a year folder is skipped. Other directory and stat errors are
   * recorded and that entry is skipped.
   * @param {string} root Absolute archive root.
   * @param {number} from Window start in milliseconds.
   * @param {number} to Window end in milliseconds.
   * @param {number} [generation=this.generation] Load generation to abort on.
   * @returns {Promise<Array<{path: string, size: number, mtimeMs: number, start: number, folderStart: number}>>}
   * Side effects: directory and stat calls via withTimeout. Sets this.state.filesSkipped. May addError.
   * Events: none directly. withTimeout's hung reset may emit 'status'.
   */
  async listFiles(root, from, to, generation = this.generation) {
    try {
      await this.withTimeout(fs.promises.access(root), `Archive folder ${root}`);
    } catch (error) {
      if (error.fatal) throw new Error(`Archive folder ${root} is not reachable (${error.message})`);
      throw new Error(`Archive folder ${root} is not reachable (${error.code || error.message})`);
    }
    if (generation !== this.generation) return [];
    const folders = [];
    // Year folders covering the window, plus one day on each side so a boundary day is not missed.
    const firstYear = new Date(from - DAY_MS).getUTCFullYear();
    const lastYear = new Date(to + DAY_MS).getUTCFullYear();
    for (let year = firstYear; year <= lastYear; year++) {
      let entries;
      try {
        entries = await this.withTimeout(
          fs.promises.readdir(path.join(root, String(year)), { withFileTypes: true }), `Folder ${year}`);
      } catch (error) {
        if (generation !== this.generation) return [];
        if (error.fatal || NETWORK_ERRORS.has(error.code)) throw error;
        if (error.code !== 'ENOENT') this.addError(`${year}: ${error.message}`);
        continue;
      }
      if (generation !== this.generation) return [];
      for (const entry of entries) {
        // Day-of-year folder: 1 to 3 digits. dayStart is UTC midnight of that day.
        // Keep it when the day, widened by FILE_TIME_TOLERANCE_MS on both sides, overlaps [from, to].
        if (!entry.isDirectory() || !/^\d{1,3}$/.test(entry.name)) continue;
        const dayStart = Date.UTC(year, 0, 1) + (Number(entry.name) - 1) * DAY_MS;
        if (dayStart + DAY_MS + FILE_TIME_TOLERANCE_MS < from || dayStart - FILE_TIME_TOLERANCE_MS > to) continue;
        folders.push({ dir: path.join(root, String(year), entry.name), dayStart });
      }
    }
    folders.sort((a, b) => a.dayStart - b.dayStart);

    const files = [];
    for (const folder of folders) {
      let names;
      try {
        names = (await this.withTimeout(fs.promises.readdir(folder.dir), `Folder ${folder.dir}`))
          .filter((name) => /\.log$/i.test(name)).sort();
      } catch (error) {
        if (generation !== this.generation) return [];
        if (error.fatal || NETWORK_ERRORS.has(error.code)) throw error;
        this.addError(`${folder.dir}: ${error.message}`);
        continue;
      }
      if (generation !== this.generation) return [];
      for (const name of names) {
        const filePath = path.join(folder.dir, name);
        try {
          const stat = await this.withTimeout(fs.promises.stat(filePath), name);
          if (generation !== this.generation) return [];
          if (!stat.isFile()) continue;
          // start is the UTC time of suffix _YYYY-MM-DD_HH-MM-SS.LOG, or this folder's UTC day start.
          files.push({
            path: filePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs),
            start: fileNameTime(name) ?? folder.dayStart, folderStart: folder.dayStart,
          });
        } catch (error) {
          if (generation !== this.generation) return [];
          if (error.fatal || NETWORK_ERRORS.has(error.code)) throw error;
          this.addError(`${name}: ${error.message}`);
        }
      }
    }
    files.sort((a, b) => a.start - b.start || a.path.localeCompare(b.path));

    // Drop a file whose start, minus FILE_TIME_TOLERANCE_MS, is after `to`.
    // Otherwise keep it when it is the last file, or when the next file's start
    // plus that tolerance is still at or after `from` (reports are treated as running until the next file).
    const relevant = files.filter((file, index) => {
      const next = files[index + 1];
      if (file.start - FILE_TIME_TOLERANCE_MS > to) return false;
      return !next || next.start + FILE_TIME_TOLERANCE_MS >= from;
    });
    this.state.filesSkipped = files.length - relevant.length;
    if (relevant.length > this.options.maxFiles) {
      this.addError(`Only the newest ${this.options.maxFiles} of ${relevant.length} files are read`);
      return relevant.slice(-this.options.maxFiles);
    }
    return relevant;
  }

  /**
   * Streams one log through createItDetectScanner.
   * The read uses READ_CHUNK_BYTES. A watchdog abandons with a fatal error and
   * stopStream() when no chunk arrives for stallTimeoutMs. cancelScan resolves
   * that wait with null (stopStream). A generation change or a null abandon
   * result returns null. After the last chunk, scanner.end() runs the EOF rescan
   * and the summary JSON is returned. fatal and stream errors propagate to run().
   * @param {{path: string, size: number}} file Log to read. path is the filesystem path.
   * @param {number} generation Load generation. A mismatch returns null.
   * @param {number} bytesBefore Bytes already finished in this load, added to progress.
   * @returns {Promise<object|null>} summary.toJSON(), or null when the load was superseded.
   * Side effects: sets this.stream, reads the file, mutates the summary, calls update() with bytesDone.
   * Events: 'status' via update(), throttled by PROGRESS_INTERVAL_MS. stopStream does not emit by itself.
   */
  async scanFile(file, generation, bytesBefore) {
    const summary = new FileSummary(this.options.maxSamples);
    const scanner = createItDetectScanner(summary);
    const stream = fs.createReadStream(file.path, { highWaterMark: READ_CHUNK_BYTES });
    this.stream = stream;
    let bytes = 0;
    let lastDataAt = Date.now();
    let abandon;
    const abandoned = new Promise((resolve, reject) => {
      abandon = (error) => error ? reject(error) : resolve(null);
    });
    this.cancelScan = () => abandon();
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataAt <= this.options.stallTimeoutMs || stream.destroyed) return;
      // Windows may not close a network handle until its pending read returns.
      abandon(fatalError(`no data received for ${Math.round(this.options.stallTimeoutMs / 1000)} s`));
      this.stopStream();
    }, Math.max(10, Math.min(5000, this.options.stallTimeoutMs / 4)));
    /**
     * Reads the stream and returns the summary JSON, or null if generation changed.
     * scanner.end() runs after the last chunk so a carried abbreviated block or an
     * overrun declared length can be finished.
     * No parameters.
     * @returns {Promise<object|null>}
     * Side effects: scanner.push / scanner.end, and update() with bytesDone.
     * Events: 'status' only when update() is outside the progress interval.
     */
    const reading = (async () => {
      for await (const chunk of stream) {
        if (generation !== this.generation) return null;
        lastDataAt = Date.now();
        scanner.push(chunk);
        bytes += chunk.length;
        this.update({ bytesDone: bytesBefore + bytes });
      }
      if (generation !== this.generation) return null;
      // EOF: end() completes a carried '<' block or rescans a declared length that overruns the tail.
      scanner.end();
      return summary.toJSON();
    })();
    let winner = null;
    reading.catch((error) => {
      queueMicrotask(() => {
        if (winner === 'read') return;
        const code = error && error.code;
        if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED') return;
        console.warn(`[archive] scan read settled after it was abandoned: ${error && error.message ? error.message : error}`);
      });
    });
    try {
      const outcome = await Promise.race([
        reading.then((value) => ({ source: 'read', value }), (error) => ({ source: 'read', error })),
        abandoned.then((value) => ({ source: 'abandon', value }), (error) => ({ source: 'abandon', error })),
      ]);
      winner = outcome.source;
      if (outcome.error) throw outcome.error;
      return outcome.value;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    } finally {
      clearInterval(watchdog);
      if (this.stream === stream) this.stopStream();
    }
  }

  /**
   * Gzip-cache path for one log, or null when cacheDir is not configured.
   * The file name is sha1 of file.path.toLowerCase() plus '.json.gz'. That hash
   * is only the file name. cacheMatches decides whether the JSON is this log.
   * @param {{path: string}} file Log identity. path is the path string that is hashed.
   * @returns {string|null}
   * Side effects: none.
   * Events: none.
   */
  cachePath(file) {
    if (!this.options.cacheDir) return null;
    const key = crypto.createHash('sha1').update(file.path.toLowerCase()).digest('hex');
    return path.join(this.options.cacheDir, `${key}.json.gz`);
  }

  /**
   * True when cached JSON is the summary for this log.
   * The file identity compared is path, size, and mtimeMs, and version must
   * equal CACHE_VERSION. The sha1 file name is not compared again here.
   * The summary arrays and the solution / bestsats counters must also be present
   * so a partial JSON file is treated as a miss.
   * @param {object|null|undefined} parsed Gunzipped cache object.
   * @param {{path: string, size: number, mtimeMs: number}} file Log stat used as the key.
   * @returns {boolean}
   * Side effects: none.
   * Events: none.
   */
  cacheMatches(parsed, file) {
    // Key: path, size, and mtimeMs, plus CACHE_VERSION. Not a hash of the log bytes.
    return Boolean(parsed) && parsed.version === CACHE_VERSION && parsed.path === file.path && parsed.size === file.size
      && parsed.mtimeMs === file.mtimeMs && Array.isArray(parsed.coverage) && Array.isArray(parsed.samples)
      && Array.isArray(parsed.solution) && Number.isFinite(parsed.solutionReports)
      && Number.isFinite(parsed.solutionResolutionMs) && Array.isArray(parsed.bestsats)
      && Number.isFinite(parsed.bestsatsReports) && Number.isFinite(parsed.bestsatsResolutionMs);
  }

  /**
   * Reads one gzip JSON cache file and returns it when cacheMatches accepts it.
   * ENOENT returns null quietly. Any other read, gunzip, or parse failure logs
   * a warning and returns null. A JSON object that does not match the key returns null.
   * @param {string} cachePath Path of the .json.gz or .json.gz.bak file.
   * @param {{path: string, size: number, mtimeMs: number}} file Log the cache must describe.
   * @returns {Promise<object|null>}
   * Side effects: reads cachePath. May console.warn.
   * Events: none.
   */
  async readCacheFile(cachePath, file) {
    let raw;
    try {
      raw = await fs.promises.readFile(cachePath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[archive] ignoring cache for ${file.path}: ${error.message}`);
      return null;
    }
    try {
      const parsed = JSON.parse(await gunzip(raw));
      return this.cacheMatches(parsed, file) ? parsed : null;
    } catch (error) {
      console.warn(`[archive] ignoring cache for ${file.path}: ${error.message}`);
      return null;
    }
  }

  /**
   * Loads the gzip JSON cache for `file`, falling back to the .json.gz.bak copy.
   * The backup is the previous cache left by replaceFile. A primary miss, a
   * corrupt primary, or a primary that fails cacheMatches tries the .bak.
   * Returns null when cacheDir is unset or neither copy passes cacheMatches
   * (path, size, mtimeMs, and CACHE_VERSION).
   * @param {{path: string, size: number, mtimeMs: number}} file Log identity.
   * @returns {Promise<object|null>} Parsed cache object, or null.
   * Side effects: reads the cache file and maybe the .bak. Warns when the backup is used.
   * Events: none.
   */
  async readCache(file) {
    const cachePath = this.cachePath(file);
    if (!cachePath) return null;
    const primary = await this.readCacheFile(cachePath, file);
    if (primary) return primary;
    // Primary missed or failed cacheMatches. Fall back to the .json.gz.bak left by replaceFile.
    const backup = await this.readCacheFile(`${cachePath}.bak`, file);
    if (!backup) return null;
    console.warn(`[archive] using cache backup for ${file.path}`);
    return backup;
  }

  /**
   * Gzip-caches `summary` for `file`.
   * The JSON identity stored with the summary is version, path, size, and mtimeMs.
   * Bytes are written to a temp file beside the cache and moved into place with
   * replaceFile, which turns the previous cache into the `.bak` file beside it. Failures are
   * logged and recorded with addError; they do not fail the load.
   * @param {{path: string, size: number, mtimeMs: number}} file Log identity stored in the JSON.
   * @param {object} summary Plain summary from FileSummary.toJSON.
   * @returns {Promise<void>}
   * Side effects: mkdir, write of a temp file, replaceFile. May console.warn and addError.
   * Events: none.
   */
  async writeCache(file, summary) {
    const cachePath = this.cachePath(file);
    if (!cachePath) return;
    try {
      await fs.promises.mkdir(this.options.cacheDir, { recursive: true });
      // JSON identity stored with the summary: version, path, size, and mtimeMs.
      const payload = await gzip(JSON.stringify({
        version: CACHE_VERSION, path: file.path, size: file.size, mtimeMs: file.mtimeMs, ...summary,
      }));
      const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(temporary, payload);
      // Atomic replace (replaceFile): the previous cache becomes the .bak file.
      await replaceFile(cachePath, temporary);
    } catch (error) {
      console.warn(`[archive] could not cache ${file.path}: ${error.message}`);
      this.addError(`${path.basename(file.path)}: could not write archive cache (${error.message})`);
    }
  }

  /**
   * Deletes the gzip cache for `file` and its .bak, if cacheDir is set.
   * @param {{path: string}} file Log whose cachePath is removed.
   * @returns {Promise<void>}
   * Side effects: unlinks the cache file and the .bak file. ENOENT is ignored. Other errors are logged.
   * Events: none.
   */
  async deleteCache(file) {
    const cachePath = this.cachePath(file);
    if (!cachePath) return;
    // Unlink both the gzip cache and its .bak.
    for (const target of [cachePath, `${cachePath}.bak`]) {
      try {
        await fs.promises.unlink(target);
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`[archive] could not delete cache for ${file.path}: ${error.message}`);
      }
    }
  }

  /**
   * Drops the oldest gzip caches when the directory has more than maxCacheFiles .json.gz names.
   * Oldest is by the cache file's own mtime. Each removed .json.gz also removes its .bak.
   * Does nothing when cacheDir is unset or the count is within the cap. Failures are logged.
   * No parameters.
   * @returns {void}
   * Side effects: synchronous readdir, stat, and rm of cache files.
   * Events: none.
   */
  pruneCache() {
    const dir = this.options.cacheDir;
    if (!dir) return;
    try {
      const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json.gz'))
        .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }));
      if (entries.length <= this.options.maxCacheFiles) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of entries.slice(0, entries.length - this.options.maxCacheFiles)) {
        fs.rmSync(path.join(dir, entry.name), { force: true });
        fs.rmSync(path.join(dir, `${entry.name}.bak`), { force: true });
      }
    } catch (error) {
      console.warn(`[archive] could not prune cache: ${error.message}`);
    }
  }

  /**
   * Merges one file summary into the loaded window [from, to].
   * Coverage runs and samples outside the window are skipped; runs and solution
   * intervals that overlap the window are clipped to it. solutionResolutionMs and
   * bestsatsResolutionMs rise to the summary's resolution. Either interval array
   * over maxSamples is sorted and reduced by doubling its resolution until it is
   * at most 75% of maxSamples. samples over maxSamples call coarsen().
   * @param {object} summary Plain summary (toJSON or a cache object).
   * @param {number} from Window start in milliseconds.
   * @param {number} to Window end in milliseconds.
   * @returns {void}
   * Side effects: mutates coverage, samples, solution, bestsats, their resolutions, and sorted.
   * Events: none.
   */
  addSummary(summary, from, to) {
    for (const run of summary.coverage) {
      if (!Array.isArray(run) || run[1] < from || run[0] > to) continue;
      this.coverage.push([Math.max(from, run[0]), Math.min(to, run[1])]);
    }
    for (const sample of summary.samples) {
      if (!sample || !Number.isFinite(sample.t) || sample.t < from || sample.t > to) continue;
      this.samples.push(sample);
    }
    this.solutionResolutionMs = Math.max(this.solutionResolutionMs, summary.solutionResolutionMs);
    for (const sample of summary.solution) {
      if (sample.end < from || sample.t > to) continue;
      this.solution.push({ ...sample, t: Math.max(from, sample.t), end: Math.min(to, sample.end) });
    }
    if (this.solution.length > this.options.maxSamples) {
      this.solution.sort((a, b) => a.t - b.t);
      do {
        this.solutionResolutionMs *= 2;
        this.solution = reduceSolutions(this.solution, this.solutionResolutionMs);
      } while (this.solution.length > this.options.maxSamples * 0.75);
    }
    this.bestsatsResolutionMs = Math.max(this.bestsatsResolutionMs, summary.bestsatsResolutionMs);
    for (const sample of summary.bestsats) {
      if (sample.end < from || sample.t > to) continue;
      this.bestsats.push({ ...sample, t: Math.max(from, sample.t), end: Math.min(to, sample.end) });
    }
    if (this.bestsats.length > this.options.maxSamples) {
      this.bestsats.sort((a, b) => a.t - b.t);
      do {
        this.bestsatsResolutionMs *= 2;
        this.bestsats = reduceSolutions(this.bestsats, this.bestsatsResolutionMs);
      } while (this.bestsats.length > this.options.maxSamples * 0.75);
    }
    this.sorted = false;
    if (this.samples.length > this.options.maxSamples) this.coarsen();
  }

  /**
   * Widens detection buckets until samples.length is at most 75% of maxSamples.
   * Each pass doubles resolutionMs and keeps the stronger sample per signal per bucket.
   * No parameters.
   * @returns {void}
   * Side effects: ensureSorted(), then replaces this.samples and this.resolutionMs.
   * Events: none.
   */
  coarsen() {
    this.ensureSorted();
    while (this.samples.length > this.options.maxSamples * 0.75) {
      this.resolutionMs *= 2;
      const kept = new Map();
      for (const sample of this.samples) {
        const key = `${sample.signal}:${Math.floor(sample.t / this.resolutionMs)}`;
        const previous = kept.get(key);
        if (!previous || stronger(sample, previous)) kept.set(key, sample);
      }
      this.samples = [...kept.values()].sort((a, b) => a.t - b.t);
    }
  }

  /**
   * Sorts samples, solution, bestsats, and coverage, then merges coverage runs
   * whose start is within COVERAGE_GAP_MS of the previous run's end.
   * Returns immediately when this.sorted is already true.
   * No parameters.
   * @returns {void}
   * Side effects: reorders those arrays, replaces coverage with the merged runs, sets sorted.
   * Events: none.
   */
  ensureSorted() {
    if (this.sorted) return;
    this.samples.sort((a, b) => a.t - b.t);
    this.solution.sort((a, b) => a.t - b.t);
    this.bestsats.sort((a, b) => a.t - b.t);
    this.coverage.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const run of this.coverage) {
      const last = merged[merged.length - 1];
      if (last && run[0] - last[1] <= COVERAGE_GAP_MS) last[1] = Math.max(last[1], run[1]);
      else merged.push([run[0], run[1]]);
    }
    this.coverage = merged;
    this.sorted = true;
  }

  /**
   * Returns loaded history between `from` and `to`, reduced to at most `buckets` buckets.
   * buckets is clamped to 10..MAX_QUERY_BUCKETS. A floor of 0 or NaN is treated as 1000
   * before that clamp; a negative floor is clamped up to 10.
   * bucketMs is at least the data resolution and at least the window divided by that count.
   * The strongest sample per signal per bucket is kept. detectionSamples counts
   * in-range samples with count > 0, including ones that lose that contest.
   * Coverage is clipped to the window and merged across gaps of max(COVERAGE_GAP_MS, bucketMs).
   * Solution and BESTSATS intervals that overlap the window are clipped and passed
   * through reduceSolutions at the wider of bucketMs and their own resolution.
   * While a background snapshot exists, the snapshot is queried and is not re-sorted here.
   * @param {{from: number, to: number, buckets: number}} range Query window and bucket count.
   * @returns {object} from, to, bucketMs, resolutionMs, revision, detectionSamples, coverage,
   *   samples, solution, solutionResolutionMs, bestsats, bestsatsResolutionMs.
   * Side effects: when no snapshot exists, ensureSorted() may reorder the live arrays.
   *   Throws Error when from/to is not a finite range with to > from.
   * Events: none.
   */
  query({ from, to, buckets }) {
    if (!this.view) this.ensureSorted();
    const data = this.view ? this.view.data : this;
    const revision = this.view ? this.view.state.revision : this.state.revision;
    const start = Number(from);
    const end = Number(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('A valid from/to range is required');
    const count = Math.max(10, Math.min(MAX_QUERY_BUCKETS, Math.floor(Number(buckets)) || 1000));
    const bucketMs = Math.max(data.resolutionMs, Math.ceil((end - start) / count));

    let low = 0;
    let high = data.samples.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (data.samples[mid].t < start) low = mid + 1;
      else high = mid;
    }
    const chosen = new Map();
    let detectionSamples = 0;
    for (let index = low; index < data.samples.length && data.samples[index].t <= end; index++) {
      const sample = data.samples[index];
      if (sample.count > 0) detectionSamples++;
      const key = `${sample.signal}:${Math.floor((sample.t - start) / bucketMs)}`;
      const previous = chosen.get(key);
      if (!previous || stronger(sample, previous)) chosen.set(key, sample);
    }

    const coverage = [];
    const mergeGap = Math.max(COVERAGE_GAP_MS, bucketMs);
    for (const [runStart, runEnd] of data.coverage) {
      if (runEnd < start) continue;
      if (runStart > end) break;
      const clipped = [Math.max(start, runStart), Math.min(end, runEnd)];
      const last = coverage[coverage.length - 1];
      if (last && clipped[0] - last[1] <= mergeGap) last[1] = Math.max(last[1], clipped[1]);
      else coverage.push(clipped);
    }

    return {
      from: start,
      to: end,
      bucketMs,
      resolutionMs: data.resolutionMs,
      revision,
      detectionSamples,
      coverage,
      samples: [...chosen.values()].sort((a, b) => a.t - b.t),
      solutionResolutionMs: data.solutionResolutionMs,
      solution: reduceSolutions(data.solution
        .filter((sample) => sample.end >= start && sample.t <= end)
        .map((sample) => ({ ...sample, t: Math.max(start, sample.t), end: Math.min(end, sample.end) })),
      Math.max(bucketMs, data.solutionResolutionMs)),
      bestsats: reduceSolutions(data.bestsats
        .filter((sample) => sample.end >= start && sample.t <= end)
        .map((sample) => ({ ...sample, t: Math.max(start, sample.t), end: Math.min(end, sample.end) })),
      Math.max(bucketMs, data.bestsatsResolutionMs)),
      bestsatsResolutionMs: data.bestsatsResolutionMs,
    };
  }
}

module.exports = {
  InterferenceArchive, FileSummary, createItDetectScanner, fileNameTime, validateRoot, COVERAGE_GAP_MS,
};

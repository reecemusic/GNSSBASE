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
const { solutionSample } = require('./history');

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

function fatalError(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

/** True when sample `a` should replace `b` as the strongest report in a bucket. */
function stronger(a, b) {
  if ((a.count > 0) !== (b.count > 0)) return a.count > 0;
  const aPower = Number.isFinite(a.maxPower);
  const bPower = Number.isFinite(b.maxPower);
  if (aPower !== bPower) return aPower;
  if (aPower && a.maxPower !== b.maxPower) return a.maxPower > b.maxPower;
  return a.count > b.count;
}

/** Latest value per bucket, spanning only contiguous reporting; never bridge missing BESTPOS output. */
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

/** Converts one ITDETECTSTATUS report into per-signal samples in the shape used by live history. */
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
 * Compact file summary: interference coverage and strongest detections per second,
 * plus bounded intervals of unchanged BESTPOS solutions and BESTSATS counts.
 */
class FileSummary {
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

  addBestSats(t, used) {
    if (!this.bestsatsSummary) this.bestsatsSummary = new FileSummary(this.maxSolutions);
    this.bestsatsSummary.addSolution(t, { satellitesUsed: used });
  }

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
 * Incremental scanner for NovAtel log files. Only ITDETECTSTATUS, BESTPOS and BESTSATS are
 * decoded; every other binary frame is skipped by its length
 * without CRC work, so large RANGE/ephemeris traffic costs very little.
 */
function createItDetectScanner(summary) {
  let carry = null;
  let skip = 0;

  function handleBinary(buf, start, total) {
    if ((buf[start + 6] & 0x1f) !== 0) return; // secondary antenna (ITDETECTSTATUS_1)
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

  function handleAscii(line) {
    const parsed = parseAsciiLog(line);
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

  function push(input) {
    let chunk = input;
    if (skip) {
      if (chunk.length <= skip) {
        skip -= chunk.length;
        return;
      }
      chunk = chunk.subarray(skip);
      skip = 0;
    }
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    carry = null;
    let i = 0;
    const nextAscii = ASCII_MARKERS.map(() => -2);
    let nextSync = -2;
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
      if (buf.length - sync < LONG_HEADER_LENGTH) {
        carry = Buffer.from(buf.subarray(sync));
        return;
      }
      const total = buf[sync + 3] + buf.readUInt16LE(sync + 8) + 4;
      if (buf[sync + 3] !== LONG_HEADER_LENGTH || total > MAX_FRAME_BYTES) {
        i = sync + 1;
        continue;
      }
      const messageId = buf.readUInt16LE(sync + 4);
      if (messageId !== IT_MESSAGE_ID && messageId !== BESTPOS_MESSAGE_ID && messageId !== BESTSATS_MESSAGE_ID) {
        if (sync + total > buf.length) {
          skip = sync + total - buf.length;
          return;
        }
        i = sync + total;
        continue;
      }
      if (sync + total > buf.length) {
        carry = Buffer.from(buf.subarray(sync));
        return;
      }
      handleBinary(buf, sync, total);
      i = sync + total;
    }
  }

  /** At end of file an abbreviated message cannot be followed by more rows, so the carried block is complete. */
  function end() {
    if (carry && carry[0] === 0x3c && carry.indexOf(0x0a) !== -1) {
      handleAscii(abbreviatedToAscii(carry.toString('latin1')));
    }
    carry = null;
  }

  return { push, end };
}

/** Index just past an abbreviated ASCII block starting at `start`, or -1 if the buffer may end inside it. */
function abbreviatedEnd(buf, start) {
  let newline = buf.indexOf(0x0a, start);
  while (newline !== -1) {
    const next = newline + 1;
    if (next + 1 >= buf.length) return -1;
    if (buf[next] !== 0x3c || (buf[next + 1] !== 0x20 && buf[next + 1] !== 0x09)) return next;
    if (next - start > MAX_ABBREVIATED_BYTES) return -1;
    newline = buf.indexOf(0x0a, next);
  }
  return -1;
}

/** Rewrites an abbreviated block as an (unchecksummed) '#NAMEA,header;fields' line for the ASCII parser. */
function abbreviatedToAscii(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('<'));
  const header = lines[0].slice(1).trim().split(/\s+/);
  const fields = lines.slice(1).flatMap((line) => line.slice(1).trim().split(/\s+/)).filter(Boolean);
  return `#${header[0]}A,${header.slice(1).join(',')};${fields.join(',')}`;
}

function fileNameTime(name) {
  const match = FILE_NAME_TIME.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const t = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(t) ? t : null;
}

function validateRoot(root) {
  const value = String(root || '').trim();
  if (!value || value.length > 400 || value.includes('\0')) throw new Error('Archive folder must be a non-empty path');
  if (!path.isAbsolute(value)) throw new Error('Archive folder must be an absolute path such as \\\\20.20.20.1\\novatel\\pwrpak1');
  return value;
}

/**
 * Historic interference archive read from a `root\YYYY\DDD\*.LOG` tree (DDD = day of year).
 * Files are scanned one at a time and summaries cached on disk, so the NAS is read once per
 * file and memory/response size stay bounded regardless of how many days are requested.
 */
class InterferenceArchive extends EventEmitter {
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
      now: () => Date.now(),
      ...options,
    };
    this.generation = 0;
    this.dataGeneration = 0;
    this.view = null;
    this.hung = 0;
    this.pendingFs = 0;
    this.autoTimer = null;
    this.autoState = { lastRunAt: null, nextRunAt: null, lastError: null };
    this.stream = null;
    this.cancelScan = null;
    this.lastProgressAt = 0;
    this.settings = this.readSettings();
    this.reset({ state: 'idle' });
  }

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

  saveSettings() {
    if (!this.options.settingsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.options.settingsFile), { recursive: true });
      fs.writeFileSync(this.options.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.warn(`[archive] could not save settings: ${error.message}`);
    }
  }

  validateDays(days) {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > this.options.maxDays) {
      throw new Error(`Days must be a whole number from 1 to ${this.options.maxDays}`);
    }
    return value;
  }

  info() {
    return {
      settings: this.settings,
      defaults: { root: this.options.defaultRoot, days: this.options.defaultDays, auto: this.options.defaultAuto },
      limits: { maxDays: this.options.maxDays },
      status: this.status(),
    };
  }

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
   * During a background refresh the previously loaded data stays queryable, so the status describes that
   * data (range, counts, revision, generation) plus the refresh's progress fields.
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
    };
  }

  busy() {
    return this.state.state === 'listing' || this.state.state === 'scanning';
  }

  hasData() {
    return this.samples.length > 0 || this.coverage.length > 0 || this.solution.length > 0 || this.bestsats.length > 0;
  }

  update(patch, force = false) {
    Object.assign(this.state, patch);
    const now = Date.now();
    if (!force && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.emit('status', this.status());
  }

  addError(message) {
    if (this.state.errors.length < MAX_ERRORS) this.state.errors.push(message);
  }

  /** Starts loading `days` of history from `root`, replacing any loaded or in-progress archive. */
  load(request = {}) {
    this.assertAvailable();
    const root = validateRoot(request.root === undefined ? this.settings.root : request.root);
    const days = this.validateDays(request.days === undefined ? this.settings.days : request.days);
    this.settings = { ...this.settings, root, days };
    this.saveSettings();
    return this.start(root, days, false);
  }

  /**
   * A background start keeps the loaded data visible (and queryable) until the new load finishes;
   * it is swapped in only on success, and restored on failure or cancellation.
   */
  start(root, days, background) {
    this.assertAvailable();
    this.stopStream();
    const generation = ++this.generation;
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
      if (generation !== this.generation) return;
      this.stopStream();
      this.autoState.lastError = error.message;
      console.warn(`[archive] load failed: ${error.message}; live receiver data is unaffected`);
      if (this.view) {
        this.restoreView();
        this.update({ message: `Refresh failed (${error.message}); showing the previously loaded data` }, true);
      } else {
        this.update({ state: 'error', message: error.message, currentFile: null, finishedAt: Date.now() }, true);
      }
    });
    return this.status();
  }

  restoreView() {
    const { data, state } = this.view;
    this.view = null;
    Object.assign(this, data);
    this.state = state;
  }

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

  /** Unloads everything and turns automatic refresh off, so the archive stays unloaded. */
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

  /** Turns automatic loading on (loading now unless busy) or off. */
  setAuto(enabled) {
    this.settings = { ...this.settings, auto: Boolean(enabled) };
    this.saveSettings();
    this.autoState.lastError = null;
    if (this.settings.auto) this.scheduleAuto(0);
    else this.stopAuto();
    this.update({}, true);
    return this.status();
  }

  startAuto(delayMs = 0) {
    if (this.settings.auto) this.scheduleAuto(delayMs);
  }

  stopAuto() {
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.autoState.nextRunAt = null;
  }

  scheduleAuto(delayMs) {
    clearTimeout(this.autoTimer);
    this.autoState.nextRunAt = Date.now() + delayMs;
    this.autoTimer = setTimeout(() => this.autoTick(), delayMs);
    if (typeof this.autoTimer.unref === 'function') this.autoTimer.unref();
  }

  /** One automatic refresh. Never interrupts a load in progress and never piles up behind a hung NAS. */
  autoTick() {
    this.autoTimer = null;
    if (!this.settings.auto) return;
    if (this.busy()) {
      this.scheduleAuto(this.options.busyRetryMs);
      return;
    }
    if (this.hung > 0 || this.pendingFs > 0) {
      this.autoState.lastError = 'The network folder has not answered an earlier request yet; will retry';
      this.scheduleAuto(this.options.refreshMs);
      this.update({}, true);
      return;
    }
    this.autoState.lastRunAt = Date.now();
    this.scheduleAuto(this.options.refreshMs);
    this.start(this.settings.root, this.settings.days, true);
  }

  assertAvailable() {
    if (this.hung > 0 || this.pendingFs > 0 || (this.stream && !this.stream.closed)) {
      throw new Error('Archive network folder still has an outstanding request; wait before retrying. Live data is unaffected.');
    }
  }

  /** Bounds a NAS call; a call that times out is still counted until it finally settles. */
  async withTimeout(promise, label) {
    this.pendingFs++;
    const settled = () => { this.pendingFs--; };
    Promise.resolve(promise).then(settled, settled);
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
      if (timedOut) this.trackHung(promise);
    }
  }

  trackHung(promise) {
    this.hung++;
    const done = () => { this.hung--; };
    Promise.resolve(promise).then(done, done);
  }

  stopStream() {
    const stream = this.stream;
    this.stream = null;
    const cancel = this.cancelScan;
    this.cancelScan = null;
    if (cancel) cancel();
    if (stream) {
      if (!stream.closed) this.trackHung(new Promise((resolve) => stream.once('close', resolve)));
      stream.destroy();
    }
  }

  async run(generation) {
    const { root, from, to } = this.state;
    const files = await this.listFiles(root, from, to, generation);
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
      const cached = Boolean(summary);
      try {
        if (!summary) {
          summary = await this.scanFile(file, generation, bytesBefore);
          if (!summary || generation !== this.generation) return;
          await this.writeCache(file, summary);
        }
      } catch (error) {
        if (generation !== this.generation) return;
        if (error.fatal || NETWORK_ERRORS.has(error.code)) {
          throw new Error(`${path.basename(file.path)}: ${error.message}`);
        }
        this.addError(`${path.basename(file.path)}: ${error.message}`);
        summary = null;
      }
      if (generation !== this.generation) return;
      if (summary) this.addSummary(summary, from, to);
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
    if (this.view) {
      this.view = null;
      this.dataGeneration = generation;
    }
    this.autoState.lastError = null;
    this.update({ state: 'ready', currentFile: null, finishedAt: Date.now() }, true);
  }

  /** Lists `root\YYYY\DDD\*.LOG` files that can contain reports between `from` and `to`. */
  async listFiles(root, from, to, generation = this.generation) {
    try {
      await this.withTimeout(fs.promises.access(root), `Archive folder ${root}`);
    } catch (error) {
      if (error.fatal) throw new Error(`Archive folder ${root} is not reachable (${error.message})`);
      throw new Error(`Archive folder ${root} is not reachable (${error.code || error.message})`);
    }
    if (generation !== this.generation) return [];
    const folders = [];
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

    // A file's reports run until the next file starts, so earlier files cannot reach `from`.
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
    const read = async () => {
      for await (const chunk of stream) {
        if (generation !== this.generation) return null;
        lastDataAt = Date.now();
        scanner.push(chunk);
        bytes += chunk.length;
        this.update({ bytesDone: bytesBefore + bytes });
      }
      if (generation !== this.generation) return null;
      scanner.end();
      return summary.toJSON();
    };
    try {
      return await Promise.race([read(), abandoned]);
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    } finally {
      clearInterval(watchdog);
      if (this.stream === stream) this.stopStream();
    }
  }

  cachePath(file) {
    if (!this.options.cacheDir) return null;
    const key = crypto.createHash('sha1').update(file.path.toLowerCase()).digest('hex');
    return path.join(this.options.cacheDir, `${key}.json.gz`);
  }

  async readCache(file) {
    const cachePath = this.cachePath(file);
    if (!cachePath) return null;
    try {
      const parsed = JSON.parse(await gunzip(await fs.promises.readFile(cachePath)));
      if (parsed.version !== CACHE_VERSION || parsed.path !== file.path || parsed.size !== file.size
        || parsed.mtimeMs !== file.mtimeMs || !Array.isArray(parsed.coverage) || !Array.isArray(parsed.samples)
        || !Array.isArray(parsed.solution) || !Number.isFinite(parsed.solutionReports)
        || !Number.isFinite(parsed.solutionResolutionMs) || !Array.isArray(parsed.bestsats)
        || !Number.isFinite(parsed.bestsatsReports) || !Number.isFinite(parsed.bestsatsResolutionMs)) {
        return null;
      }
      return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[archive] ignoring cache for ${file.path}: ${error.message}`);
      return null;
    }
  }

  async writeCache(file, summary) {
    const cachePath = this.cachePath(file);
    if (!cachePath) return;
    try {
      await fs.promises.mkdir(this.options.cacheDir, { recursive: true });
      const payload = await gzip(JSON.stringify({
        version: CACHE_VERSION, path: file.path, size: file.size, mtimeMs: file.mtimeMs, ...summary,
      }));
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, payload);
      await fs.promises.rename(temporary, cachePath);
    } catch (error) {
      console.warn(`[archive] could not cache ${file.path}: ${error.message}`);
    }
  }

  pruneCache() {
    const dir = this.options.cacheDir;
    if (!dir) return;
    try {
      const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json.gz'))
        .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }));
      if (entries.length <= this.options.maxCacheFiles) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of entries.slice(0, entries.length - this.options.maxCacheFiles)) {
        fs.unlinkSync(path.join(dir, entry.name));
      }
    } catch (error) {
      console.warn(`[archive] could not prune cache: ${error.message}`);
    }
  }

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

  /** Halves detection resolution (keeping the strongest per signal and bucket) until within the limit. */
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
   * Returns loaded history between `from` and `to` reduced to at most `buckets` time buckets:
   * the strongest sample per signal per bucket, and coverage runs merged across sub-bucket gaps.
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

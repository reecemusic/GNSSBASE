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

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DAY_MS = 86400000;
const IT_MESSAGE_ID = 2065;
const LONG_HEADER_LENGTH = 28;
const MAX_FRAME_BYTES = 1 << 16;
const MAX_ASCII_LINE_BYTES = 16 * 1024;
const SYNC = Buffer.from([0xaa, 0x44, 0x12]);
const ASCII_MARKER = Buffer.from('#ITDETECTSTATUSA,');
// Reports further apart than this are treated as a gap in coverage, matching the live timeline.
const COVERAGE_GAP_MS = 15000;
const CACHE_VERSION = 2;
const MAX_DETECTIONS_PER_SAMPLE = 32;
const MAX_ERRORS = 20;
const MAX_QUERY_BUCKETS = 4000;
const READ_CHUNK_BYTES = 1 << 20;
const FILE_NAME_TIME = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.LOG$/i;
// File names and day folders may use local time; allow for any time zone offset.
const FILE_TIME_TOLERANCE_MS = 14 * 3600000;
const PROGRESS_INTERVAL_MS = 500;

/** True when sample `a` should replace `b` as the strongest report in a bucket. */
function stronger(a, b) {
  if ((a.count > 0) !== (b.count > 0)) return a.count > 0;
  const aPower = Number.isFinite(a.maxPower);
  const bPower = Number.isFinite(b.maxPower);
  if (aPower !== bPower) return aPower;
  if (aPower && a.maxPower !== b.maxPower) return a.maxPower > b.maxPower;
  return a.count > b.count;
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
 * Accumulates one log file's ITDETECTSTATUS reports compactly: clear reporting is stored as
 * coverage runs, and detections keep only the strongest sample per signal per second.
 */
class FileSummary {
  constructor() {
    this.reportCount = 0;
    this.crcErrors = 0;
    this.coverage = [];
    this.samples = [];
    this.lastBySignal = new Map();
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
    };
  }
}

/**
 * Incremental scanner for NovAtel log files. Only ITDETECTSTATUS (binary ID 2065 or
 * `#ITDETECTSTATUSA`) is decoded; every other binary frame is skipped by its length
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
    const data = decodeItDetectStatusBinary(buf.subarray(start + LONG_HEADER_LENGTH, start + total - 4));
    summary.addReport(t, data.detections);
  }

  function handleAscii(line) {
    const parsed = parseAsciiLog(line);
    if (!parsed || parsed.crcValid === false) {
      summary.crcErrors++;
      return;
    }
    if (!parsed.header.week) return;
    const t = gpsToMs(parsed.header.week, parsed.header.seconds);
    summary.addReport(t, interpretItDetectStatus(parsed).detections);
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
    let nextAscii = -2;
    const asciiFrom = (from) => {
      if (nextAscii === -1) return -1;
      if (nextAscii < from) nextAscii = buf.indexOf(ASCII_MARKER, from);
      return nextAscii;
    };

    for (;;) {
      const sync = buf.indexOf(SYNC, i);
      const ascii = asciiFrom(i);
      if (sync === -1 && ascii === -1) {
        carry = Buffer.from(buf.subarray(Math.max(i, buf.length - ASCII_MARKER.length)));
        return;
      }
      if (ascii !== -1 && (sync === -1 || ascii < sync)) {
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
      if (buf.readUInt16LE(sync + 4) !== IT_MESSAGE_ID) {
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

  return { push };
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
      now: () => Date.now(),
      ...options,
    };
    this.generation = 0;
    this.stream = null;
    this.lastProgressAt = 0;
    this.settings = this.readSettings();
    this.reset({ state: 'idle' });
  }

  readSettings() {
    const defaults = { root: this.options.defaultRoot, days: this.options.defaultDays };
    if (!this.options.settingsFile) return defaults;
    try {
      const saved = JSON.parse(fs.readFileSync(this.options.settingsFile, 'utf8'));
      return {
        root: validateRoot(saved.root),
        days: this.validateDays(saved.days),
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
      defaults: { root: this.options.defaultRoot, days: this.options.defaultDays },
      limits: { maxDays: this.options.maxDays },
      status: this.status(),
    };
  }

  reset(patch) {
    this.coverage = [];
    this.samples = [];
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
      crcErrors: 0,
      errors: [],
      message: null,
      startedAt: null,
      finishedAt: null,
      revision: 0,
      ...patch,
    };
  }

  status() {
    return {
      ...this.state,
      errors: this.state.errors.slice(),
      samples: this.samples.length,
      resolutionMs: this.resolutionMs,
      generation: this.generation,
    };
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
    const root = validateRoot(request.root === undefined ? this.settings.root : request.root);
    const days = this.validateDays(request.days === undefined ? this.settings.days : request.days);
    this.settings = { root, days };
    this.saveSettings();
    this.stopStream();
    const generation = ++this.generation;
    const to = this.options.now();
    this.reset({
      state: 'listing', root, days, from: to - days * DAY_MS, to, startedAt: Date.now(),
      message: `Searching ${root} for log files`,
    });
    this.update({}, true);
    this.run(generation).catch((error) => {
      if (generation !== this.generation) return;
      this.update({ state: 'error', message: error.message, currentFile: null, finishedAt: Date.now() }, true);
    });
    return this.status();
  }

  cancel() {
    if (this.state.state !== 'listing' && this.state.state !== 'scanning') return this.status();
    this.generation++;
    this.stopStream();
    this.update({
      state: 'cancelled', currentFile: null, finishedAt: Date.now(),
      message: 'Loading cancelled; files already read remain available',
    }, true);
    return this.status();
  }

  clear() {
    this.generation++;
    this.stopStream();
    this.reset({ state: 'idle', message: 'Archive unloaded' });
    this.update({}, true);
    return this.status();
  }

  stopStream() {
    if (this.stream) this.stream.destroy();
    this.stream = null;
  }

  async run(generation) {
    const { root, from, to } = this.state;
    const files = await this.listFiles(root, from, to);
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
      const cached = Boolean(summary);
      try {
        if (!summary) {
          summary = await this.scanFile(file, generation, bytesBefore);
          if (!summary) return;
          await this.writeCache(file, summary);
        }
      } catch (error) {
        if (generation !== this.generation) return;
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
        crcErrors: this.state.crcErrors + (summary ? summary.crcErrors : 0),
        revision: this.state.revision + 1,
      });
    }
    this.ensureSorted();
    this.pruneCache();
    this.update({ state: 'ready', currentFile: null, finishedAt: Date.now() }, true);
  }

  /** Lists `root\YYYY\DDD\*.LOG` files that can contain reports between `from` and `to`. */
  async listFiles(root, from, to) {
    try {
      await fs.promises.access(root);
    } catch (error) {
      throw new Error(`Archive folder ${root} is not reachable (${error.code || error.message})`);
    }
    const folders = [];
    const firstYear = new Date(from - DAY_MS).getUTCFullYear();
    const lastYear = new Date(to + DAY_MS).getUTCFullYear();
    for (let year = firstYear; year <= lastYear; year++) {
      let entries;
      try {
        entries = await fs.promises.readdir(path.join(root, String(year)), { withFileTypes: true });
      } catch (error) {
        if (error.code !== 'ENOENT') this.addError(`${year}: ${error.message}`);
        continue;
      }
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
        names = (await fs.promises.readdir(folder.dir)).filter((name) => /\.log$/i.test(name)).sort();
      } catch (error) {
        this.addError(`${folder.dir}: ${error.message}`);
        continue;
      }
      for (const name of names) {
        const filePath = path.join(folder.dir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) continue;
          files.push({
            path: filePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs),
            start: fileNameTime(name) ?? folder.dayStart, folderStart: folder.dayStart,
          });
        } catch (error) {
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
    const summary = new FileSummary();
    const scanner = createItDetectScanner(summary);
    const stream = fs.createReadStream(file.path, { highWaterMark: READ_CHUNK_BYTES });
    this.stream = stream;
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        if (generation !== this.generation) return null;
        scanner.push(chunk);
        bytes += chunk.length;
        this.update({ bytesDone: bytesBefore + bytes });
      }
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    } finally {
      if (this.stream === stream) this.stream = null;
      stream.destroy();
    }
    return generation === this.generation ? summary.toJSON() : null;
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
        || parsed.mtimeMs !== file.mtimeMs || !Array.isArray(parsed.coverage) || !Array.isArray(parsed.samples)) {
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
    this.ensureSorted();
    const start = Number(from);
    const end = Number(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('A valid from/to range is required');
    const count = Math.max(10, Math.min(MAX_QUERY_BUCKETS, Math.floor(Number(buckets)) || 1000));
    const bucketMs = Math.max(this.resolutionMs, Math.ceil((end - start) / count));

    let low = 0;
    let high = this.samples.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.samples[mid].t < start) low = mid + 1;
      else high = mid;
    }
    const chosen = new Map();
    let detectionSamples = 0;
    for (let index = low; index < this.samples.length && this.samples[index].t <= end; index++) {
      const sample = this.samples[index];
      if (sample.count > 0) detectionSamples++;
      const key = `${sample.signal}:${Math.floor((sample.t - start) / bucketMs)}`;
      const previous = chosen.get(key);
      if (!previous || stronger(sample, previous)) chosen.set(key, sample);
    }

    const coverage = [];
    const mergeGap = Math.max(COVERAGE_GAP_MS, bucketMs);
    for (const [runStart, runEnd] of this.coverage) {
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
      resolutionMs: this.resolutionMs,
      revision: this.state.revision,
      detectionSamples,
      coverage,
      samples: [...chosen.values()].sort((a, b) => a.t - b.t),
    };
  }
}

module.exports = {
  InterferenceArchive, FileSummary, createItDetectScanner, fileNameTime, validateRoot, COVERAGE_GAP_MS,
};

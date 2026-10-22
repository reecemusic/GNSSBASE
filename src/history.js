'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_TRACKS = 512;
let temporarySerial = 0;

function temporaryPath(filePath) {
  temporarySerial += 1;
  return `${filePath}.${process.pid}.${Date.now()}.${temporarySerial}.tmp`;
}

/** Replaces `destination`. On Windows, rename over an existing file throws EPERM or EEXIST. */
function replaceFileSync(destination, temporary) {
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  }
}

async function replaceFile(destination, temporary) {
  try {
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
  }
}

/**
 * Time-bounded history of satellite positions and interference detections.
 *
 * Everything is pruned to `retentionMs`, so both memory and the on-disk file stay
 * bounded regardless of uptime. Satellite tracks are additionally thinned to one
 * sample per `trackSampleMs` per satellite.
 */
class History {
  constructor(options) {
    this.retentionMs = options.retentionMs;
    this.trackSampleMs = options.trackSampleMs;
    this.maxInterferenceSamples = options.maxInterferenceSamples;
    this.filePath = options.filePath;
    this.tracks = new Map();
    this.interference = [];
    this.solution = [];
    this.trackCapWarned = false;
    this._saveChain = Promise.resolve();
  }

  /**
   * Records satellites used and fix type from BESTPOS. Unchanged solutions are thinned to one
   * sample per SOLUTION_HEARTBEAT_MS so a 1 Hz log costs a few thousand samples per day.
   */
  addSolution(data, timestamp = Date.now()) {
    const sample = solutionSample(data, timestamp);
    if (!sample) return;
    const last = this.solution[this.solution.length - 1];
    if (last && timestamp - last.t < SOLUTION_HEARTBEAT_MS && last.used === sample.used
      && last.tracked === sample.tracked && last.status === sample.status && last.type === sample.type) return;
    this.solution.push(sample);
    if (this.solution.length > this.maxInterferenceSamples) {
      this.solution.splice(0, this.solution.length - this.maxInterferenceSamples);
    }
  }

  addSatellites(system, satellites, timestamp = Date.now()) {
    for (const sat of satellites) {
      if (!isValidSkyPosition(sat.elevation, sat.azimuth)) continue;

      const key = `${system}:${sat.prn}`;
      if (!this.tracks.has(key) && this.tracks.size >= MAX_TRACKS) {
        if (!this.trackCapWarned) {
          this.trackCapWarned = true;
          console.warn(`[history] satellite track cap of ${MAX_TRACKS} reached; further satellites are not stored`);
        }
        continue;
      }
      const samples = this.tracks.get(key) || [];
      const last = samples[samples.length - 1];
      if (last && timestamp - last.t < this.trackSampleMs) continue;

      samples.push({ t: timestamp, el: round(sat.elevation, 2), az: round(sat.azimuth, 2) });
      this.tracks.set(key, samples);
    }
  }

  addInterference(signalType, detections, timestamp = Date.now()) {
    const powers = detections.map((d) => d.powerDbm).filter(Number.isFinite);
    this.interference.push({
      t: timestamp,
      signal: signalType,
      count: detections.length,
      maxPower: powers.length ? Math.max(...powers) : null,
      freq: detections.length && Number.isFinite(detections[0].centerFrequencyHz)
        ? detections[0].centerFrequencyHz
        : null,
      detections: detections.map((detection) => ({
        freq: Number.isFinite(detection.centerFrequencyHz) ? detection.centerFrequencyHz : null,
        bandwidth: Number.isFinite(detection.bandwidthHz) ? detection.bandwidthHz : null,
        power: Number.isFinite(detection.powerDbm) ? detection.powerDbm : null,
        type: detection.type || '',
      })),
    });
    if (this.interference.length > this.maxInterferenceSamples) {
      this.interference.splice(0, this.interference.length - this.maxInterferenceSamples);
    }
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    for (const [key, samples] of this.tracks) {
      if (!Array.isArray(samples)) {
        console.warn(`[history] discarding malformed track ${key}`);
        this.tracks.delete(key);
        continue;
      }
      const kept = samples.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff
        && isValidSkyPosition(s.el, s.az));
      if (kept.length) this.tracks.set(key, kept);
      else this.tracks.delete(key);
    }
    this.interference = this.interference.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff)
      .slice(-this.maxInterferenceSamples);
    this.solution = (Array.isArray(this.solution) ? this.solution : [])
      .filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff)
      .slice(-this.maxInterferenceSamples);
  }

  /**
   * History no older than `windowMs`, capped by the configured retention. When more samples exist than
   * `limit`, older data is reduced (strongest report per signal per time bucket; latest solution per
   * bucket) instead of being cut off, so a 24 h window still reaches back 24 h.
   */
  since(windowMs, now = Date.now(), limit = this.maxInterferenceSamples) {
    const cutoff = now - Math.min(windowMs, this.retentionMs);
    const tracks = {};
    for (const [key, samples] of this.tracks) {
      const kept = samples.filter((s) => s.t >= cutoff);
      if (kept.length > 1) tracks[key] = kept;
    }
    return {
      retentionMinutes: Math.round(this.retentionMs / 60000),
      tracks,
      interference: reduceInterference(this.interference.filter((s) => s.t >= cutoff), limit),
      solution: reduceLatest(this.solution.filter((s) => s.t >= cutoff), limit),
    };
  }

  serialize() {
    this.prune();
    return JSON.stringify({
      version: 1,
      satvisFieldLayout: 2,
      savedAt: Date.now(),
      tracks: Object.fromEntries(this.tracks),
      interference: this.interference,
      solution: this.solution,
    });
  }

  /** Periodic save. Stringify failures are reported before the first await so a timer cannot reject. */
  save() {
    if (!this.filePath) return Promise.resolve();
    let payload;
    try {
      payload = this.serialize();
    } catch (err) {
      console.warn(`[history] could not save: ${err.message}`);
      return Promise.resolve();
    }
    const write = this._saveChain.then(() => this.writePayload(payload)).catch((err) => {
      console.warn(`[history] could not save: ${err.message}`);
    });
    this._saveChain = write.then(() => {}, () => {});
    return write;
  }

  async writePayload(payload) {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = temporaryPath(this.filePath);
    await fs.promises.writeFile(temporary, payload);
    await replaceFile(this.filePath, temporary);
  }

  /** Shutdown flush. Must finish before the process exits. */
  saveSync() {
    if (!this.filePath) return;
    try {
      const payload = this.serialize();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = temporaryPath(this.filePath);
      fs.writeFileSync(temporary, payload);
      replaceFileSync(this.filePath, temporary);
    } catch (err) {
      console.warn(`[history] could not save: ${err.message}`);
    }
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      if (fs.statSync(this.filePath).size > 64 * 1024 * 1024) throw new Error('History file exceeds the 64 MiB load limit');
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== 1) throw new Error('Unsupported history file version');
      this.tracks = parsed.satvisFieldLayout === 2
        ? new Map(Object.entries(parsed.tracks || {}))
        : new Map();
      this.interference = Array.isArray(parsed.interference) ? parsed.interference : [];
      this.solution = Array.isArray(parsed.solution) ? parsed.solution : [];
      this.prune();
      console.log(`[history] restored ${this.tracks.size} satellite tracks, ${this.interference.length} interference samples, `
        + `${this.solution.length} solution samples`);
    } catch (err) {
      console.warn(`[history] could not load: ${err.message}`);
      this.tracks = new Map();
      this.interference = [];
      this.solution = [];
    }
  }
}

const SOLUTION_HEARTBEAT_MS = 10000;

/**
 * Time-sorted samples cut to at most `limit`: the newest half stay untouched and older samples are merged
 * into ever larger time buckets (`key` groups samples within a bucket, `keep` picks the survivor).
 */
function reduceSamples(samples, limit, key, keep) {
  if (samples.length <= limit) return samples;
  const recentCount = Math.floor(limit / 2);
  const recent = samples.slice(samples.length - recentCount);
  const older = samples.slice(0, samples.length - recentCount);
  const budget = limit - recentCount;
  let reduced = older;
  for (let bucketMs = 1000; reduced.length > budget && bucketMs < 1e12; bucketMs *= 2) {
    const kept = new Map();
    for (const sample of older) {
      const id = `${key(sample)}:${Math.floor(sample.t / bucketMs)}`;
      const previous = kept.get(id);
      kept.set(id, previous ? keep(previous, sample) : sample);
    }
    reduced = [...kept.values()].sort((a, b) => a.t - b.t);
  }
  return [...reduced.slice(-budget), ...recent];
}

function reduceInterference(samples, limit) {
  return reduceSamples(samples, limit, (sample) => sample.signal, (previous, sample) => {
    if ((sample.count > 0) !== (previous.count > 0)) return sample.count > 0 ? sample : previous;
    if (Number.isFinite(sample.maxPower) && (!Number.isFinite(previous.maxPower) || sample.maxPower > previous.maxPower)) {
      return sample;
    }
    return previous;
  });
}

function reduceLatest(samples, limit) {
  return reduceSamples(samples, limit, () => '', (previous, sample) => sample);
}

function solutionSample(data, timestamp) {
  if (!data || !Number.isFinite(timestamp)) return null;
  const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 255 ? value : null);
  const text = (value) => (typeof value === 'string' && value ? value.slice(0, 32) : null);
  const sample = {
    t: timestamp,
    used: count(data.satellitesUsed),
    tracked: count(data.satellitesTracked),
    status: text(data.solutionStatus),
    type: text(data.positionType),
  };
  return sample.used === null && sample.type === null ? null : sample;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isValidSkyPosition(elevation, azimuth) {
  return Number.isFinite(elevation) && elevation >= 0 && elevation <= 90
    && Number.isFinite(azimuth) && azimuth >= 0 && azimuth < 360;
}

module.exports = {
  History, SOLUTION_HEARTBEAT_MS, solutionSample, MAX_TRACKS, replaceFile, replaceFileSync,
};

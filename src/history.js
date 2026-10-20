'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  }

  addSatellites(system, satellites, timestamp = Date.now()) {
    for (const sat of satellites) {
      if (!isValidSkyPosition(sat.elevation, sat.azimuth)) continue;

      const key = `${system}:${sat.prn}`;
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
  }

  /** History no older than `windowMs`, capped by the configured retention. */
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
      interference: this.interference.filter((s) => s.t >= cutoff).slice(-limit),
    };
  }

  save() {
    if (!this.filePath) return;
    try {
      this.prune();
      const payload = JSON.stringify({
        version: 1,
        satvisFieldLayout: 2,
        savedAt: Date.now(),
        tracks: Object.fromEntries(this.tracks),
        interference: this.interference,
      });
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, payload);
      fs.renameSync(temporary, this.filePath);
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
      this.prune();
      console.log(`[history] restored ${this.tracks.size} satellite tracks, ${this.interference.length} interference samples`);
    } catch (err) {
      console.warn(`[history] could not load: ${err.message}`);
      this.tracks = new Map();
      this.interference = [];
    }
  }
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isValidSkyPosition(elevation, azimuth) {
  return Number.isFinite(elevation) && elevation >= 0 && elevation <= 90
    && Number.isFinite(azimuth) && azimuth >= 0 && azimuth < 360;
}

module.exports = { History };

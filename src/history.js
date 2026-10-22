/**
 * Bounded history of satellite tracks, interference reports, and solution heartbeats.
 * Samples older than the retention window are dropped. Saves write a temp file and
 * rename it into place, keeping the previous file as .bak. The temp file is fsynced,
 * and the directory is fsynced when the OS allows it, before that rename. A file
 * that fails the size, JSON, or version check is not overwritten while it is the
 * only copy. An empty or all-zero file is recoverable. A corrupt file with a
 * readable .bak is moved aside and saving resumes from that backup.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Upper bound on satellite track keys. New satellites past this are not stored. */
const MAX_TRACKS = 512;
/**
 * Same cap as the archive (src/archive.js MAX_DETECTIONS_PER_SAMPLE). A live sample
 * keeps the first 32 detections. count and maxPower still describe the full list,
 * so a chart can show "40 detections" while the file cannot grow without bound.
 */
const MAX_DETECTIONS_PER_SAMPLE = 32;
/** readStored rejects a larger file. payloadForSave downsamples until the JSON fits. */
const HISTORY_LOAD_LIMIT = 64 * 1024 * 1024;
/** Separates temp names created in the same process and millisecond. */
let temporarySerial = 0;

/**
 * Builds a temp path beside filePath.
 * @param {string} filePath Destination the caller will replace with this temp file.
 * @returns {string} filePath plus pid, Date.now(), and an incrementing serial, ending in .tmp.
 * Side effects: increments temporarySerial. No I/O.
 * @emits none
 */
function temporaryPath(filePath) {
  temporarySerial += 1;
  return `${filePath}.${process.pid}.${Date.now()}.${temporarySerial}.tmp`;
}

/**
 * Replaces destination with the temp file.
 * When destination is missing, renames the temp onto it. When it exists, deletes the
 * old .bak, renames destination to .bak, then renames the temp to destination.
 * If that second rename throws, moves the .bak back and rethrows.
 * On Windows, rename onto an existing file throws EPERM or EEXIST; moveAsideSync
 * deletes the target and retries the rename once. The old .bak is removed first so
 * the rename of destination onto .bak does not hit an existing file.
 * @param {string} destination Final path.
 * @param {string} temporary Temp file that already holds the new bytes.
 * @returns {void}
 * Side effects: rename and rm. Throws the rename error after the restore attempt.
 *   A failed restore is logged by restoreBackupSync and not rethrown.
 * @emits none
 */
function replaceFileSync(destination, temporary) {
  // Destination missing: rename the temp onto it.
  if (!fs.existsSync(destination)) {
    fs.renameSync(temporary, destination);
    return;
  }
  const backup = `${destination}.bak`;
  // Destination exists. Delete the old .bak, move destination aside, then move the temp into place.
  fs.rmSync(backup, { force: true });
  moveAsideSync(destination, backup);
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    // The second rename failed. Move the .bak back, then rethrow.
    restoreBackupSync(backup, destination);
    throw error;
  }
}

/**
 * Async form of replaceFileSync.
 * access() with ENOENT means destination is missing, and the temp is renamed onto it.
 * Any other access error is rethrown. When destination exists, deletes the old .bak,
 * renames destination to .bak, then renames the temp to destination. If that second
 * rename throws, moves the .bak back and rethrows.
 * @param {string} destination Final path.
 * @param {string} temporary Temp file that already holds the new bytes.
 * @returns {Promise<void>}
 * Side effects: rename and rm. Throws the rename error after the restore attempt.
 *   A failed restore is logged by restoreBackup and not rethrown.
 * @emits none
 */
async function replaceFile(destination, temporary) {
  try {
    await fs.promises.access(destination);
  } catch (error) {
    // ENOENT means destination is missing. Any other access error propagates.
    if (error.code !== 'ENOENT') throw error;
    await fs.promises.rename(temporary, destination);
    return;
  }
  const backup = `${destination}.bak`;
  // Destination exists. Delete the old .bak, move destination aside, then move the temp into place.
  await fs.promises.rm(backup, { force: true });
  await moveAside(destination, backup);
  try {
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    // The second rename failed. Move the .bak back, then rethrow.
    await restoreBackup(backup, destination);
    throw error;
  }
}

/**
 * Renames from onto to.
 * @param {string} from Path to move.
 * @param {string} to Target path.
 * @returns {void}
 * Side effects: rename. On EPERM or EEXIST, deletes to and retries the rename once.
 *   Any other error throws. The retry is not caught here.
 * @emits none
 */
function moveAsideSync(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    // On Windows, rename onto an existing file throws EPERM or EEXIST.
    // Delete the target and retry the rename once.
    if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
    fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  }
}

/**
 * Async form of moveAsideSync.
 * @param {string} from Path to move.
 * @param {string} to Target path.
 * @returns {Promise<void>}
 * Side effects: rename. On EPERM or EEXIST, deletes to and retries the rename once.
 *   Any other error throws. The retry is not caught here.
 * @emits none
 */
async function moveAside(from, to) {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    // On Windows, rename onto an existing file throws EPERM or EEXIST.
    // Delete the target and retry the rename once.
    if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
    await fs.promises.rm(to, { force: true });
    await fs.promises.rename(from, to);
  }
}

/**
 * Moves the .bak back onto destination after a failed replace.
 * @param {string} backup Path of the .bak.
 * @param {string} destination Path the .bak should occupy again.
 * @returns {void}
 * Side effects: moveAsideSync. On failure, console.warn and does not rethrow.
 * @emits none
 */
function restoreBackupSync(backup, destination) {
  try {
    moveAsideSync(backup, destination);
  } catch (error) {
    console.warn(`[history] could not restore ${destination} from backup: ${error.message}`);
  }
}

/**
 * Async form of restoreBackupSync.
 * @param {string} backup Path of the .bak.
 * @param {string} destination Path the .bak should occupy again.
 * @returns {Promise<void>}
 * Side effects: moveAside. On failure, console.warn and does not rethrow.
 * @emits none
 */
async function restoreBackup(backup, destination) {
  try {
    await moveAside(backup, destination);
  } catch (error) {
    console.warn(`[history] could not restore ${destination} from backup: ${error.message}`);
  }
}

/**
 * Flushes a temp file's bytes before it is renamed into place.
 * A rename alone does not push the data to disk. A power cut can then leave
 * history.json as a zero-length or all-zero file, which used to disable saves.
 * @param {string} filePath Temp file that already holds the new bytes.
 * @returns {Promise<void>}
 * Side effects: opens, fsyncs, and closes the file. Throws when open or fsync throws.
 * @emits none
 */
async function fsyncFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Synchronous form of fsyncFile, used by saveSync.
 * @param {string} filePath Temp file that already holds the new bytes.
 * @returns {void}
 * Side effects: openSync, fsyncSync, closeSync. Throws when those throw.
 * @emits none
 */
function fsyncFileSync(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Best-effort flush of the directory entry that names the history file.
 * After the temp file is fsynced, the rename still has to be recorded in the
 * directory. Windows and some filesystems throw on a directory fsync, so any
 * error is ignored. The file fsync has already happened.
 * @param {string} directory Parent directory of the history file.
 * @returns {Promise<void>}
 * Side effects: may open and fsync the directory. Swallows errors, including close errors.
 * @emits none
 */
async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every operating system.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Synchronous form of fsyncDirectory. Failures are ignored.
 * @param {string} directory Parent directory of the history file.
 * @returns {void}
 * Side effects: may open and fsync the directory. Swallows errors.
 * @emits none
 */
function fsyncDirectorySync(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not supported on every operating system.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the data fsync already finished */ }
    }
  }
}

/**
 * True when the file has no JSON in it: zero bytes, or only NULs and whitespace.
 * A power cut during rename often leaves exactly that. It is not treated as a
 * corrupt document that must be preserved.
 * @param {string} text File body. An empty string is empty.
 * @returns {boolean}
 * Side effects: none.
 * @emits none
 */
function isBlankHistory(text) {
  return text.length === 0 || /^[\0\s]*$/.test(text);
}

/**
 * Time-bounded history of satellite positions, interference detections, and solution heartbeats.
 * prune() drops samples older than retentionMs. Tracks are also thinned to one sample
 * per trackSampleMs per satellite, and new track keys stop at MAX_TRACKS.
 * A file that fails the size, JSON, or version check disables saves when it is the
 * only copy. An empty file, or a corrupt file with a good .bak, does not.
 */
class History {
  /**
   * Stores the limits and starts with empty samples. Does not read the file; call load().
   * @param {object} options retentionMs, trackSampleMs, maxInterferenceSamples, filePath,
   *   and optional maxFileBytes (defaults to HISTORY_LOAD_LIMIT, 64 MiB).
   * @returns {void}
   * Side effects: none beyond own properties. readState starts 'unread', savesDisabled is
   *   false, dirty is false, _saveGeneration is 0, and _saveChain is an already fulfilled promise.
   * @emits none
   */
  constructor(options) {
    this.retentionMs = options.retentionMs;
    this.trackSampleMs = options.trackSampleMs;
    this.maxInterferenceSamples = options.maxInterferenceSamples;
    this.filePath = options.filePath;
    // Anything this object writes must pass readStored. Tests pass a smaller budget.
    this.maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0
      ? options.maxFileBytes
      : HISTORY_LOAD_LIMIT;
    this.tracks = new Map();
    this.interference = [];
    this.solution = [];
    // Last kept interference sample per signal, so unchanged reports can be thinned.
    this.lastInterference = new Map();
    this.trackCapWarned = false;
    this.savesDisabled = false;
    this.saveSkipLogged = false;
    this.readState = 'unread';
    this.recheckMissing = false;
    this.retrySkipLogged = false;
    this.dirty = false;
    this._dirtyStamp = 0;
    this._saveQueued = false;
    this._saveGeneration = 0;
    this._saveChain = Promise.resolve();
  }

  /**
   * Marks memory as needing a disk write.
   * The stamp lets a save that is already encoding ignore mutations that happened
   * before it snapshotted, and keep dirty set when a sample arrives during the write.
   * @returns {void}
   * Side effects: sets dirty and increments _dirtyStamp. No I/O.
   * @emits none
   */
  markDirty() {
    this.dirty = true;
    this._dirtyStamp += 1;
  }

  /**
   * Records satellites used and fix type from BESTPOS.
   * Unchanged solutions (same used, tracked, status, and type) are kept once per
   * SOLUTION_HEARTBEAT_MS, which is 10 seconds. A change inside that window is stored.
   * @param {object} data BESTPOS fields read by solutionSample.
   * @param {number} [timestamp=Date.now()] Sample time in milliseconds.
   * @returns {void} Returns immediately when solutionSample returns null.
   * Side effects: pushes onto this.solution and drops samples from the front when the
   *   length passes maxInterferenceSamples. No I/O.
   * @emits none
   */
  addSolution(data, timestamp = Date.now()) {
    const sample = solutionSample(data, timestamp);
    if (!sample) return;
    const last = this.solution[this.solution.length - 1];
    // Same fix inside the 10 second heartbeat: keep the sample already stored.
    // A backwards clock step (timestamp < last.t) is stored. timestamp - last.t would
    // stay negative and the comparison with SOLUTION_HEARTBEAT_MS would never pass.
    if (last && timestamp >= last.t && timestamp - last.t < SOLUTION_HEARTBEAT_MS && last.used === sample.used
      && last.tracked === sample.tracked && last.status === sample.status && last.type === sample.type) return;
    this.solution.push(sample);
    this.markDirty();
    if (this.solution.length > this.maxInterferenceSamples) {
      this.solution.splice(0, this.solution.length - this.maxInterferenceSamples);
    }
  }

  /**
   * Appends sky positions for one constellation.
   * @param {string} system Constellation name. The track key is system, a colon, and prn.
   * @param {object[]} satellites Items with prn, elevation, and azimuth.
   * @param {number} [timestamp=Date.now()] Sample time in milliseconds.
   * @returns {void}
   * Side effects: mutates this.tracks. Skips an invalid sky position. A new key once
   *   tracks.size has reached MAX_TRACKS (512) is skipped, and that cap is logged once.
   *   A sample closer than trackSampleMs to the previous one is skipped. Elevation and
   *   azimuth are rounded to 2 digits. No other I/O.
   * @emits none
   */
  addSatellites(system, satellites, timestamp = Date.now()) {
    for (const sat of satellites) {
      if (!isValidSkyPosition(sat.elevation, sat.azimuth)) continue;

      const key = `${system}:${sat.prn}`;
      // MAX_TRACKS is 512. A satellite that already has a track is still updated.
      if (!this.tracks.has(key) && this.tracks.size >= MAX_TRACKS) {
        if (!this.trackCapWarned) {
          this.trackCapWarned = true;
          console.warn(`[history] satellite track cap of ${MAX_TRACKS} reached; further satellites are not stored`);
        }
        continue;
      }
      const samples = this.tracks.get(key) || [];
      const last = samples[samples.length - 1];
      // This satellite already has a sample within trackSampleMs, so the new one is skipped.
      // A backwards clock step (timestamp < last.t) is kept. Otherwise t - last.t stays
      // negative, the gap test stays true, and the track freezes until time catches up.
      if (last && timestamp >= last.t && timestamp - last.t < this.trackSampleMs) continue;

      samples.push({ t: timestamp, el: round(sat.elevation, 2), az: round(sat.azimuth, 2) });
      this.tracks.set(key, samples);
      this.markDirty();
    }
  }

  /**
   * Records one interference report.
   * @param {string} signalType Stored on the sample as signal.
   * @param {object[]} detections Items with powerDbm, centerFrequencyHz, bandwidthHz, and type.
   * @param {number} [timestamp=Date.now()] Sample time in milliseconds.
   * @returns {void}
   * Side effects: may push a sample and drop from the front past maxInterferenceSamples.
   *   An unchanged sample for the same signal inside SOLUTION_HEARTBEAT_MS (10 s) is
   *   skipped, same as a solution heartbeat, so a full day of steady interference
   *   stays inside maxInterferenceSamples. A backwards clock step is stored.
   *   maxPower is the largest finite powerDbm of the full list, or null. count is
   *   the full list length. At most MAX_DETECTIONS_PER_SAMPLE (32) detections are
   *   copied, matching the archive. The sample freq is the first detection's finite
   *   center frequency, or null. No I/O.
   * @emits none
   */
  addInterference(signalType, detections, timestamp = Date.now()) {
    const list = Array.isArray(detections) ? detections : [];
    const powers = list.map((d) => d.powerDbm).filter(Number.isFinite);
    const stored = list.slice(0, MAX_DETECTIONS_PER_SAMPLE).map((detection) => ({
      freq: Number.isFinite(detection.centerFrequencyHz) ? detection.centerFrequencyHz : null,
      bandwidth: Number.isFinite(detection.bandwidthHz) ? detection.bandwidthHz : null,
      power: Number.isFinite(detection.powerDbm) ? detection.powerDbm : null,
      type: detection.type || '',
    }));
    const count = list.length;
    const maxPower = powers.length ? Math.max(...powers) : null;
    const fingerprint = detectionFingerprint(stored);
    const last = this.lastInterference.get(signalType);
    // Unchanged report inside the 10 second heartbeat: keep the sample already stored.
    // timestamp < last.t is a backwards clock step and is stored, not skipped.
    if (last && timestamp >= last.t && timestamp - last.t < SOLUTION_HEARTBEAT_MS
      && last.count === count && last.maxPower === maxPower && last.fingerprint === fingerprint) return;
    this.interference.push({
      t: timestamp,
      signal: signalType,
      count,
      maxPower,
      freq: stored.length && Number.isFinite(stored[0].freq) ? stored[0].freq : null,
      detections: stored,
    });
    this.lastInterference.set(signalType, { t: timestamp, count, maxPower, fingerprint });
    this.markDirty();
    // A short burst keeps the newest samples. A long run is bucketed so the
    // start of the day is not thrown away once the cap is reached.
    if (this.interference.length > this.maxInterferenceSamples) {
      this.interference = capInterference(this.interference, this.maxInterferenceSamples);
    }
  }

  /**
   * Drops samples older than retentionMs, and track points that are not valid sky positions.
   * @param {number} [now=Date.now()] The cutoff is now minus retentionMs.
   * @returns {void}
   * Side effects: mutates tracks, interference, and solution. A track whose value is not
   *   an array is deleted and logged. Tracks with nothing left are deleted. interference
   *   and solution are reduced to maxInterferenceSamples with the same bucket rule as
   *   since(), so a 24 h span is kept instead of dropping the oldest hours. Those two
   *   lists are not tested as sky positions. No file I/O.
   * @emits none
   */
  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    for (const [key, samples] of this.tracks) {
      if (!Array.isArray(samples)) {
        console.warn(`[history] discarding malformed track ${key}`);
        this.tracks.delete(key);
        continue;
      }
      // Drop points older than the retention window and points that are not valid sky positions.
      const kept = samples.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff
        && isValidSkyPosition(s.el, s.az));
      if (kept.length) this.tracks.set(key, kept);
      else this.tracks.delete(key);
    }
    // Aged samples go. What remains is bucketed down to the cap instead of keeping
    // only the newest tail, which used to turn a 24 h window into 9–14 h.
    const keptInterference = this.interference.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff);
    this.interference = capInterference(keptInterference, this.maxInterferenceSamples);
    const keptSolution = (Array.isArray(this.solution) ? this.solution : [])
      .filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff);
    this.solution = reduceLatest(keptSolution, this.maxInterferenceSamples);
  }

  /**
   * History no older than windowMs, and no older than the configured retention.
   * When more interference or solution samples exist than limit, older data is reduced
   * (strongest report per signal per time bucket; latest solution per bucket) instead
   * of dropping the oldest samples, so the result still reaches the start of the window.
   * Track keys with fewer than two samples in the window are omitted.
   * @param {number} windowMs Requested look-back. The cutoff uses the smaller of windowMs and retentionMs.
   * @param {number} [now=Date.now()]
   * @param {number} [limit=this.maxInterferenceSamples]
   * @returns {object} retentionMinutes, tracks, interference, and solution.
   * Side effects: none. The filters allocate new arrays. prune is not called.
   * @emits none
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

  /**
   * Prunes, then JSON-encodes a version-1 document with satvisFieldLayout 2.
   * @returns {string}
   * Side effects: prune() mutates memory. savedAt is Date.now(). JSON.stringify can throw.
   * @emits none
   */
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

  /**
   * JSON for one save, downsampled until it is within maxFileBytes.
   * readStored rejects a file over HISTORY_LOAD_LIMIT (64 MiB). A save that
   * exceeded that limit used to disable saving on the next start. Oldest
   * interference and solution samples are bucketed, then track points, until
   * the document fits. The caller writes this string or skips the save.
   * @returns {string|null} Null when the document still does not fit. That is logged.
   * Side effects: prune via serialize, then shrinkForBudget may drop samples. console.warn
   *   when the result is still over the limit. JSON.stringify can throw.
   * @emits none
   */
  payloadForSave() {
    let payload = this.serialize();
    const limit = this.maxFileBytes;
    // Each pass halves the largest list. Forty passes is enough to empty every list.
    for (let guard = 0; Buffer.byteLength(payload) > limit && guard < 40; guard++) {
      if (!this.shrinkForBudget()) break;
      payload = JSON.stringify({
        version: 1,
        satvisFieldLayout: 2,
        savedAt: Date.now(),
        tracks: Object.fromEntries(this.tracks),
        interference: this.interference,
        solution: this.solution,
      });
    }
    if (Buffer.byteLength(payload) > limit) {
      console.warn(`[history] ${this.filePath} is still over the ${limit} byte load limit after downsampling; this save was skipped`);
      return null;
    }
    return payload;
  }

  /**
   * Drops about half of the largest stored series so the next JSON is smaller.
   * Interference is reduced first, then solution, then the longest satellite track,
   * then the last interference or solution sample. An empty history returns false.
   * @returns {boolean} True when something was removed.
   * Side effects: mutates interference, solution, or tracks. No I/O.
   * @emits none
   */
  shrinkForBudget() {
    if (this.interference.length > 1) {
      this.interference = reduceInterference(this.interference, Math.max(1, Math.floor(this.interference.length / 2)));
      return true;
    }
    if (this.solution.length > 1) {
      this.solution = reduceLatest(this.solution, Math.max(1, Math.floor(this.solution.length / 2)));
      return true;
    }
    let longestKey = null;
    let longest = 1;
    for (const [key, samples] of this.tracks) {
      if (Array.isArray(samples) && samples.length > longest) {
        longest = samples.length;
        longestKey = key;
      }
    }
    if (longestKey) {
      const samples = this.tracks.get(longestKey);
      // Drop the older half. One point is removed when the track has two points.
      samples.splice(0, Math.max(1, Math.ceil(samples.length / 2)));
      if (samples.length) this.tracks.set(longestKey, samples);
      else this.tracks.delete(longestKey);
      return true;
    }
    if (this.interference.length === 1) {
      const sample = this.interference[0];
      if (sample && Array.isArray(sample.detections) && sample.detections.length > 1) {
        sample.detections = sample.detections.slice(0, Math.floor(sample.detections.length / 2));
        return true;
      }
      this.interference = [];
      return true;
    }
    if (this.solution.length === 1) {
      this.solution = [];
      return true;
    }
    return false;
  }

  /**
   * Periodic save. Skips the disk when nothing changed since the last successful write.
   * Encodes JSON when the write starts, not when save() is called, and does not queue
   * a second copy while one write is in flight. A later flush() or save() still sees dirty.
   * @returns {Promise<void>} Fulfilled when there is nothing to write, when encoding throws,
   *   and when the chained write fails. Those failures are logged. The returned promise
   *   does not reject.
   * Side effects: may load() through readyToSave. payloadForSave runs before the first
   *   await when a write is not already queued. Increments _saveGeneration once per
   *   queued write. Appends writePayload to _saveChain. The chain itself swallows rejection.
   *   console.warn on failure. A second save() while a write is queued does not encode.
   * @emits none
   */
  save() {
    if (!this.readyToSave()) return Promise.resolve();
    // The interval calls this even when the receiver has been quiet. Do not rewrite the file.
    if (!this.dirty) return Promise.resolve();
    // One encode and one temp file at a time. A save that arrives while a write is
    // in flight does not build a second JSON string; dirty stays set for the next one.
    if (this._saveQueued) return this._saveChain;
    let payload;
    try {
      // Encode when this write starts, before the first await, so a circular
      // sample warns here instead of rejecting the timer.
      payload = this.payloadForSave();
    } catch (err) {
      console.warn(`[history] could not save: ${err.message}`);
      return Promise.resolve();
    }
    if (!payload) return Promise.resolve();
    const stamp = this._dirtyStamp;
    this._saveQueued = true;
    // writePayload no-ops once flush() or a later save moves _saveGeneration.
    const generation = ++this._saveGeneration;
    // The catch logs a write failure and fulfills. The chain ignores both outcomes so the next save still runs.
    const write = this._saveChain.then(() => this.writePayload(payload, generation)).then(() => {
      // A sample that arrived while the bytes were being written must not be forgotten.
      if (this.currentSave(generation) && this._dirtyStamp === stamp) this.dirty = false;
    }).catch((err) => {
      console.warn(`[history] could not save: ${err.message}`);
    }).finally(() => {
      this._saveQueued = false;
    });
    this._saveChain = write.then(() => {}, () => {});
    return write;
  }

  /**
   * Writes one snapshotted payload when it is still the current generation.
   * @param {string} payload JSON from serialize.
   * @param {number} generation _saveGeneration at the time save() took the snapshot.
   * @returns {Promise<void>}
   * Side effects: no-op when generation !== _saveGeneration or savesDisabled.
   *   Otherwise mkdir, write a temp file, fsync that file, best-effort fsync the
   *   directory, and replaceFileSync (the rename is synchronous). A generation
   *   change after the temp write deletes the temp and returns without renaming.
   *   A failed fsync or replace removes the temp, ignoring an rm error, and rethrows.
   *   Success sets readState to 'loaded' and recheckMissing to false.
   * @emits none
   */
  async writePayload(payload, generation) {
    // Generation mismatch or savesDisabled: do not touch the file.
    if (!this.currentSave(generation)) return;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = temporaryPath(this.filePath);
    await fs.promises.writeFile(temporary, payload);
    if (!this.currentSave(generation)) {
      await fs.promises.rm(temporary, { force: true });
      return;
    }
    try {
      // Durable bytes, then the directory entry, then the rename. An older rename
      // cannot finish after flush()'s snapshot because currentSave was checked above.
      await fsyncFile(temporary);
      await fsyncDirectory(path.dirname(this.filePath));
      if (!this.currentSave(generation)) {
        await fs.promises.rm(temporary, { force: true });
        return;
      }
      replaceFileSync(this.filePath, temporary);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    this.readState = 'loaded';
    this.recheckMissing = false;
  }

  /**
   * Synchronous save used by flush. Increments _saveGeneration and writes the current memory.
   * @returns {void} Returns immediately when readyToSave is false.
   * Side effects: returns immediately when nothing is dirty. Otherwise increments
   *   _saveGeneration, prune via payloadForSave, mkdirSync, writeFileSync, fsync of
   *   the temp file, best-effort directory fsync, and replaceFileSync. A failed
   *   replace deletes the temp and the outer catch logs the error. Success sets
   *   readState to 'loaded', recheckMissing to false, and clears dirty when no sample
   *   arrived during the write. Does not throw to the caller.
   * @emits none
   */
  saveSync() {
    if (!this.readyToSave()) return;
    // Shutdown and the periodic timer both call into here. An unchanged history is not rewritten.
    if (!this.dirty) return;
    // This synchronous snapshot becomes the current generation.
    this._saveGeneration++;
    try {
      const payload = this.payloadForSave();
      if (!payload) return;
      const stamp = this._dirtyStamp;
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = temporaryPath(this.filePath);
      fs.writeFileSync(temporary, payload);
      try {
        fsyncFileSync(temporary);
        fsyncDirectorySync(path.dirname(this.filePath));
        replaceFileSync(this.filePath, temporary);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      this.readState = 'loaded';
      this.recheckMissing = false;
      if (this._dirtyStamp === stamp) this.dirty = false;
    } catch (err) {
      console.warn(`[history] could not save: ${err.message}`);
    }
  }

  /**
   * Drops any in-flight periodic save, waits for that write to notice, then writes one snapshot.
   * Increments _saveGeneration, awaits _saveChain, then saveSync, which increments again
   * and writes synchronously. An older in-flight rename cannot land after the flush snapshot.
   * @returns {Promise<void>}
   * Side effects: the generation bump makes an in-flight writePayload skip its rename.
   *   saveSync performs the disk write and may log.
   * @emits none
   */
  async flush() {
    // Retire in-flight writePayload generations before waiting for them.
    this._saveGeneration++;
    // The in-flight write sees the new generation and skips its rename.
    await this._saveChain;
    // Increment again inside saveSync and write this snapshot synchronously.
    this.saveSync();
  }

  /**
   * Reports whether this generation should still be written.
   * @param {number} generation Generation captured by save().
   * @returns {boolean} False when savesDisabled or generation !== _saveGeneration.
   * Side effects: none.
   * @emits none
   */
  currentSave(generation) {
    return !this.savesDisabled && generation === this._saveGeneration;
  }

  /**
   * Decides whether a save may replace the file.
   * A locked or vanished file is read again before it is replaced. A file that failed
   * the size, JSON, or version check is never replaced, because savesDisabled makes
   * skipSave return true.
   * When readState is 'retry' or recheckMissing is set, calls load() again and skips
   * the write while readState stays 'retry'. When that later read succeeds, samples
   * taken during the lock are merged with the file (deduped by sample key) and this
   * returns true so the caller writes the merged memory.
   * @returns {boolean} False when filePath is empty, the read is still 'retry', or saves are disabled.
   * Side effects: may load() (disk read, memory merge, logs). console.warn once while retrying.
   * @emits none
   */
  readyToSave() {
    if (!this.filePath) return false;
    // A locked file, or a file that was missing once, is read again before it is replaced.
    if (this.readState === 'retry' || this.recheckMissing) this.load();
    // Still unreadable. Skip the write. Samples taken during the lock stay in memory.
    if (this.readState === 'retry') {
      if (!this.retrySkipLogged) {
        this.retrySkipLogged = true;
        console.warn(`[history] not saving yet; ${this.filePath} could not be read and will not be replaced`);
      }
      return false;
    }
    this.retrySkipLogged = false;
    return !this.skipSave();
  }

  /**
   * True when any track, interference sample, or solution sample is in memory.
   * @returns {boolean}
   * Side effects: none.
   * @emits none
   */
  hasSamples() {
    return this.tracks.size > 0 || this.interference.length > 0 || this.solution.length > 0;
  }

  /**
   * True when saves are disabled, so a bad file is not overwritten.
   * @returns {boolean} False when savesDisabled is false.
   * Side effects: the first skip logs a console warning and sets saveSkipLogged.
   * @emits none
   */
  skipSave() {
    if (!this.savesDisabled) return false;
    if (!this.saveSkipLogged) {
      this.saveSkipLogged = true;
      console.warn(`[history] not saving; ${this.filePath} could not be loaded and will not be overwritten`);
    }
    return true;
  }

  /**
   * Reads the history file into memory, or records why it could not.
   * @returns {void} Returns immediately when filePath is empty.
   * Side effects: readStored on the primary path. 'ok' applies the document, merging when
   *   memory already has samples and readState is neither 'unread' nor 'loaded'.
   *   'invalid' and 'empty' call recoverUnreadable. 'missing' calls noteMissing.
   *   Any other status calls noteRetry. May read a .bak, rename a bad file aside, and log.
   *   Does not write a replacement history file.
   * @emits none
   */
  load() {
    if (!this.filePath) return;
    const primary = this.readStored(this.filePath);
    if (primary.status === 'ok') {
      // Merge samples taken while the file was locked or missing. A first load replaces memory.
      const merge = this.hasSamples() && this.readState !== 'unread' && this.readState !== 'loaded';
      this.readState = 'loaded';
      this.recheckMissing = false;
      this.retrySkipLogged = false;
      this.savesDisabled = false;
      this.applyParsed(primary.parsed, merge);
      // A clean load matches the file. A merge folded in samples that still need a write.
      if (merge) this.markDirty();
      else this.dirty = false;
      return;
    }
    // Empty (power-cut zeros) or a size/JSON/version failure. A good .bak resumes saving.
    if (primary.status === 'invalid' || primary.status === 'empty') {
      this.recoverUnreadable(primary.status);
      return;
    }
    // ENOENT. noteMissing may restore .bak and ask the next save to look again.
    if (primary.status === 'missing') {
      this.noteMissing();
      return;
    }
    // Any other read error. Saves stay enabled and the write waits.
    this.noteRetry();
  }

  /**
   * An empty file, or a corrupt file that may have a good .bak.
   * A readable .bak is loaded, the bad main file is renamed to
   * history.json.corrupt-<timestamp>, and saving stays enabled so the next save
   * rewrites history.json from that backup. An empty file with no usable .bak
   * starts from the samples already in memory (or empty) and saving stays enabled.
   * Any other unreadable file with no usable .bak calls failPermanent, which
   * disables saves so the only copy is not overwritten.
   * @param {'empty'|'invalid'} status Result from readStored on the main file.
   * @returns {void}
   * Side effects: may read the .bak, rename the main file, replace memory, and log.
   *   Does not write a new history.json. Sets dirty when saving should resume.
   * @emits none
   */
  recoverUnreadable(status) {
    const backup = this.readStored(`${this.filePath}.bak`);
    if (backup.status === 'ok') {
      this.moveCorruptAside();
      this.readState = 'loaded';
      this.recheckMissing = false;
      this.retrySkipLogged = false;
      this.savesDisabled = false;
      const kind = status === 'empty' ? 'empty' : 'unreadable';
      console.warn(`[history] ${this.filePath} was ${kind}; loaded ${this.filePath}.bak and saving will resume`);
      this.applyParsed(backup.parsed, this.hasSamples());
      // The restored samples are not on the main path until the next save.
      this.markDirty();
      return;
    }
    // A zeroed file is not a document worth preserving. Start clean and keep saving.
    if (status === 'empty') {
      this.readState = 'loaded';
      this.recheckMissing = false;
      this.retrySkipLogged = false;
      this.savesDisabled = false;
      if (!this.hasSamples()) {
        this.tracks = new Map();
        this.interference = [];
        this.solution = [];
      }
      console.warn(`[history] ${this.filePath} is empty and has no usable backup; starting a new history and saving stays enabled`);
      this.markDirty();
      return;
    }
    this.failPermanent();
  }

  /**
   * Renames the unreadable main file to filePath.corrupt-<epoch ms>.
   * The name uses only digits after the dot so it is legal on Windows.
   * A missing file is left alone. A failed rename is logged and does not throw;
   * the caller still loads the .bak and will try to replace the main file later.
   * @returns {void}
   * Side effects: rename of the main file. console.warn. Does not touch the .bak.
   * @emits none
   */
  moveCorruptAside() {
    const aside = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      if (!fs.existsSync(this.filePath)) return;
      moveAsideSync(this.filePath, aside);
      console.warn(`[history] moved unreadable ${this.filePath} aside to ${aside}`);
    } catch (error) {
      console.warn(`[history] could not move ${this.filePath} aside: ${error.message}`);
    }
  }

  /**
   * Size, JSON, and version failures when no usable .bak exists. The file on disk stays where it is.
   * Sets savesDisabled. On the first failure, logs, clears memory when it has no
   * samples, and applies a readable .bak in memory if one appears between the checks.
   * Saves stay disabled after that restore so the bad main file is not overwritten.
   * @returns {void} A later call, once readState is already 'invalid', returns after refreshing the flags.
   * Side effects: console.warn on the first failure. May read the .bak and replace or merge memory. No write.
   * @emits none
   */
  failPermanent() {
    const first = this.readState !== 'invalid';
    this.readState = 'invalid';
    this.recheckMissing = false;
    this.savesDisabled = true;
    if (!first) return;
    console.warn(`[history] saves disabled until ${this.filePath} can be loaded`);
    if (!this.hasSamples()) {
      this.tracks = new Map();
      this.interference = [];
      this.solution = [];
    }
    // A readable .bak is applied in memory and saves stay disabled.
    if (this.restoreBackup('invalid')) this.savesDisabled = true;
  }

  /**
   * ENOENT is not a corrupt file. Saves stay enabled.
   * The first observation restores .bak when it is readable (merged if memory already
   * has samples) and sets recheckMissing so the next save loads again. A second
   * consecutive missing leaves recheckMissing false, which allows that save to create the file.
   * @returns {void}
   * Side effects: sets savesDisabled to false. May read and apply the .bak.
   *   console.warn when the first observation has no readable .bak.
   * @emits none
   */
  noteMissing() {
    const again = this.readState === 'missing';
    this.readState = 'missing';
    this.savesDisabled = false;
    // First observation: restore .bak when it is readable, merged if memory already has samples.
    if (!again && !this.restoreBackup('missing')) {
      console.warn(`[history] ${this.filePath} is missing; will check again before saving`);
    } else if (!again) {
      // The backup is in memory and the main file is gone. The next save should recreate it.
      this.markDirty();
    }
    // First miss checks again on the next save. A second consecutive miss allows the save to create the file.
    this.recheckMissing = !again;
  }

  /**
   * EPERM, EBUSY, EIO, and any other read error that is not a bad file.
   * Saves are not disabled. readyToSave calls load() again and skips the write while
   * readState stays 'retry'. When the read later succeeds, samples taken during the
   * lock are merged with the file and then written.
   * @returns {void}
   * Side effects: console.warn the first time readState becomes 'retry'. Clears recheckMissing.
   * @emits none
   */
  noteRetry() {
    if (this.readState !== 'retry') {
      console.warn(`[history] will retry loading ${this.filePath} before saving`);
    }
    this.readState = 'retry';
    this.recheckMissing = false;
  }

  /**
   * Applies a readable sibling .bak in memory.
   * @param {'invalid'|'missing'} kind Selects the console warning.
   * @returns {boolean} False when the .bak is missing, over 64 MiB, or not version 1 JSON.
   * Side effects: readStored on filePath.bak. On success, applyParsed merges when memory
   *   already has samples. console.warn. Does not write and does not change savesDisabled.
   * @emits none
   */
  restoreBackup(kind) {
    const backupPath = `${this.filePath}.bak`;
    const backup = this.readStored(backupPath);
    if (backup.status !== 'ok') return false;
    console.warn(kind === 'missing'
      ? `[history] ${this.filePath} is missing; restored ${backupPath}`
      : `[history] using ${backupPath} in memory; ${this.filePath} will not be overwritten`);
    this.applyParsed(backup.parsed, this.hasSamples());
    return true;
  }

  /**
   * Classifies one history file.
   * @param {string} filePath Primary file or its .bak.
   * @returns {object} status 'ok' with parsed, 'invalid', 'empty', 'missing', or 'retry' with code.
   *   empty means zero bytes or only NULs and whitespace. invalid means size over 64 MiB,
   *   a JSON parse failure, or version !== 1. missing is ENOENT. Any other read error,
   *   including EPERM, EBUSY, and EIO, is retry.
   * Side effects: stat and read. console.warn for invalid and retry. ENOENT and empty are not logged here.
   * @emits none
   */
  readStored(filePath) {
    let text;
    try {
      const size = fs.statSync(filePath).size;
      // Over 64 MiB is invalid. The body is not parsed. An empty file is recoverable.
      if (size > HISTORY_LOAD_LIMIT) {
        console.warn(`[history] could not load: History file exceeds the 64 MiB load limit (${filePath})`);
        return { status: 'invalid' };
      }
      if (size === 0) return { status: 'empty' };
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // ENOENT is missing, not invalid.
      if (err.code === 'ENOENT') return { status: 'missing' };
      console.warn(`[history] could not load: ${err.message} (${filePath})`);
      // EPERM, EBUSY, EIO, and every other read error are retry. Saves are not disabled.
      return { status: 'retry', code: err.code || '' };
    }
    // A power cut can leave a file of NUL bytes. That is empty, not a document to freeze.
    if (isBlankHistory(text)) return { status: 'empty' };
    try {
      const parsed = JSON.parse(text);
      // A missing document or a version other than 1 is invalid and must not be overwritten.
      if (!parsed || parsed.version !== 1) {
        console.warn(`[history] could not load: Unsupported history file version (${filePath})`);
        return { status: 'invalid' };
      }
      return { status: 'ok', parsed };
    // JSON.parse threw. The status is invalid, so failPermanent disables saves. This is not a retry.
    } catch (err) {
      console.warn(`[history] could not load: ${err.message} (${filePath})`);
      return { status: 'invalid' };
    }
  }

  /**
   * Installs a parsed history document, then prunes it.
   * @param {object} parsed Version-1 object. Tracks are kept only when satvisFieldLayout
   *   is 2. Any other layout uses an empty track map and still loads interference and solution.
   * @param {boolean} merge When true, incoming samples are merged with memory and deduped.
   *   Track identity is t:el:az. Interference identity is t:signal:count:maxPower.
   *   Solution identity is t:used:tracked:status:type. When false, parsed data replaces memory.
   * @returns {void}
   * Side effects: mutates tracks, interference, and solution, then prune(). console.log of the counts.
   * @emits none
   */
  applyParsed(parsed, merge) {
    // Layout 2 keeps the track map. Any other layout drops tracks and still loads the other arrays.
    const tracks = parsed.satvisFieldLayout === 2
      ? new Map(Object.entries(parsed.tracks || {}))
      : new Map();
    const interference = Array.isArray(parsed.interference) ? parsed.interference : [];
    const solution = Array.isArray(parsed.solution) ? parsed.solution : [];
    if (merge) {
      for (const [key, samples] of tracks) {
        const existing = this.tracks.get(key);
        this.tracks.set(key, mergeSamples(Array.isArray(existing) ? existing : [], samples, (sample) => (
          `${sample.t}:${sample.el}:${sample.az}`
        )));
      }
      this.interference = mergeSamples(this.interference, interference, (sample) => (
        `${sample.t}:${sample.signal}:${sample.count}:${sample.maxPower}`
      ));
      this.solution = mergeSamples(this.solution, solution, (sample) => (
        `${sample.t}:${sample.used}:${sample.tracked}:${sample.status}:${sample.type}`
      ));
    } else {
      this.tracks = tracks;
      this.interference = interference;
      this.solution = solution;
    }
    this.prune();
    console.log(`[history] restored ${this.tracks.size} satellite tracks, ${this.interference.length} interference samples, `
      + `${this.solution.length} solution samples`);
  }
}

/**
 * Unions two sample lists by id, then sorts by t.
 * @param {object[]} existing Copied first. Each entry is passed to id.
 * @param {object[]|*} incoming A non-array is treated as no samples. Nullish samples are skipped.
 * @param {function(object): string} id Dedup key. A key already seen is dropped.
 * @returns {object[]} New array sorted by t. The inputs are not mutated.
 * Side effects: none.
 * @emits none
 */
function mergeSamples(existing, incoming, id) {
  const seen = new Set(existing.map(id));
  const merged = existing.slice();
  for (const sample of Array.isArray(incoming) ? incoming : []) {
    if (!sample) continue;
    const key = id(sample);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(sample);
  }
  merged.sort((a, b) => a.t - b.t);
  return merged;
}

/** Unchanged solutions and unchanged interference reports are stored at most once per 10 seconds. */
const SOLUTION_HEARTBEAT_MS = 10000;

/**
 * Stable text for one sample's stored detections, used by the 10 second heartbeat.
 * Power, frequency, bandwidth, and type are included so a real change is not skipped.
 * @param {object[]} stored Detections already copied onto the sample. A missing list is empty.
 * @returns {string}
 * Side effects: none.
 * @emits none
 */
function detectionFingerprint(stored) {
  let text = '';
  for (const detection of stored || []) {
    text += `${detection.freq},${detection.power},${detection.bandwidth},${detection.type};`;
  }
  return text;
}

/**
 * Time-sorted samples cut to at most limit.
 * The newest Math.floor(limit / 2) samples stay as they are. Older samples are merged
 * into time buckets that start at 1000 ms and double until the older set fits the
 * remaining budget or the bucket width reaches 1e12 ms. key groups samples inside a
 * bucket, and keep picks the survivor.
 * @param {object[]} samples Sorted by t. When samples.length is within limit, this same array is returned.
 * @param {number} limit Maximum length of the result.
 * @param {function(object): string} key Identity used before the time bucket.
 * @param {function(object, object): object} keep Called as keep(previous, sample).
 * @returns {object[]}
 * Side effects: none. samples is not mutated.
 * @emits none
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

/**
 * Reduces interference samples to limit.
 * Inside a bucket, a sample with count > 0 is kept over one with count 0. Otherwise
 * the higher finite maxPower is kept. Equal or missing power keeps the sample already chosen.
 * @param {object[]} samples
 * @param {number} limit
 * @returns {object[]} Result of reduceSamples, keyed by signal.
 * Side effects: none.
 * @emits none
 */
/**
 * Caps an interference list without throwing away a long time span.
 * When the first and last sample are closer than limit seconds, this is a burst
 * and the newest limit samples are kept. A longer series is bucketed by
 * reduceInterference so a 24 h window still reaches its start.
 * @param {object[]} samples Time-sorted interference samples.
 * @param {number} limit Maximum length.
 * @returns {object[]}
 * Side effects: none. samples is not mutated. slice returns a new array; reduceInterference does too.
 * @emits none
 */
function capInterference(samples, limit) {
  if (!Array.isArray(samples) || samples.length <= limit) return samples;
  const first = samples[0] && samples[0].t;
  const last = samples[samples.length - 1] && samples[samples.length - 1].t;
  const span = last - first;
  if (!Number.isFinite(span) || span < limit * 1000) return samples.slice(-limit);
  return reduceInterference(samples, limit);
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

/**
 * Reduces solution samples to limit, keeping the latest sample in each time bucket.
 * The bucket key is empty, so samples in one time slice compete as a single group.
 * @param {object[]} samples Time-sorted solution samples.
 * @param {number} limit
 * @returns {object[]}
 * Side effects: none.
 * @emits none
 */
function reduceLatest(samples, limit) {
  return reduceSamples(samples, limit, () => '', (previous, sample) => sample);
}

/**
 * Builds one solution heartbeat sample, or null when there is nothing to store.
 * @param {object} data Reads satellitesUsed, satellitesTracked, solutionStatus, and positionType.
 * @param {number} timestamp Stored as t. A non-finite timestamp returns null.
 * @returns {object|null} Null when data is missing or both used and type are null.
 *   used and tracked are integers from 0 to 255, otherwise null. status and type are
 *   non-empty strings cut to 32 characters, otherwise null.
 * Side effects: none.
 * @emits none
 */
function solutionSample(data, timestamp) {
  if (!data || !Number.isFinite(timestamp)) return null;
  /**
   * Accepts an integer from 0 through 255.
   * @param {*} value Candidate satellite count.
   * @returns {number|null}
   * Side effects: none.
   * @emits none
   */
  const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 255 ? value : null);
  /**
   * Accepts a non-empty string and cuts it to 32 characters.
   * @param {*} value Candidate status or position type.
   * @returns {string|null}
   * Side effects: none.
   * @emits none
   */
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

/**
 * Rounds value to digits decimal places.
 * @param {number} value
 * @param {number} digits Power of ten used as the scale.
 * @returns {number}
 * Side effects: none.
 * @emits none
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * True for a usable sky plot point.
 * @param {number} elevation Finite, from 0 through 90 inclusive.
 * @param {number} azimuth Finite, from 0 inclusive through 360 exclusive.
 * @returns {boolean}
 * Side effects: none.
 * @emits none
 */
function isValidSkyPosition(elevation, azimuth) {
  return Number.isFinite(elevation) && elevation >= 0 && elevation <= 90
    && Number.isFinite(azimuth) && azimuth >= 0 && azimuth < 360;
}

module.exports = {
  History, SOLUTION_HEARTBEAT_MS, solutionSample, MAX_TRACKS, MAX_DETECTIONS_PER_SAMPLE,
  HISTORY_LOAD_LIMIT, replaceFile, replaceFileSync,
};

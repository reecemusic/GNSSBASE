/**
 * Bounded history of satellite tracks, interference reports, and solution heartbeats.
 * Samples older than the retention window are dropped. Saves write a temp file and
 * rename it into place, keeping the previous file as .bak. A file that fails the
 * size, JSON, or version check is never overwritten.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Upper bound on satellite track keys. New satellites past this are not stored. */
const MAX_TRACKS = 512;
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
 * Time-bounded history of satellite positions, interference detections, and solution heartbeats.
 * prune() drops samples older than retentionMs. Tracks are also thinned to one sample
 * per trackSampleMs per satellite, and new track keys stop at MAX_TRACKS.
 * A file that fails the size, JSON, or version check disables saves so it is not overwritten.
 */
class History {
  /**
   * Stores the limits and starts with empty samples. Does not read the file; call load().
   * @param {object} options retentionMs, trackSampleMs, maxInterferenceSamples, and filePath.
   * @returns {void}
   * Side effects: none beyond own properties. readState starts 'unread', savesDisabled is
   *   false, _saveGeneration is 0, and _saveChain is an already fulfilled promise.
   * @emits none
   */
  constructor(options) {
    this.retentionMs = options.retentionMs;
    this.trackSampleMs = options.trackSampleMs;
    this.maxInterferenceSamples = options.maxInterferenceSamples;
    this.filePath = options.filePath;
    this.tracks = new Map();
    this.interference = [];
    this.solution = [];
    this.trackCapWarned = false;
    this.savesDisabled = false;
    this.saveSkipLogged = false;
    this.readState = 'unread';
    this.recheckMissing = false;
    this.retrySkipLogged = false;
    this._saveGeneration = 0;
    this._saveChain = Promise.resolve();
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
    if (last && timestamp - last.t < SOLUTION_HEARTBEAT_MS && last.used === sample.used
      && last.tracked === sample.tracked && last.status === sample.status && last.type === sample.type) return;
    this.solution.push(sample);
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
      if (last && timestamp - last.t < this.trackSampleMs) continue;

      samples.push({ t: timestamp, el: round(sat.elevation, 2), az: round(sat.azimuth, 2) });
      this.tracks.set(key, samples);
    }
  }

  /**
   * Records one interference report.
   * @param {string} signalType Stored on the sample as signal.
   * @param {object[]} detections Items with powerDbm, centerFrequencyHz, bandwidthHz, and type.
   * @param {number} [timestamp=Date.now()] Sample time in milliseconds.
   * @returns {void}
   * Side effects: pushes a sample and drops from the front past maxInterferenceSamples.
   *   maxPower is the largest finite powerDbm, or null. The sample freq is the first
   *   detection's finite center frequency, or null. Each detection is copied down to
   *   freq, bandwidth, power, and type. No I/O.
   * @emits none
   */
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

  /**
   * Drops samples older than retentionMs, and track points that are not valid sky positions.
   * @param {number} [now=Date.now()] The cutoff is now minus retentionMs.
   * @returns {void}
   * Side effects: mutates tracks, interference, and solution. A track whose value is not
   *   an array is deleted and logged. Tracks with nothing left are deleted. interference
   *   and solution are also sliced to the last maxInterferenceSamples. Those two lists
   *   are not tested as sky positions. No file I/O.
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
    // Interference and solution lose aged samples only. They are not sky positions.
    this.interference = this.interference.filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff)
      .slice(-this.maxInterferenceSamples);
    this.solution = (Array.isArray(this.solution) ? this.solution : [])
      .filter((s) => s && Number.isFinite(s.t) && s.t >= cutoff)
      .slice(-this.maxInterferenceSamples);
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
   * Periodic save. Snapshots JSON, then increments _saveGeneration and chains writePayload.
   * Stringify failures are reported before the first await so a timer cannot reject.
   * @returns {Promise<void>} Fulfilled when readyToSave is false, when serialize throws,
   *   and when the chained write fails. Those failures are logged. The returned promise
   *   does not reject.
   * Side effects: may load() through readyToSave. Increments _saveGeneration. Appends
   *   writePayload to _saveChain. The chain itself swallows rejection. console.warn on failure.
   * @emits none
   */
  save() {
    if (!this.readyToSave()) return Promise.resolve();
    let payload;
    try {
      // Snapshot the JSON first. The generation increment below belongs to this payload.
      payload = this.serialize();
    } catch (err) {
      console.warn(`[history] could not save: ${err.message}`);
      return Promise.resolve();
    }
    // writePayload no-ops once flush() or a later save moves _saveGeneration.
    const generation = ++this._saveGeneration;
    // The catch logs a write failure and fulfills. The chain ignores both outcomes so the next save still runs.
    const write = this._saveChain.then(() => this.writePayload(payload, generation)).catch((err) => {
      console.warn(`[history] could not save: ${err.message}`);
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
   *   Otherwise mkdir, write a temp file, and replaceFileSync (the rename is synchronous).
   *   A generation change after the temp write deletes the temp and returns.
   *   A failed replace removes the temp, ignoring an rm error, and rethrows.
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
      // Synchronous rename, checked just above. An older rename cannot finish after flush()'s snapshot.
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
   * Side effects: increments _saveGeneration, prune via serialize, mkdirSync, writeFileSync,
   *   and replaceFileSync. A failed replace deletes the temp and the outer catch logs the
   *   error. Success sets readState to 'loaded' and recheckMissing to false. Does not throw
   *   to the caller.
   * @emits none
   */
  saveSync() {
    if (!this.readyToSave()) return;
    // This synchronous snapshot becomes the current generation.
    this._saveGeneration++;
    try {
      const payload = this.serialize();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = temporaryPath(this.filePath);
      fs.writeFileSync(temporary, payload);
      try {
        replaceFileSync(this.filePath, temporary);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      this.readState = 'loaded';
      this.recheckMissing = false;
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
   *   'invalid' calls failPermanent. 'missing' calls noteMissing. Any other status calls
   *   noteRetry. May read a .bak and log. Does not write the history file.
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
      return;
    }
    // Size, JSON, or version failure. failPermanent disables saves and does not overwrite the file.
    if (primary.status === 'invalid') {
      this.failPermanent();
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
   * Size, JSON, and version failures. The file on disk stays where it is.
   * Sets savesDisabled. On the first failure, logs, clears memory when it has no
   * samples, and applies a readable .bak in memory. Saves stay disabled after that restore.
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
   * @returns {object} status 'ok' with parsed, 'invalid', 'missing', or 'retry' with code.
   *   invalid means size over 64 MiB, a JSON parse failure, or version !== 1.
   *   missing is ENOENT. Any other read error, including EPERM, EBUSY, and EIO, is retry.
   * Side effects: stat and read. console.warn for invalid and retry. ENOENT is not logged here.
   * @emits none
   */
  readStored(filePath) {
    let text;
    try {
      // Over 64 MiB is invalid. The body is not parsed.
      if (fs.statSync(filePath).size > 64 * 1024 * 1024) {
        console.warn(`[history] could not load: History file exceeds the 64 MiB load limit (${filePath})`);
        return { status: 'invalid' };
      }
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // ENOENT is missing, not invalid.
      if (err.code === 'ENOENT') return { status: 'missing' };
      console.warn(`[history] could not load: ${err.message} (${filePath})`);
      // EPERM, EBUSY, EIO, and every other read error are retry. Saves are not disabled.
      return { status: 'retry', code: err.code || '' };
    }
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

/** Unchanged solutions are stored at most once per 10 seconds. */
const SOLUTION_HEARTBEAT_MS = 10000;

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
  History, SOLUTION_HEARTBEAT_MS, solutionSample, MAX_TRACKS, replaceFile, replaceFileSync,
};

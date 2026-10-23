/**
 * Rate-limits repeated console lines.
 * The first line for a key is printed immediately. Further lines in the same
 * minute are counted. When the minute ends, one summary names the key and the
 * count. A quiet minute lets the next line print in full again.
 * This module emits no events.
 */
'use strict';

/** How long similar lines are counted before one summary is printed. */
const LOG_SUMMARY_MS = 60000;
const buckets = new Map();

/**
 * Prints a console line, or counts it toward the once-per-minute summary.
 * @param {'log'|'warn'|'error'} level console method. Any other level is treated as log.
 * @param {string} key Stable bucket name, shared by lines that mean the same failure.
 * @param {string} line Text of this occurrence. The first one in a quiet window is printed.
 * @returns {void}
 * Side effects: console[level], and a timer that prints one summary. The timer is unref'd.
 *   Does not throw. The summary does not include the original line, only the count.
 * @emits none
 */
function logLimited(level, key, line) {
  const method = level === 'warn' || level === 'error' || level === 'log' ? level : 'log';
  const now = Date.now();
  const windowMs = summaryWindowMs();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { last: 0, suppressed: 0, timer: null };
    buckets.set(key, bucket);
  }
  // First line, or the first line after a minute that produced no summary, prints in full.
  if (bucket.suppressed === 0 && (bucket.last === 0 || now - bucket.last >= windowMs)) {
    console[method](line);
    bucket.last = now;
    return;
  }
  bucket.suppressed += 1;
  if (bucket.timer) return;
  const wait = Math.max(0, windowMs - (now - bucket.last));
  bucket.timer = setTimeout(() => {
    bucket.timer = null;
    if (bucket.suppressed > 0) {
      console[method](`[log] ${key}: ${bucket.suppressed} similar messages in the last minute`);
      bucket.suppressed = 0;
      bucket.last = Date.now();
    }
  }, wait);
  if (typeof bucket.timer.unref === 'function') bucket.timer.unref();
}

/**
 * Length of the summary window. The environment variable LOG_SUMMARY_MS overrides
 * it for tests. Production leaves that variable unset and uses 60 seconds.
 * @returns {number}
 * Side effects: reads process.env.LOG_SUMMARY_MS. Does not throw.
 * @emits none
 */
function summaryWindowMs() {
  const raw = process.env.LOG_SUMMARY_MS;
  if (raw === undefined || raw === '') return LOG_SUMMARY_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : LOG_SUMMARY_MS;
}

module.exports = { logLimited, LOG_SUMMARY_MS };

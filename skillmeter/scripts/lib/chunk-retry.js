/**
 * Per-chunk upload retry budget for the durable transcript queue.
 *
 * A failed upload leaves its body and meta on disk for the next drain. That is
 * the right default — a backend blip must not lose telemetry — but without a
 * budget it also means a chunk the backend rejects *deterministically* is
 * re-uploaded by every drain pass for the rest of the session. Drains are
 * spawned by the Stop hook as well as by the retry daemon, so the daemon's own
 * adaptive backoff does not bound that: the observed rate was ~24 requests per
 * minute against six chunks that had already failed 55+ times each.
 *
 * So each failure is recorded in the chunk's meta sidecar and buys a doubling
 * wait before the next attempt. Once MAX_UPLOAD_ATTEMPTS is spent the chunk is
 * quarantined — renamed so no drain lists it again, never deleted. Nothing is
 * lost; a quarantined pair can be renamed back once the server side is fixed.
 *
 * Pure: no fs, no network, no clock. Callers pass `now` and do the renaming.
 */

const MAX_UPLOAD_ATTEMPTS = 8;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;
const QUARANTINE_SUFFIX = ".quarantined";

/**
 * Wait before attempt N+1, having just failed attempt N. Doubles from the base
 * and stops at the cap: 1, 2, 4, 8, 16, 30, 30, 30 minutes. Spending the whole
 * budget therefore takes ~1.5 hours, long enough that an outage of any ordinary
 * length is ridden out rather than quarantined.
 */
function retryDelayMs(attempts, base = RETRY_BASE_MS, cap = RETRY_CAP_MS) {
  const n = Number.isFinite(attempts) && attempts > 1 ? Math.floor(attempts) : 1;
  // 2**52 overflows to Infinity long before this, so clamp the exponent first.
  const doublings = Math.min(n - 1, 32);
  return Math.min(base * 2 ** doublings, cap);
}

/**
 * The meta to persist after a failed attempt. Returns a new object so a caller
 * holding the old meta (for logging) still sees the pre-failure state.
 */
function recordUploadFailure(meta, { now = Date.now(), error = "" } = {}) {
  const previous =
    Number.isFinite(meta?.uploadAttempts) && meta.uploadAttempts > 0
      ? Math.floor(meta.uploadAttempts)
      : 0;
  const uploadAttempts = previous + 1;
  return {
    ...(meta || {}),
    uploadAttempts,
    lastUploadError: String(error).slice(0, 300),
    lastAttemptAt: now,
    nextAttemptAt: now + retryDelayMs(uploadAttempts),
  };
}

/**
 * Whether a drain should try this chunk now. A chunk with no recorded failure
 * is always eligible, as is one whose `nextAttemptAt` is unreadable — a corrupt
 * sidecar must not strand a chunk forever.
 */
function isChunkEligible(meta, now = Date.now()) {
  const nextAttemptAt = meta?.nextAttemptAt;
  if (!Number.isFinite(nextAttemptAt)) return true;
  return now >= nextAttemptAt;
}

function isChunkExhausted(meta, max = MAX_UPLOAD_ATTEMPTS) {
  const attempts = meta?.uploadAttempts;
  return Number.isFinite(attempts) && attempts >= max;
}

/**
 * Where a chunk file goes when its budget is spent. The drain lists bodies by a
 * `.jsonl` suffix and requires a matching `.meta.json`; appending the suffix
 * makes a pair match neither, which is the whole mechanism.
 */
function quarantinePathFor(filePath) {
  return `${filePath}${QUARANTINE_SUFFIX}`;
}

module.exports = {
  MAX_UPLOAD_ATTEMPTS,
  QUARANTINE_SUFFIX,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  isChunkEligible,
  isChunkExhausted,
  quarantinePathFor,
  recordUploadFailure,
  retryDelayMs,
};

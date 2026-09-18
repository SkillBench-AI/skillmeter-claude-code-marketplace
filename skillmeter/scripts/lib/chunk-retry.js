/**
 * Per-chunk retry budget shared by all drain paths through the metadata sidecar.
 * Failures schedule exponential backoff; exhausted chunks are renamed out of the
 * drain list. Quarantined files remain subject to transport cleanup.
 * This module computes state only; callers read/write files and supply the time.
 */

const MAX_UPLOAD_ATTEMPTS = 8;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;
const QUARANTINE_SUFFIX = ".quarantined";

/**
 * Delay after failure N: double from the base up to the cap.
 * Defaults produce waits of 1, 2, 4, 8, 16 and then 30 minutes.
 */
function retryDelayMs(attempts, base = RETRY_BASE_MS, cap = RETRY_CAP_MS) {
  const n = Number.isFinite(attempts) && attempts > 1 ? Math.floor(attempts) : 1;
  // Bound exponentiation for corrupt or unexpectedly large attempt counts.
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

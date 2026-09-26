/**
 * Device-wide refresh status in STATE_DIR, shared across sessions. Refresh and
 * sign-in update it; hooks and the retry daemon read it for notices and backoff
 * without a network request.
 *
 * Shape (schema_version 1):
 *   last_attempt_at       ms epoch of the last refresh or re-activation attempt
 *   last_success_at       ms epoch of the last success
 *   last_outcome          "rotated" | "reactivated" | "transient_failure" | "terminal"
 *   last_error            { kind, status, message } for the last failure, or null
 *   consecutive_failures  failures since the last success
 *   next_retry_at         ms epoch before which the daemon must not retry, or null
 *   terminal              null, or { reason, at, status, message } — retrying is
 *                         pointless until SessionStart or /skillmeter:signin clears it
 *   updated_by            "daemon" | "session_start" | "drain" | "signin" | ...
 *   revision              monotonically increasing write counter used for
 *                         compare-and-update (see updateLicenseStatus)
 *
 * updateLicenseStatus retries when the revision changes before rename, then
 * falls back to last-writer-wins after five attempts. This narrows concurrent
 * write races; it does not make the revision check and rename atomic.
 */

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { STATE_DIR, CRED_FILE, getRetryDaemonIntervalMs } = require("./config");
const { safeReadJson, atomicWriteJson } = require("./io");

const LICENSE_STATUS_FILE = path.join(STATE_DIR, "license-status.json");
const SCHEMA_VERSION = 1;

// Backoff bounds. The base is the daemon sweep interval (2 min by default);
// the cap matches the daemon's drain backoff cap. See ADR 001, decision 2.
const BACKOFF_CAP_MS = 30 * 60_000;

// Terminal reasons. A terminal state means the client has stopped retrying for
// this session and the user has to act (or a new session has to start).
const TERMINAL_REASONS = Object.freeze({
  REVOKED: "revoked", // 402 from /refresh or /activate
  REACTIVATION_REQUIRED: "reactivation_required", // 410/401: only a new sign-in helps
  // Legacy: no longer written. Transient failures keep retrying at the cap;
  // a record left by an older version is ignored (see refreshBlockedReason).
  BACKOFF_EXHAUSTED: "backoff_exhausted",
});

function emptyStatus() {
  return {
    schema_version: SCHEMA_VERSION,
    last_attempt_at: null,
    last_success_at: null,
    last_outcome: null,
    last_error: null,
    consecutive_failures: 0,
    next_retry_at: null,
    terminal: null,
    updated_by: null,
    revision: 0,
  };
}

// Bind new status records to the exchange identity without storing a token.
// Another client may sign in without knowing about this Claude status file.
function authContext() {
  const store = safeReadJson(CRED_FILE, {});
  return crypto.createHash("sha256").update(JSON.stringify([
    store.auth_generation || null, store.device_id || null,
    store.license_jwt || null, store.signed_out === true,
  ])).digest("hex");
}

function readLicenseStatus() {
  const raw = safeReadJson(LICENSE_STATUS_FILE, null);
  if (!raw || typeof raw !== "object" || raw.schema_version !== SCHEMA_VERSION) {
    return emptyStatus();
  }
  if (raw.auth_context && raw.auth_context !== authContext()) {
    return { ...emptyStatus(), revision: raw.revision || 0 };
  }
  return { ...emptyStatus(), ...raw };
}

let persistenceFailureReported = false;

function reportPersistenceFailure(err) {
  // Failed persistence can restart backoff and leave notices stale. Report it
  // once; revocation is checked again on the next refresh attempt.
  if (persistenceFailureReported) return;
  persistenceFailureReported = true;
  console.error(
    `[skillmeter] license status not persisted (${err && err.message ? err.message : err}); backoff will restart from the on-disk record`
  );
}

/** Current on-disk revision, or 0 when the record is absent or unreadable. */
function currentRevision() {
  const raw = safeReadJson(LICENSE_STATUS_FILE, null);
  return raw && typeof raw.revision === "number" ? raw.revision : 0;
}

/**
 * Write `next` only if the on-disk revision is still `expectedRevision`.
 * Same write discipline as io.atomicWriteJson (temp file + fsync + rename) with
 * the revision check placed right before the rename, so the window in which a
 * concurrent writer can slip in is the rename itself rather than the whole
 * read-modify-write. Returns true when committed, false when the record moved.
 */
function writeIfRevisionUnchanged(next, expectedRevision) {
  const dir = path.dirname(LICENSE_STATUS_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${LICENSE_STATUS_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(next, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (currentRevision() !== expectedRevision) {
      try { fs.unlinkSync(tempPath); } catch {}
      return false;
    }
    fs.renameSync(tempPath, LICENSE_STATUS_FILE);
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

const MAX_UPDATE_ATTEMPTS = 5;

/**
 * Apply `mutate(prev)` to the record with compare-and-update. `mutate` must be
 * pure (it may run more than once). Returns the committed record. Persistence
 * failures degrade to the in-memory result and are reported once.
 */
function updateLicenseStatus(mutate) {
  let next;
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const context = authContext();
    const prev = readLicenseStatus();
    next = { ...mutate(prev), auth_context: context, revision: (prev.revision || 0) + 1 };
    try {
      if (writeIfRevisionUnchanged(next, prev.revision || 0)) {
        persistenceFailureReported = false;
        return next;
      }
    } catch (err) {
      reportPersistenceFailure(err);
      return next;
    }
  }
  // Pathological contention: fall back to last-writer-wins so the caller still
  // gets its transition recorded.
  return writeLicenseStatus(next);
}

function writeLicenseStatus(status) {
  try {
    atomicWriteJson(LICENSE_STATUS_FILE, status);
    persistenceFailureReported = false;
  } catch (err) {
    reportPersistenceFailure(err);
  }
  return status;
}

/**
 * Delay before the next attempt after `consecutiveFailures` failures:
 * base, 2*base, 4*base, ... capped. Pure.
 */
function backoffDelayMs(consecutiveFailures, baseMs = getRetryDaemonIntervalMs(), capMs = BACKOFF_CAP_MS) {
  if (consecutiveFailures <= 0) return 0;
  const raw = baseMs * 2 ** (consecutiveFailures - 1);
  return Math.min(raw, capMs);
}

/**
 * Why a refresh attempt should be skipped right now, or null when it may run.
 * Pure: takes the status object and the clock.
 * @returns {"terminal"|"backoff"|null}
 */
function refreshBlockedReason(status, now = Date.now()) {
  if (!status) return null;
  // Only a new sign-in can clear a terminal state, so only reasons that need
  // one block refresh. An outage is never terminal.
  if (status.terminal && status.terminal.reason !== TERMINAL_REASONS.BACKOFF_EXHAUSTED) {
    return "terminal";
  }
  if (typeof status.next_retry_at === "number" && status.next_retry_at > now) return "backoff";
  return null;
}

function recordRefreshSuccess({ source = "unknown", outcome = "rotated", now = Date.now() } = {}) {
  return updateLicenseStatus((prev) => ({
    ...prev,
    last_attempt_at: now,
    last_success_at: now,
    last_outcome: outcome,
    last_error: null,
    consecutive_failures: 0,
    next_retry_at: null,
    terminal: null,
    updated_by: source,
  }));
}

/**
 * Record a transient failure (network, 5xx, malformed response). Advances the
 * backoff, which stays at the cap for as long as failures continue: an outage
 * recovers on its own once the server answers again, without a new session.
 */
function recordRefreshFailure({
  source = "unknown",
  kind = "refresh",
  status = null,
  message = "",
  now = Date.now(),
  baseMs = getRetryDaemonIntervalMs(),
  capMs = BACKOFF_CAP_MS,
} = {}) {
  const error = { kind, status, message: String(message || "").slice(0, 200) };
  return updateLicenseStatus((prev) => {
  const failures = (prev.consecutive_failures || 0) + 1;
  // A terminal state is sticky: a late transient-failure write from another
  // process (SessionStart bypasses the refresh lock) must not turn a revoked
  // or reactivation-required record back into a retrying one. Only a success,
  // SessionStart's clearTerminal, or /skillmeter:signin lifts it.
  if (prev.terminal) {
    return {
      ...prev,
      last_attempt_at: now,
      last_error: error,
      consecutive_failures: failures,
      updated_by: source,
    };
  }
  return {
    ...prev,
    last_attempt_at: now,
    last_outcome: "transient_failure",
    last_error: error,
    consecutive_failures: failures,
    next_retry_at: now + backoffDelayMs(failures, baseMs, capMs),
    terminal: null,
    updated_by: source,
  };
  });
}

/** Record a terminal outcome (402, gh unavailable, identity mismatch). */
function recordTerminal({ source = "unknown", reason, status = null, message = "", now = Date.now() } = {}) {
  const msg = String(message || "").slice(0, 200);
  return updateLicenseStatus((prev) => ({
    ...prev,
    last_attempt_at: now,
    last_outcome: "terminal",
    last_error: { kind: reason, status, message: msg },
    consecutive_failures: prev.consecutive_failures || 0,
    next_retry_at: null,
    terminal: { reason, at: now, status, message: msg },
    updated_by: source,
  }));
}

/**
 * SessionStart entry point: a new session gets one fresh attempt, so the
 * terminal flag and the backoff clock are dropped while the history
 * (last_success_at, last_error) is kept for notices.
 */
function clearTerminal({ source = "session_start" } = {}) {
  const prev = readLicenseStatus();
  if (!prev.terminal && !prev.next_retry_at && !prev.consecutive_failures) return prev;
  return updateLicenseStatus((cur) => ({
    ...cur,
    consecutive_failures: 0,
    next_retry_at: null,
    terminal: null,
    updated_by: source,
  }));
}

/** /skillmeter:signin entry point: start from a clean record. */
function clearLicenseStatus({ source = "signin" } = {}) {
  return updateLicenseStatus(() => ({ ...emptyStatus(), updated_by: source }));
}

module.exports = {
  LICENSE_STATUS_FILE,
  TERMINAL_REASONS,
  readLicenseStatus,
  backoffDelayMs,
  refreshBlockedReason,
  updateLicenseStatus,
  recordRefreshSuccess,
  recordRefreshFailure,
  recordTerminal,
  clearTerminal,
  clearLicenseStatus,
};

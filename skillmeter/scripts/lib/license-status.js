/**
 * License refresh status record.
 *
 * One small JSON file next to credentials.json that says how the last refresh
 * attempts went, so the retry daemon can back off, and hooks and skills can
 * tell the user why collection stopped without making a network call.
 *
 * The record is a device-level fact (the token it describes lives in the same
 * directory), so it sits in STATE_DIR and is shared by every session on the
 * machine. Writers: the refresh orchestrator (scripts/lib/license-activation.js)
 * and the sign-in commands (which clear it). Readers: the retry daemon, the
 * SessionStart hook, and later the B1 notice and /skillmeter:status.
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
 *
 * Leaf module: requires only path, ./config and ./io.
 */

const path = require("path");
const { STATE_DIR, getRetryDaemonIntervalMs } = require("./config");
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
  GH_UNAUTHENTICATED: "gh_unauthenticated", // gh CLI missing or not logged in
  IDENTITY_MISMATCH: "identity_mismatch", // A4: gh identity != prior sign-in
  BACKOFF_EXHAUSTED: "backoff_exhausted", // failures kept coming past the cap
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
  };
}

function readLicenseStatus() {
  const raw = safeReadJson(LICENSE_STATUS_FILE, null);
  if (!raw || typeof raw !== "object" || raw.schema_version !== SCHEMA_VERSION) {
    return emptyStatus();
  }
  return { ...emptyStatus(), ...raw };
}

function writeLicenseStatus(status) {
  try {
    atomicWriteJson(LICENSE_STATUS_FILE, status);
  } catch {
    // Best-effort: a missing status record only degrades backoff and notices.
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
 * True when the attempt that just failed was already waited for at the cap,
 * i.e. the previous delay had reached `capMs`. With a 2-minute base and a
 * 30-minute cap the sequence is 2, 4, 8, 16, 30 minutes of waiting, and the
 * sixth failure is terminal (about an hour of trying). Pure.
 */
function backoffExhausted(consecutiveFailures, baseMs = getRetryDaemonIntervalMs(), capMs = BACKOFF_CAP_MS) {
  if (consecutiveFailures < 2) return false;
  return backoffDelayMs(consecutiveFailures - 1, baseMs, capMs) >= capMs;
}

/**
 * Why a refresh attempt should be skipped right now, or null when it may run.
 * Pure: takes the status object and the clock.
 * @returns {"terminal"|"backoff"|null}
 */
function refreshBlockedReason(status, now = Date.now()) {
  if (!status) return null;
  if (status.terminal) return "terminal";
  if (typeof status.next_retry_at === "number" && status.next_retry_at > now) return "backoff";
  return null;
}

function recordRefreshSuccess({ source = "unknown", outcome = "rotated", now = Date.now() } = {}) {
  const prev = readLicenseStatus();
  return writeLicenseStatus({
    ...prev,
    last_attempt_at: now,
    last_success_at: now,
    last_outcome: outcome,
    last_error: null,
    consecutive_failures: 0,
    next_retry_at: null,
    terminal: null,
    updated_by: source,
  });
}

/**
 * Record a transient failure (network, 5xx, malformed response, rejected
 * re-activation that may succeed later). Advances the backoff; flips to the
 * backoff_exhausted terminal state once the cap has been waited out.
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
  const prev = readLicenseStatus();
  const failures = (prev.consecutive_failures || 0) + 1;
  const error = { kind, status, message: String(message || "").slice(0, 200) };
  if (backoffExhausted(failures, baseMs, capMs)) {
    return writeLicenseStatus({
      ...prev,
      last_attempt_at: now,
      last_outcome: "terminal",
      last_error: error,
      consecutive_failures: failures,
      next_retry_at: null,
      terminal: { reason: TERMINAL_REASONS.BACKOFF_EXHAUSTED, at: now, status, message: error.message },
      updated_by: source,
    });
  }
  return writeLicenseStatus({
    ...prev,
    last_attempt_at: now,
    last_outcome: "transient_failure",
    last_error: error,
    consecutive_failures: failures,
    next_retry_at: now + backoffDelayMs(failures, baseMs, capMs),
    terminal: null,
    updated_by: source,
  });
}

/** Record a terminal outcome (402, gh unavailable, identity mismatch). */
function recordTerminal({ source = "unknown", reason, status = null, message = "", now = Date.now() } = {}) {
  const prev = readLicenseStatus();
  const msg = String(message || "").slice(0, 200);
  return writeLicenseStatus({
    ...prev,
    last_attempt_at: now,
    last_outcome: "terminal",
    last_error: { kind: reason, status, message: msg },
    consecutive_failures: prev.consecutive_failures || 0,
    next_retry_at: null,
    terminal: { reason, at: now, status, message: msg },
    updated_by: source,
  });
}

/**
 * SessionStart entry point: a new session gets one fresh attempt, so the
 * terminal flag and the backoff clock are dropped while the history
 * (last_success_at, last_error) is kept for notices.
 */
function clearTerminal({ source = "session_start" } = {}) {
  const prev = readLicenseStatus();
  if (!prev.terminal && !prev.next_retry_at && !prev.consecutive_failures) return prev;
  return writeLicenseStatus({
    ...prev,
    consecutive_failures: 0,
    next_retry_at: null,
    terminal: null,
    updated_by: source,
  });
}

/** /skillmeter:signin entry point: start from a clean record. */
function clearLicenseStatus({ source = "signin" } = {}) {
  return writeLicenseStatus({ ...emptyStatus(), updated_by: source });
}

module.exports = {
  LICENSE_STATUS_FILE,
  BACKOFF_CAP_MS,
  TERMINAL_REASONS,
  readLicenseStatus,
  backoffDelayMs,
  backoffExhausted,
  refreshBlockedReason,
  recordRefreshSuccess,
  recordRefreshFailure,
  recordTerminal,
  clearTerminal,
  clearLicenseStatus,
};

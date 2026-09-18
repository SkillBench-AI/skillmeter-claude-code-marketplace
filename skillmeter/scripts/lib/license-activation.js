/**
 * License refresh and retry orchestration, following ADR001.
 * Refresh 401/410 requires interactive sign-in; 402 marks the license revoked.
 * Other failures retain the token and use the shared status record for backoff.
 * SessionStart or explicit sign-in can reset terminal retry state.
 * No background path starts a new broker device grant.
 */

const fs = require("fs");
const path = require("path");
const credstore = require("../credstore");
const { LOG_DIR } = require("./paths");
const { getActivateUrl, getRefreshUrl } = require("./config");
const { postBearerJson } = require("./http");
const licenseStatus = require("./license-status");

const { TERMINAL_REASONS } = licenseStatus;

/**
 * Rotate an existing license JWT through the Lambda's /refresh endpoint.
 * The server validates the signature, enforces a sliding window against
 * `original_iat`, re-confirms org purchase, and mints a fresh JWT — no
 * GitHub round-trip, so this works for users without `gh` installed.
 *
 * Returns an outcome object:
 *   { outcome: "rotated",   token }             new token, already stored
 *   { outcome: "rejected",  status }            410 or 401: this token can no
 *                                               longer be rotated; re-activate
 *   { outcome: "revoked",   status: 402 }       org license cancelled
 *   { outcome: "transient", status?, message }  network, 404, 5xx, bad body
 */
async function refreshExpiredJwt(jwt, deviceId) {
  if (!jwt || !deviceId) return { outcome: "transient", message: "missing token or device id" };

  const url = getRefreshUrl();

  let res;
  try {
    res = await postBearerJson(url, jwt, { device_id: deviceId }, { timeoutMs: 5000 });
  } catch (err) {
    console.error(`[skillmeter] license refresh failed: network error (${err.message})`);
    return { outcome: "transient", message: `network error: ${err.message}` };
  }

  // 410: sliding window exceeded — client must re-activate via /activate.
  // 401: token signature invalid (e.g. signing key rotated) — re-activate.
  // 402: org license cancelled — refresh is permanently blocked for this org.
  // 404: endpoint not yet deployed on this environment — transient.
  if (res.status === 410) {
    console.error("[skillmeter] license refresh: token too old, re-activation required");
    return { outcome: "rejected", status: 410 };
  }
  if (res.status === 401) {
    console.error("[skillmeter] license refresh: token no longer accepted, re-activation required");
    return { outcome: "rejected", status: 401 };
  }
  if (res.status === 402) {
    console.error("[skillmeter] license refresh: organization license is no longer active");
    return { outcome: "revoked", status: 402 };
  }
  if (res.status === 404) {
    // Quiet on 404 so logs don't spam during deploy-order rollout.
    return { outcome: "transient", status: 404, message: "refresh endpoint not found" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] license refresh failed: HTTP ${res.status} (${body.slice(0, 200)})`);
    return { outcome: "transient", status: res.status, message: `HTTP ${res.status}` };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[skillmeter] license refresh failed: invalid JSON in response");
    return { outcome: "transient", status: res.status, message: "invalid JSON in response" };
  }
  const newJwt = payload?.token;
  if (!newJwt) {
    console.error("[skillmeter] license refresh failed: response missing `token` field");
    return { outcome: "transient", status: res.status, message: "response missing token" };
  }

  credstore.setLicenseToken(newJwt);
  console.error("[skillmeter] license refresh: rotated successfully");
  return { outcome: "rotated", token: newJwt };
}

// SessionStart, queue drains and the retry monitor share refresh coordination.
// The status record supplies backoff and terminal state across processes.

const LICENSE_REFRESH_LOCK_FILE = path.join(LOG_DIR, ".license-refresh.lock");
// Don't retry a refresh within this window of the last attempt. Also serves as
// the in-flight single-flight window: a lock younger than this means another
// process is mid-refresh (or just finished), so we skip.
const LICENSE_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Hooks treat a token as expired LICENSE_EXPIRY_SKEW_SECONDS before `exp`. A
 * periodic caller (the daemon) must renew at least one period earlier than
 * that, otherwise hooks skip events between the moment the token crosses the
 * hooks' threshold and the caller's next tick. Pure.
 */
function renewSkewSeconds(aheadMs = 0) {
  const ahead = Number.isFinite(aheadMs) && aheadMs > 0 ? Math.ceil(aheadMs / 1000) : 0;
  return credstore.LICENSE_EXPIRY_SKEW_SECONDS + ahead;
}

/**
 * Pure single-flight + cooldown decision (no I/O — unit-testable). All callers
 * are best-effort/proactive (there's no reactive force path), so a lock younger
 * than the cooldown simply means "someone else has it / just refreshed" → skip.
 * @param {boolean} tokenFresh   - current token exists and is not near expiry
 * @param {number|null} lockMtimeMs - mtime of the lock file, or null if absent
 * @param {number} now           - Date.now()
 * @returns {"return_current"|"acquire_and_refresh"|"skip_locked"}
 */
function shouldRefresh(
  tokenFresh,
  lockMtimeMs,
  now,
  cooldownMs = LICENSE_REFRESH_COOLDOWN_MS
) {
  if (tokenFresh) return "return_current";
  const lockAge = lockMtimeMs == null ? Infinity : now - lockMtimeMs;
  if (lockAge < cooldownMs) return "skip_locked";
  return "acquire_and_refresh";
}

/**
 * Try exclusive lock creation, then reclaim a lock older than the cooldown.
 * Recheck age before renaming and create the replacement exclusively. This is
 * best-effort coordination: some I/O errors allow refresh to proceed unlocked.
 */
function acquireRefreshLock(staleLockPresent, cooldownMs = LICENSE_REFRESH_COOLDOWN_MS, now = Date.now()) {
  const stamp = `${process.pid} ${now}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    return true;
  }
  const tryCreate = () => {
    try {
      fs.writeFileSync(LICENSE_REFRESH_LOCK_FILE, stamp, { flag: "wx" });
      return "owned";
    } catch (err) {
      return err && err.code === "EEXIST" ? "exists" : "error";
    }
  };
  const first = tryCreate();
  if (first !== "exists") return true;
  if (!staleLockPresent) return false;

  // Re-check staleness right before claiming: another process may already have
  // replaced the stale lock with a live one.
  try {
    if (now - fs.statSync(LICENSE_REFRESH_LOCK_FILE).mtimeMs < cooldownMs) return false;
  } catch {
    // vanished: someone else claimed it; fall through to a final create
  }
  const claim = `${LICENSE_REFRESH_LOCK_FILE}.${process.pid}.${now}.stale`;
  try {
    fs.renameSync(LICENSE_REFRESH_LOCK_FILE, claim);
    try { fs.unlinkSync(claim); } catch {}
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // Lost the claim race; only proceed if the winner has not created its
      // lock yet (then the create below succeeds and we own the new one).
    } else {
      return false;
    }
  }
  return tryCreate() !== "exists";
}

/**
 * Orchestrate one refresh and record its outcome. Returns the freshest token
 * or null. Reads the token uncached so a refresh written by another process is
 * observed.
 *
 * @param {string} deviceId
 * @param {object} [opts]
 * @param {string} [opts.source] who is asking ("session_start", "daemon", "drain")
 * @param {number} [opts.aheadMs] renew this much earlier than the hooks'
 *   expiry threshold (see renewSkewSeconds)
 */
async function refreshLicense(deviceId, { source = "unknown", aheadMs = 0 } = {}) {
  const current = credstore.getLicenseTokenUncached();
  if (current && !credstore.isLicenseTokenExpired(current, renewSkewSeconds(aheadMs))) return current;
  // Refresh requires an existing sign-in. A missing license requires
  // the user to invoke /skillmeter:signin.
  if (!current || !deviceId) return null;
  if (credstore.getSignedOut()) return null;

  const rotation = await refreshExpiredJwt(current, deviceId);
  switch (rotation.outcome) {
    case "rotated":
      licenseStatus.recordRefreshSuccess({ source, outcome: "rotated" });
      return rotation.token;
    case "revoked":
      licenseStatus.recordTerminal({ source, reason: TERMINAL_REASONS.REVOKED, status: 402 });
      return null;
    case "transient":
      licenseStatus.recordRefreshFailure({
        source,
        kind: "refresh",
        status: rotation.status ?? null,
        message: rotation.message,
      });
      return null;
    case "rejected":
      break; // record that interactive sign-in is required
    default:
      return null;
  }

  // Refresh 401/410 requires a new browser-approved sign-in. Record a terminal
  // state so background callers do not keep retrying this token.
  licenseStatus.recordTerminal({
    source,
    reason: TERMINAL_REASONS.REACTIVATION_REQUIRED,
    status: rotation.status ?? null,
    message: "licence can no longer be refreshed — run /skillmeter:signin",
  });
  return null;
}

/**
 * Best-effort, single-flight license refresh. Never throws; returns the
 * freshest token available (refreshed, existing, or null). Safe to call before
 * every drain/upload and on every daemon sweep — cheap no-op when the token is
 * already fresh, non-blocking when another process holds the refresh lock, and
 * silent while the status record says to back off or stop.
 */
async function ensureFreshLicense(deviceId, { source = "drain", aheadMs = 0 } = {}) {
  if (!deviceId) return null;
  if (credstore.getSignedOut()) return null;

  const current = credstore.getLicenseTokenUncached();
  const tokenFresh =
    Boolean(current) && !credstore.isLicenseTokenExpired(current, renewSkewSeconds(aheadMs));
  if (tokenFresh) return current;

  // Backoff / terminal decisions are shared across processes through the
  // status record, so a daemon and a drain never fight over the same failure.
  if (licenseStatus.refreshBlockedReason(licenseStatus.readLicenseStatus(), Date.now())) {
    return current;
  }

  let lockMtimeMs = null;
  try {
    lockMtimeMs = fs.statSync(LICENSE_REFRESH_LOCK_FILE).mtimeMs;
  } catch {
    // lock absent
  }

  const action = shouldRefresh(tokenFresh, lockMtimeMs, Date.now());
  // return_current or skip_locked: hand back what we have without blocking.
  if (action !== "acquire_and_refresh") return current;

  // Take the lock with an exclusive create so two processes that both saw no
  // (or a stale) lock cannot both proceed. The file doubles as the cooldown
  // anchor: it is intentionally left in place and ages out past the cooldown;
  // a stale one is replaced. Not matched by listSealedEventLogs /
  // cleanupStaleFiles (same as .drain-once.lock), so it's never swept.
  if (!acquireRefreshLock(lockMtimeMs != null, LICENSE_REFRESH_COOLDOWN_MS, Date.now())) return current;

  try {
    return (await refreshLicense(deviceId, { source, aheadMs })) || current;
  } catch {
    return current;
  }
}

module.exports = {
  refreshLicense,
  ensureFreshLicense,
  // exported for tests
  _acquireRefreshLock: acquireRefreshLock,
  _LICENSE_REFRESH_LOCK_FILE: LICENSE_REFRESH_LOCK_FILE,
};

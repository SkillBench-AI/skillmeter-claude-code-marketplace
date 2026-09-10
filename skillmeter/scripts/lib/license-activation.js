/**
 * License activation orchestrator.
 *
 * Owns the two ways a device gets a license JWT without an interactive sign-in:
 * rotating an existing token through the Lambda's /refresh, and the silent
 * `gh auth token` → /activate fallback. The validated org is minted into the
 * JWT by the activator (no client org lookup).
 *
 * Refresh policy (ADR 001, decision 2):
 *   - /refresh is the only call made on a routine expiry.
 *   - Silent re-activation runs only when the token itself is no longer
 *     usable: /refresh answered 410 (sliding window exceeded) or 401 (signature
 *     no longer valid). Every other refresh failure is transient: keep the
 *     token, back off, retry /refresh later.
 *   - Consecutive failures back off exponentially (see license-status.js) and
 *     end in a terminal state that stops retrying until SessionStart or
 *     /skillmeter:signin clears it. 402 (license revoked), gh not authenticated,
 *     and an exhausted backoff are terminal.
 *   - Every outcome is written to the license status record so the daemon,
 *     hooks, and skills can read it without a network call.
 *
 * The exported surface is limited to activation and refresh orchestration.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
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

/**
 * Silent re-activation through the GitHub CLI's stored credential. Reads
 * `gh auth token` (never opens a browser or a device-code flow) and exchanges
 * it at the activation endpoint.
 *
 * Returns an outcome object:
 *   { outcome: "reactivated", token }
 *   { outcome: "signed_out" }                  /skillmeter:signout is in effect
 *   { outcome: "gh_unauthenticated", message } gh missing, not logged in, empty
 *   { outcome: "revoked", status: 402 }
 *   { outcome: "rejected", status }            other 4xx from /activate
 *   { outcome: "transient", status?, message } network, 5xx, bad body
 */
async function silentGhActivate(deviceId) {
  if (credstore.getSignedOut()) {
    console.error("[skillmeter] gh activation skipped: signed out (run /skillmeter:signin to re-enable)");
    return { outcome: "signed_out" };
  }

  let ghToken;
  try {
    ghToken = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    console.error("[skillmeter] gh activation skipped: gh CLI not installed or not authenticated");
    return { outcome: "gh_unauthenticated", message: "gh CLI not installed or not authenticated" };
  }
  if (!ghToken) {
    console.error("[skillmeter] gh activation skipped: `gh auth token` returned empty");
    return { outcome: "gh_unauthenticated", message: "gh auth token returned empty" };
  }

  console.error("[skillmeter] gh activation: exchanging token with activation endpoint");

  let res;
  try {
    res = await postBearerJson(getActivateUrl(), ghToken, { device_id: deviceId }, { timeoutMs: 5000 });
  } catch (err) {
    console.error(`[skillmeter] gh activation failed: network error (${err.message})`);
    return { outcome: "transient", message: `network error: ${err.message}` };
  }

  if (res.status === 402) {
    console.error("[skillmeter] gh activation rejected: organization license is no longer active");
    return { outcome: "revoked", status: 402 };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] gh activation rejected: HTTP ${res.status} (${body.slice(0, 200)})`);
    return res.status >= 500
      ? { outcome: "transient", status: res.status, message: `HTTP ${res.status}` }
      : { outcome: "rejected", status: res.status, message: `HTTP ${res.status}` };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[skillmeter] gh activation failed: activation endpoint returned invalid JSON");
    return { outcome: "transient", status: res.status, message: "invalid JSON in response" };
  }
  const jwt = payload?.token;
  if (!jwt) {
    console.error("[skillmeter] gh activation failed: response missing `token` field");
    return { outcome: "transient", status: res.status, message: "response missing token" };
  }

  // The validated org is carried in the JWT; just persist the license.
  if (!credstore.commitSignin({ jwt })) {
    console.error("[skillmeter] gh activation discarded: signed out during issuance");
    return { outcome: "signed_out" };
  }
  console.error("[skillmeter] gh activation succeeded");
  return { outcome: "reactivated", token: jwt };
}

/**
 * Compatibility wrapper for the sign-in commands: token string or null.
 */
async function trySilentGhActivate(deviceId) {
  const result = await silentGhActivate(deviceId);
  return result.outcome === "reactivated" ? result.token : null;
}

// ---------------------------------------------------------------------------
// Refresh orchestration with cross-process single-flight.
//
// Callers: SessionStart (once per session), the queue drains (right before an
// upload), and the retry-daemon monitor (every sweep, so a long session never
// runs on an expired token). A file lock collapses concurrent callers into a
// single /refresh round-trip; the license status record supplies backoff and
// terminal decisions across processes.
// ---------------------------------------------------------------------------

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
  // SessionStart and queue drainers may refresh an existing sign-in, but must
  // never create a brand-new sign-in before the user invokes /skillmeter:signin.
  // (ADR 001 decision 4 relaxes this for devices with a prior-sign-in marker;
  // that lands with A4.)
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
      break; // fall through to re-activation
    default:
      return null;
  }

  // The stored token can no longer be rotated (410/401). Only a new activation
  // helps, and only the gh-backed silent one is allowed here.
  let activation;
  try {
    activation = await silentGhActivate(deviceId);
  } catch (err) {
    activation = { outcome: "transient", message: err && err.message ? err.message : String(err) };
  }
  switch (activation.outcome) {
    case "reactivated":
      licenseStatus.recordRefreshSuccess({ source, outcome: "reactivated" });
      return activation.token;
    case "revoked":
      licenseStatus.recordTerminal({ source, reason: TERMINAL_REASONS.REVOKED, status: 402 });
      return null;
    case "gh_unauthenticated":
      licenseStatus.recordTerminal({
        source,
        reason: TERMINAL_REASONS.GH_UNAUTHENTICATED,
        message: activation.message,
      });
      return null;
    case "signed_out":
      return null;
    default:
      licenseStatus.recordRefreshFailure({
        source,
        kind: "activate",
        status: activation.status ?? rotation.status ?? null,
        message: activation.message || `refresh ${rotation.status}, activation ${activation.outcome}`,
      });
      return null;
  }
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

  // Record the attempt time — serves as both the in-flight marker (single
  // flight) and the cooldown anchor. Intentionally not deleted afterward; the
  // mtime ages out past STALE/COOLDOWN. Not matched by listSealedEventLogs /
  // cleanupStaleFiles (same as .drain-once.lock), so it's never swept.
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_REFRESH_LOCK_FILE, `${process.pid} ${Date.now()}\n`);
  } catch {
    // best-effort lock; proceed even if it couldn't be written
  }

  try {
    return (await refreshLicense(deviceId, { source, aheadMs })) || current;
  } catch {
    return current;
  }
}

module.exports = {
  trySilentGhActivate,
  refreshLicense,
  ensureFreshLicense,
};

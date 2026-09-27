/**
 * License renewal and retry orchestration, following ADR 001 and ADR 005.
 * A session with a broker refresh token renews through the refresh token grant
 * and /activate; one without (signed in before ADR 005) through /refresh.
 * Refresh 401/410 requires interactive sign-in; 402 marks the license revoked
 * and drops the token, so recording stops until a new sign-in.
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
const { getLicenseOrgs, getLicenseTenantSlug } = require("./jwt");
const broker = require("./broker");
const { exchangeIdToken } = require("./license-exchange");
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
 *   { outcome: "superseded" }                  authentication changed
 */
async function refreshExpiredJwt(jwt, deviceId, expected) {
  if (!jwt || !deviceId) return { outcome: "transient", message: "missing token or device id" };

  if (expected.deviceId !== deviceId || !credstore.isRecoveryCurrent(expected)) {
    return { outcome: "superseded" };
  }
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
  // Storing a malformed or already-expired token would replace the working one
  // and, counted as a rotation, repeat every sweep without backoff.
  if (typeof newJwt !== "string" || credstore.isLicenseTokenExpired(newJwt)) {
    console.error("[skillmeter] license refresh failed: response token is malformed or already expired");
    return { outcome: "transient", status: res.status, message: "unusable token in response" };
  }

  if (!credstore.commitRefresh(newJwt, expected)) return { outcome: "superseded" };
  console.error("[skillmeter] license refresh: rotated successfully");
  return { outcome: "rotated", token: newJwt };
}

/**
 * Renew through the broker (ADR 005): the refresh token grant, then /activate
 * pinned to the current license's tenant. Same outcomes as refreshExpiredJwt,
 * plus `expected`, the snapshot to settle the outcome against: it changes
 * when the broker rotated the refresh token, which is stored before the
 * exchange so a failure after it cannot strand the session on a spent token.
 */
async function renewViaBroker(jwt, deviceId, expected) {
  if (!credstore.isRecoveryCurrent(expected)) return { outcome: "superseded" };
  const grant = await broker.refreshGrant(expected.refreshToken);
  if (grant.outcome === "rejected") {
    console.error(`[skillmeter] license renewal: the broker ended this session (${grant.error}), sign-in required`);
    return { outcome: "rejected", status: grant.status, expected };
  }
  if (grant.outcome !== "granted") {
    console.error(`[skillmeter] license renewal failed at the broker: ${grant.message}`);
    return { outcome: "transient", status: grant.status, message: grant.message, expected };
  }

  let current = expected;
  if (grant.refreshToken !== expected.refreshToken) {
    if (!credstore.commitRotation(expected, grant.refreshToken)) return { outcome: "superseded" };
    current = { ...expected, refreshToken: grant.refreshToken };
  }

  const exchange = await exchangeIdToken(grant.idToken, deviceId, { org: getLicenseTenantSlug(jwt) });
  if (exchange.outcome === "revoked") {
    console.error("[skillmeter] license renewal: this workspace no longer licenses you");
    return { outcome: "revoked", status: exchange.status, expected: current };
  }
  if (exchange.outcome !== "issued") {
    // A 401 here refuses a broker token the broker just issued: a server
    // configuration problem, not a verdict on this session.
    const message = exchange.message || `HTTP ${exchange.status}`;
    console.error(`[skillmeter] license renewal failed at /activate: ${message}`);
    return { outcome: "transient", status: exchange.status ?? null, message, expected: current };
  }
  if (credstore.isLicenseTokenExpired(exchange.token)) {
    return { outcome: "transient", status: 200, message: "unusable token in response", expected: current };
  }
  if (!credstore.commitRefresh(exchange.token, current)) return { outcome: "superseded" };
  return { outcome: "rotated", token: exchange.token, expected: current };
}

// Upload drains refresh, in whichever process runs them (a detached drain,
// the monitor). The lock coordinates them; the status record supplies backoff
// and terminal state across processes.

const LICENSE_REFRESH_LOCK_FILE = path.join(LOG_DIR, ".license-refresh.lock");
// Don't retry a refresh within this window of the last attempt. Also serves as
// the in-flight single-flight window: a lock younger than this means another
// process is mid-refresh (or just finished), so we skip.
const LICENSE_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Pure single-flight + cooldown decision (no I/O — unit-testable). A lock
 * younger than the cooldown means "someone else has it / just refreshed", so
 * every caller skips, including a forced refresh after a 401.
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

// 402: the organization no longer licenses this user (license cancelled, or
// the user left or was removed from the workspace). What was recorded under
// it and not yet sent is removed (ADR 001, decision 3). Runs outside the
// credential lock because the purge helpers may take it.
function purgeRevokedLicenseData(token) {
  try {
    const { purgeOrganizationQueues } = require("./repository-queue");
    const { purgeOrganizationAuditQueues } = require("./organization-audit-queue");
    for (const org of getLicenseOrgs(token)) purgeOrganizationQueues(org);
    purgeOrganizationAuditQueues();
  } catch (err) {
    console.error(`[skillmeter] Revoked license cleanup failed: ${err.message}`);
  }
}

/**
 * Orchestrate one refresh and record its outcome. Returns the freshest token
 * or null. Reads the token uncached so a refresh written by another process is
 * observed.
 *
 * @param {string} deviceId
 * @param {object} [opts]
 * @param {string} [opts.source] who is asking (a drain, or a test)
 * @param {boolean} [opts.force] refresh even though the token looks fresh
 *   locally: the server rejected it (401), e.g. under clock skew
 */
async function refreshLicense(deviceId, { source = "unknown", force = false } = {}) {
  const expected = credstore.recoverySnapshot();
  if (expected.signedOut || expected.deviceId !== deviceId) return null;
  const current = expected.token;
  if (!force && current && !credstore.isLicenseTokenExpired(current)) return current;
  // Refresh requires an existing sign-in. A missing license requires
  // the user to invoke /skillmeter:signin.
  if (!current || !deviceId) return null;
  if (credstore.getSignedOut()) return null;

  // A session that holds a refresh token never falls back to /refresh: the
  // broker ended it, and the old license must not outlive that decision.
  const rotation = expected.refreshToken
    ? await renewViaBroker(current, deviceId, expected)
    : await refreshExpiredJwt(current, deviceId, expected);
  const settled = rotation.expected || expected;
  if (rotation.outcome === "revoked") {
    const dropped = credstore.dropRevokedLicense(settled, () =>
      licenseStatus.recordTerminal({ source, reason: TERMINAL_REASONS.REVOKED, status: rotation.status ?? 402 })
    );
    if (dropped === true) {
      purgeRevokedLicenseData(current);
      await broker.revoke(settled.refreshToken);
    }
    return null;
  }
  const completed = rotation.outcome === "rotated" ? { ...settled, token: rotation.token } : settled;
  let result = null;
  credstore.withRecoveryCurrent(completed, () => {
    switch (rotation.outcome) {
      case "rotated":
        licenseStatus.recordRefreshSuccess({ source, outcome: "rotated" });
        result = rotation.token;
        return;
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

    // Refresh 401/410, or a refresh token the broker no longer accepts, requires
    // a new browser-approved sign-in. Record a terminal state so background
    // callers do not keep retrying.
    licenseStatus.recordTerminal({
      source,
      reason: TERMINAL_REASONS.REACTIVATION_REQUIRED,
      status: rotation.status ?? null,
      message: "licence can no longer be refreshed — run /skillmeter:signin",
    });
  });
  return result;
}

/**
 * Best-effort, single-flight license refresh; the one refresh path. The upload
 * drains call it before sending a batch, and again with `force` after the
 * server rejects the token (401). Recording never waits for it (ADR 001,
 * decision 3), so nothing refreshes ahead of need. Never throws; returns the
 * freshest token available (refreshed, existing, or null). A cheap no-op when
 * the token is fresh, non-blocking when another process holds the refresh
 * lock, and silent while the status record says to back off or stop.
 */
async function ensureFreshLicense(deviceId, { source = "drain", force = false } = {}) {
  if (!deviceId) return null;
  if (credstore.getSignedOut()) return null;

  const current = credstore.getLicenseTokenUncached();
  const tokenFresh =
    !force && Boolean(current) && !credstore.isLicenseTokenExpired(current);
  if (tokenFresh) return current;

  // Backoff / terminal decisions are shared across processes through the
  // status record, so concurrent drains never fight over the same failure.
  if (licenseStatus.refreshBlockedReason(licenseStatus.readLicenseStatus(), Date.now())) {
    return current;
  }

  let lockMtimeMs = null;
  try {
    lockMtimeMs = fs.statSync(LICENSE_REFRESH_LOCK_FILE).mtimeMs;
  } catch {
    // lock absent
  }
  // A lock dated more than a cooldown into the future means the clock moved
  // back after it was written; left alone it would block refresh until the
  // clock caught up. Re-date it to now instead of reclaiming it: a refresh
  // still in flight under it finishes well within the cooldown, and the next
  // attempt after the cooldown proceeds as usual.
  if (lockMtimeMs != null && lockMtimeMs - Date.now() > LICENSE_REFRESH_COOLDOWN_MS) {
    // Same clock as every other lock-age comparison here.
    const nowSec = Date.now() / 1000;
    try { fs.utimesSync(LICENSE_REFRESH_LOCK_FILE, nowSec, nowSec); } catch {}
    return current;
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
    await refreshLicense(deviceId, { source, force });
  } catch {
    // A failed exchange or busy writer must not return the pre-await token.
  }
  const latest = credstore.recoverySnapshot();
  return latest.signedOut || latest.deviceId !== deviceId ? null : latest.token;
}

module.exports = {
  refreshLicense,
  ensureFreshLicense,
  // exported for tests
  _acquireRefreshLock: acquireRefreshLock,
};

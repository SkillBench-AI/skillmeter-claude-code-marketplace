/**
 * License renewal (ADR 005). The broker refresh token is the session; the
 * license is a cache renewed from it through the refresh token grant and
 * /activate, pinned to the license's tenant. There is no other renewal path.
 *
 * Renewal is single-flight for this client across every process on the
 * machine: the broker accepts a spent refresh token once within its grace
 * period and revokes the whole chain on a second use, and Codex can run
 * several hooks and drains at once.
 */

const fs = require("fs");
const path = require("path");
const credstore = require("../credstore");
const config = require("./config");
const broker = require("./broker");
const { exchangeIdToken } = require("./license-exchange");
const { getLicenseTenantSlug } = require("./jwt");
const { acquireLock } = require("./credential-lock");

// Transient failures back off exponentially from the retry sweep interval up to
// this cap and keep retrying there.
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

const statusFile = () => path.join(config.sessionDir(), "license-status.json");
const lockFile = () => path.join(config.sessionDir(), ".renew.lock");

// The status record belongs to one sign-in: a new sign-in or sign-out changes
// the generation, and a record from another generation reads as empty.
function readStatus() {
  try {
    const status = JSON.parse(fs.readFileSync(statusFile(), "utf8"));
    if (status && status.generation === credstore.getAuthGeneration()) return status;
  } catch {}
  return { failures: 0, next_retry_at: null, terminal: null };
}

function writeStatus(status) {
  try {
    fs.mkdirSync(config.sessionDir(), { recursive: true, mode: 0o700 });
    const tmp = `${statusFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...status, generation: credstore.getAuthGeneration() }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, statusFile());
  } catch {
    // A lost record restarts the backoff; renewal itself is unaffected.
  }
}

const recordSuccess = () => writeStatus({ failures: 0, next_retry_at: null, terminal: null });

function recordFailure(message) {
  const failures = readStatus().failures + 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
  writeStatus({ failures, next_retry_at: Date.now() + delay, terminal: null, last_error: String(message).slice(0, 200) });
}

// Terminal: retrying cannot help until the user signs in again.
const recordTerminal = reason => writeStatus({ failures: 0, next_retry_at: null, terminal: { reason, at: Date.now() } });

const TERMINAL = Object.freeze({
  REACTIVATION_REQUIRED: "reactivation_required", // the broker ended the session
  REVOKED: "revoked", // the workspace no longer licenses this user
});

/**
 * The one renewal step, under the lock. Outcomes:
 *   { outcome: "rotated", token }
 *   { outcome: "rejected" }     the broker ended the session (invalid_grant)
 *   { outcome: "revoked" }      402, or 404 for the pinned tenant
 *   { outcome: "transient", message }
 *   { outcome: "superseded" }   the session changed meanwhile
 */
async function renewViaBroker(expected) {
  const grant = await broker.refreshGrant(expected.refreshToken);
  if (grant.outcome === "rejected") return { outcome: "rejected" };
  if (grant.outcome !== "granted") return { outcome: "transient", message: grant.message };

  let current = expected;
  if (grant.refreshToken !== expected.refreshToken) {
    if (!credstore.commitRotation(expected, grant.refreshToken)) return { outcome: "superseded" };
    current = { ...expected, refreshToken: grant.refreshToken };
  }

  const exchange = await exchangeIdToken(grant.idToken, expected.deviceId, { org: getLicenseTenantSlug(expected.token) });
  if (exchange.outcome === "revoked") return { outcome: "revoked", expected: current };
  if (exchange.outcome !== "issued") {
    // A 401 here refuses a broker token the broker just issued: a server
    // configuration fault, not a verdict on this session.
    return { outcome: "transient", message: exchange.message || `HTTP ${exchange.status}` };
  }
  if (credstore.isLicenseTokenExpired(exchange.token)) {
    return { outcome: "transient", message: "unusable token in response" };
  }
  if (!credstore.commitRefresh(exchange.token, current)) return { outcome: "superseded" };
  return { outcome: "rotated", token: exchange.token };
}

/**
 * Return a fresh license, renewing it first when needed. Never throws.
 *
 * @param {string} deviceId
 * @param {object} [options]
 * @param {boolean} [options.force] renew although the license looks fresh
 *   locally: the collector rejected it
 * @param {(token: string) => void} [options.onRevoked] purge what was recorded
 *   under a license the workspace no longer grants; runs after the session is
 *   dropped
 * @returns {Promise<string|null>} the license to send with, or null
 */
async function ensureFreshLicense(deviceId, { force = false, onRevoked } = {}) {
  const snapshot = credstore.recoverySnapshot();
  if (snapshot.signedOut || !snapshot.token || !deviceId || snapshot.deviceId !== deviceId) return null;
  if (!force && !credstore.isLicenseTokenExpired(snapshot.token)) return snapshot.token;
  if (!snapshot.refreshToken) return null;

  const status = readStatus();
  if (status.terminal || (status.next_retry_at && Date.now() < status.next_retry_at)) return snapshot.token;

  let release;
  try { release = acquireLock(lockFile()); } catch { release = null; }
  // Another process is renewing; it commits for everyone.
  if (!release) return snapshot.token;
  try {
    // Re-read under the lock: the renewal may just have happened elsewhere.
    const expected = credstore.recoverySnapshot();
    if (expected.signedOut || !expected.token || !expected.refreshToken || expected.deviceId !== deviceId) return null;
    if (expected.token !== snapshot.token && !credstore.isLicenseTokenExpired(expected.token)) return expected.token;

    let result;
    try { result = await renewViaBroker(expected); }
    catch (err) { result = { outcome: "transient", message: err.message }; }

    switch (result.outcome) {
      case "rotated":
        recordSuccess();
        return result.token;
      case "rejected":
        console.error("[skillmeter] License renewal: the sign-in service ended this session; sign in again");
        recordTerminal(TERMINAL.REACTIVATION_REQUIRED);
        return null;
      case "revoked": {
        console.error("[skillmeter] License renewal: this workspace no longer licenses you; recording stopped");
        const settled = result.expected;
        const dropped = credstore.dropSession(settled, () => recordTerminal(TERMINAL.REVOKED));
        if (dropped === true) {
          try { if (onRevoked) onRevoked(settled.token); } catch {}
          await broker.revoke(settled.refreshToken);
        }
        return null;
      }
      case "transient":
        console.error(`[skillmeter] License renewal failed: ${result.message}`);
        recordFailure(result.message);
        return snapshot.token;
      default:
        return credstore.getLicenseToken();
    }
  } finally {
    try { release(); } catch {}
  }
}

module.exports = {
  ensureFreshLicense,
  readStatus,
  clearStatus: recordSuccess,
  TERMINAL,
};

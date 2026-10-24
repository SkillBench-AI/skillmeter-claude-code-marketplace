// GENERATED from shared/lib/license-renewal.js by scripts/sync-shared.mjs. Edit that file, not this copy.
"use strict";

/**
 * License renewal, shared by both clients (ADR 001, ADR 005). The broker
 * refresh token is the session; the license is a cache renewed from it
 * through the refresh token grant and /activate, pinned to the license's
 * tenant. There is no other renewal path, and no background path starts a new
 * device grant.
 *
 * Renewal is single-flight across every process of a client, under the
 * dead-owner lock (credential-lock.js): the broker accepts a spent refresh
 * token once within its grace period and revokes the whole chain on a second
 * use, so a live renewal is never taken over, however long it runs. Failed
 * renewals back off exponentially.
 *
 * Each client keeps its own status record and passes it in as `client`:
 *   lockFile()                        where this session's renewal lock lives
 *   blocked()                         a reason not to try now (backoff, terminal), or null
 *   recordSuccess(settled)
 *   recordFailure({ status, message }, settled)
 *   recordTerminal({ reason, status, message }, settled)
 *   onRevoked(token)                  optional: purge what was recorded under the license
 */

const credstore = require("../credstore");
const broker = require("./broker");
const { exchangeIdToken } = require("./license-exchange");
const { getLicenseTenantSlug } = require("./jwt");
const { acquireLock } = require("./credential-lock");
const { SIGNIN_COMMAND } = require("./config");

const TERMINAL = Object.freeze({
  REACTIVATION_REQUIRED: "reactivation_required", // only a new sign-in helps
  REVOKED: "revoked", // the workspace no longer licenses this user
});

// Transient failures back off from `baseMs`, doubling up to the cap, and keep
// retrying at the cap.
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
function backoffDelayMs(consecutiveFailures, baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS) {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(baseMs * 2 ** (consecutiveFailures - 1), capMs);
}

/**
 * The one renewal step. Outcomes, each with `expected`, the snapshot to settle
 * against (it changes when the broker rotated the refresh token, which is
 * stored before the exchange so a later failure cannot strand the session on
 * a spent token):
 *   { outcome: "rotated", token }      new license, already stored
 *   { outcome: "rejected", status? }   the broker ended the session
 *   { outcome: "revoked", status }     402, or 404 for the pinned tenant
 *   { outcome: "transient", status?, message }
 *   { outcome: "superseded" }          the session changed meanwhile
 */
async function renewViaBroker(expected) {
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

  const exchange = await exchangeIdToken(grant.idToken, expected.deviceId, { org: getLicenseTenantSlug(expected.token) });
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

// Renew and record the outcome; returns { outcome, token }. Never throws.
async function renewAndRecord(deviceId, client, force) {
  const expected = credstore.recoverySnapshot();
  if (expected.signedOut || !expected.token || !deviceId || expected.deviceId !== deviceId) {
    return { outcome: "signed_out", token: null };
  }
  if (!force && !credstore.isLicenseTokenExpired(expected.token)) return { outcome: "fresh", token: expected.token };

  // Without a refresh token (a session from before ADR 005) the license cannot
  // be renewed: only a new sign-in helps, and the status says so.
  let result;
  if (!expected.refreshToken) {
    result = { outcome: "rejected", status: null, expected };
  } else {
    try { result = await renewViaBroker(expected); }
    catch (err) { result = { outcome: "transient", status: null, message: err.message, expected }; }
  }
  // The session to record against: after a renewal it holds the new license.
  const settled = result.outcome === "rotated"
    ? { ...result.expected, token: result.token }
    : result.expected || expected;

  switch (result.outcome) {
    case "rotated":
      client.recordSuccess(settled);
      return { outcome: "rotated", token: result.token };
    case "rejected":
      client.recordTerminal({
        reason: TERMINAL.REACTIVATION_REQUIRED,
        status: result.status ?? null,
        message: `license can no longer be renewed; run ${SIGNIN_COMMAND}`,
      }, settled);
      return { outcome: "rejected", token: null };
    case "revoked": {
      const dropped = credstore.dropSession(settled, () =>
        client.recordTerminal({ reason: TERMINAL.REVOKED, status: result.status ?? 402, message: "" }, settled));
      if (dropped === true) {
        try { if (client.onRevoked) client.onRevoked(settled.token); } catch {}
        await broker.revoke(settled.refreshToken);
      }
      return { outcome: "revoked", token: null };
    }
    case "transient":
      client.recordFailure({ status: result.status ?? null, message: result.message }, settled);
      return { outcome: "transient", token: null };
    default:
      return { outcome: result.outcome, token: null };
  }
}

/**
 * Renew now, without the single-flight lock (callers that need it use
 * ensureFresh), and record the outcome. Returns the new license, the current
 * one when it is still fresh and `force` is off, or null. Never throws.
 */
async function renewNow(deviceId, client, { force = false } = {}) {
  return (await renewAndRecord(deviceId, client, force)).token;
}

/**
 * Return a license to send with, renewing it first when needed: the one
 * renewal path for uploads, called again with `force` after the collector
 * rejects the license. Cheap when the license is fresh, non-blocking while
 * another process renews or the status says to wait, and never throws.
 */
async function ensureFresh(deviceId, client, { force = false } = {}) {
  const snapshot = credstore.recoverySnapshot();
  if (snapshot.signedOut || !snapshot.token || !deviceId || snapshot.deviceId !== deviceId) return null;
  if (!force && !credstore.isLicenseTokenExpired(snapshot.token)) return snapshot.token;
  if (client.blocked()) return snapshot.token;

  let release;
  try { release = acquireLock(client.lockFile()); } catch { release = null; }
  // Another process is renewing; it commits for everyone.
  if (!release) return snapshot.token;
  try {
    // Re-read under the lock: the renewal may just have happened elsewhere.
    const expected = credstore.recoverySnapshot();
    if (expected.signedOut || !expected.token || expected.deviceId !== deviceId) return null;
    if (expected.token !== snapshot.token && !credstore.isLicenseTokenExpired(expected.token)) return expected.token;
    const { outcome, token } = await renewAndRecord(deviceId, client, true);
    if (token) return token;
    // The session ended (a new sign-in is needed, or the license was revoked):
    // nothing to send with. Otherwise keep what there is; the status record
    // decides when to try again.
    if (outcome === "rejected" || outcome === "revoked" || outcome === "signed_out") return null;
    return credstore.getLicenseToken();
  } finally {
    try { release(); } catch {}
  }
}

module.exports = { TERMINAL, BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelayMs, renewNow, ensureFresh };

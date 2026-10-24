/**
 * License renewal for SkillMeter for Claude Code: the shared flow in
 * license-renewal.js (ADR 001, ADR 005) with this client's status record,
 * license-status.js, which SessionStart and the collection state also read.
 * A revoked license (402) drops the session and purges what was recorded under
 * it; a session the broker ended, or one without a refresh token, waits for a
 * new sign-in. SessionStart or explicit sign-in can reset terminal state.
 */

const fs = require("fs");
const path = require("path");
const credstore = require("../credstore");
const { ACCOUNT_DIR, LOG_DIR } = require("./paths");
const { getLicenseOrgs } = require("./jwt");
const licenseStatus = require("./license-status");
const renewal = require("./license-renewal");

// The renewal lock, held by its live owner for one renewal (credential-lock.js).
// Versions up to 0.45.1 kept a cooldown lock at LOG_DIR/.license-refresh.lock
// and left it in place on purpose. The dead-owner protocol would read that
// file's format as held forever, so the lock has a new name and the old file is
// removed.
const LOCK_FILE = path.join(ACCOUNT_DIR, ".renew.lock");
const LEGACY_LOCK_FILE = path.join(LOG_DIR, ".license-refresh.lock");

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

// This client's side of the shared flow. Outcomes are recorded only while
// their session is still current; a revocation is recorded as its session is
// dropped, under the store's lock.
function client(source) {
  return {
    lockFile: () => {
      try { fs.unlinkSync(LEGACY_LOCK_FILE); } catch {}
      return LOCK_FILE;
    },
    blocked: () => licenseStatus.refreshBlockedReason(licenseStatus.readLicenseStatus(), Date.now()),
    recordSuccess: (settled) => credstore.withRecoveryCurrent(settled, () =>
      licenseStatus.recordRefreshSuccess({ source, outcome: "rotated" })),
    recordFailure: ({ status, message }, settled) => credstore.withRecoveryCurrent(settled, () =>
      licenseStatus.recordRefreshFailure({ source, kind: "refresh", status, message })),
    recordTerminal: ({ reason, status, message }, settled) => {
      const record = () => licenseStatus.recordTerminal({ source, reason, status, message });
      if (reason === renewal.TERMINAL.REVOKED) record();
      else credstore.withRecoveryCurrent(settled, record);
    },
    onRevoked: purgeRevokedLicenseData,
  };
}

/**
 * Renew now, without the single-flight lock, and record the outcome. Returns
 * the new license, the current one after a transient failure, or null.
 * @param {string} deviceId
 * @param {object} [opts]
 * @param {string} [opts.source] who is asking (a drain, or a test)
 * @param {boolean} [opts.force] renew although the license looks fresh
 */
function refreshLicense(deviceId, { source = "unknown", force = false } = {}) {
  return renewal.renewNow(deviceId, client(source), { force });
}

/**
 * The one renewal path for uploads: the drains call it before sending, and
 * again with `force` after the collector rejects the license (401). Never
 * throws; non-blocking while another process renews or the status record says
 * to wait.
 */
function ensureFreshLicense(deviceId, { source = "drain", force = false } = {}) {
  return renewal.ensureFresh(deviceId, client(source), { force });
}

module.exports = { refreshLicense, ensureFreshLicense };

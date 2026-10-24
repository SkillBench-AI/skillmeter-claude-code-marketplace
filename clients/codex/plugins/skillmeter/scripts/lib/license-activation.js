/**
 * License renewal for SkillMeter for Codex: the shared flow in
 * license-renewal.js (ADR 005) with this client's status record, which belongs
 * to one sign-in: a new sign-in or sign-out changes the generation, and a
 * record from another generation reads as empty.
 */

const fs = require("fs");
const path = require("path");
const credstore = require("../credstore");
const config = require("./config");
const renewal = require("./license-renewal");

const { TERMINAL } = renewal;

const statusFile = () => path.join(config.sessionDir(), "license-status.json");
const lockFile = () => path.join(config.sessionDir(), ".renew.lock");

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

function recordFailure({ message }) {
  const failures = readStatus().failures + 1;
  writeStatus({ failures, next_retry_at: Date.now() + renewal.backoffDelayMs(failures), terminal: null,
    last_error: String(message).slice(0, 200) });
}

// Terminal: retrying cannot help until the user signs in again.
const recordTerminal = ({ reason }) => writeStatus({ failures: 0, next_retry_at: null, terminal: { reason, at: Date.now() } });

function blocked() {
  const status = readStatus();
  if (status.terminal) return "terminal";
  return status.next_retry_at && Date.now() < status.next_retry_at ? "backoff" : null;
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
function ensureFreshLicense(deviceId, { force = false, onRevoked } = {}) {
  return renewal.ensureFresh(deviceId, { lockFile, blocked, recordSuccess, recordFailure, recordTerminal, onRevoked }, { force });
}

module.exports = {
  ensureFreshLicense,
  readStatus,
  clearStatus: recordSuccess,
  TERMINAL,
};

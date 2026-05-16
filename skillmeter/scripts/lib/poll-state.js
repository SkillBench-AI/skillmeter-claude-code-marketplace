/**
 * Tracks whether a detached `/skillmeter:signin` background poll is
 * currently waiting on GitHub approval. The expansion hook reads this
 * to decide whether to short-poll the credstore for a freshly-issued
 * license before falling back to "interactive login required".
 *
 * State is a small JSON sentinel at ~/.skillbench/poll-state.json:
 *   { "started_at": <unix seconds> }
 *
 * The file is created when the background poll spawns and deleted when
 * it exits (success or failure). A poll older than 16 minutes is treated
 * as stale — GitHub device codes expire at 15 minutes.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const POLL_STATE_FILE = path.join(os.homedir(), ".skillbench", "poll-state.json");
const STALE_AFTER_SECONDS = 16 * 60;

function markPollStarted() {
  try {
    fs.mkdirSync(path.dirname(POLL_STATE_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      POLL_STATE_FILE,
      JSON.stringify({ started_at: Math.floor(Date.now() / 1000) }),
      { mode: 0o600 }
    );
  } catch {}
}

function markPollEnded() {
  try { fs.unlinkSync(POLL_STATE_FILE); } catch {}
}

function isPollActive() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(POLL_STATE_FILE, "utf8"));
  } catch {
    return false;
  }
  const startedAt = Number(state?.started_at) || 0;
  if (!startedAt) return false;
  const ageSeconds = Math.floor(Date.now() / 1000) - startedAt;
  if (ageSeconds > STALE_AFTER_SECONDS) {
    markPollEnded();
    return false;
  }
  return true;
}

/**
 * Block until either a non-expired license appears in the credstore or
 * the background poll exits, whichever comes first. Returns true when a
 * usable license is found, false on timeout / poll failure.
 */
async function waitForLicense(credstore, timeoutMs = 10_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = credstore.getLicenseToken();
    if (token && !credstore.isLicenseTokenExpired(token)) {
      return true;
    }
    if (!isPollActive()) {
      // Poll exited without producing a license — nothing more to wait for.
      return false;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

module.exports = {
  POLL_STATE_FILE,
  markPollStarted,
  markPollEnded,
  isPollActive,
  waitForLicense,
};

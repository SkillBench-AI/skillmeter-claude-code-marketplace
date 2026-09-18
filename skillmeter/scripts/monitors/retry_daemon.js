#!/usr/bin/env node
/**
 * Refresh licenses and drain queues during interactive sessions. Refresh runs
 * on every sweep with its own status/backoff; queue drains have separate backoff.
 * SessionStart remains the fallback when plugin monitors are unavailable.
 * Delay the first sweep to reduce overlap with startup retries.
 * Keep stdout silent: monitor stdout becomes a Claude notification. Use stderr
 * for diagnostics.
 */

const transfer = require("../lib/transfer");
const credstore = require("../credstore");
const { ensureFreshLicense } = require("../lib/license-activation");
const { readLicenseStatus, refreshBlockedReason, clearTerminal } = require("../lib/license-status");
const { getRetryDaemonIntervalMs } = require("../lib/config");

const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = getRetryDaemonIntervalMs();
// Cap for the adaptive drain backoff when sweeps make no progress (e.g. the
// backend is down). Resets to INTERVAL_MS as soon as the queue shrinks.
const MAX_INTERVAL_MS = 30 * 60_000;

function log(msg) {
  // stderr so it's plugin-debug info, not a Claude notification.
  process.stderr.write(`[skillmeter-monitor] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Next wait before draining again. Doubles (up to the cap) while a sweep makes
 * no progress and files remain; resets to the base as soon as the queue
 * shrinks or empties. Pure.
 */
function nextDrainInterval(before, after, current, base = INTERVAL_MS, cap = MAX_INTERVAL_MS) {
  if (after > 0 && after >= before) return Math.min(current * 2, cap);
  return base;
}

/**
 * Refresh the license if it is near expiry. Cheap when the token is fresh (a
 * local `exp` check), silent while the status record says to back off, and a
 * one-line stderr note when the record has gone terminal.
 */
async function maybeRefreshLicense(state = {}) {
  let deviceId;
  try {
    deviceId = credstore.getDeviceId();
  } catch {
    return;
  }
  if (!deviceId) return;
  if (credstore.getSignedOut()) return;

  let status = readLicenseStatus();
  const token = credstore.getLicenseTokenUncached();
  // Two thresholds. Hooks accept a token until LICENSE_EXPIRY_SKEW_SECONDS
  // before exp; the daemon must renew one sweep earlier than that so no hook
  // ever meets an expired token between two ticks.
  const hookValid = Boolean(token) && !credstore.isLicenseTokenExpired(token);
  const proactiveFresh =
    Boolean(token) &&
    !credstore.isLicenseTokenExpired(token, credstore.LICENSE_EXPIRY_SKEW_SECONDS + Math.ceil(INTERVAL_MS / 1000));

  // A token hooks accept wins over any recorded failure: a sign-in, a
  // SessionStart refresh, or another client sharing credentials.json may have
  // renewed it while this daemon was backing off or stopped.
  if (hookValid && (status.terminal || status.next_retry_at || status.consecutive_failures)) {
    status = clearTerminal({ source: "daemon" });
  }
  if (proactiveFresh) return;

  const blocked = refreshBlockedReason(status, Date.now());
  if (blocked === "terminal") {
    const at = status.terminal && status.terminal.at;
    if (state.lastTerminalLogged !== at) {
      log(`license refresh stopped: ${status.terminal.reason} (a new session or /skillmeter:signin re-arms it)`);
      state.lastTerminalLogged = at;
    }
    return;
  }
  if (blocked === "backoff") return;

  try {
    // Renew one sweep interval ahead of the hooks' expiry threshold so no hook
    // ever sees an expired token between two ticks.
    await ensureFreshLicense(deviceId, { source: "daemon", aheadMs: INTERVAL_MS });
  } catch (err) {
    log(`license refresh error: ${err && err.message ? err.message : err}`);
  }
}

async function sweep() {
  try {
    await transfer.drainFailedLogs();
  } catch (err) {
    log(`event-log sweep error: ${err && err.message ? err.message : err}`);
  }
  try {
    await transfer.drainDeltaChunks();
  } catch (err) {
    log(`transcript-chunk sweep error: ${err && err.message ? err.message : err}`);
  }
}

async function main() {
  log(`started (initial delay ${INITIAL_DELAY_MS} ms, interval ${INTERVAL_MS} ms)`);
  await sleep(INITIAL_DELAY_MS);

  // The refresh check runs every tick. Draining follows its own adaptive
  // schedule (nextDrainInterval) so a dead backend slows uploads down without
  // ever slowing the token refresh down.
  let drainInterval = INTERVAL_MS;
  let nextDrainAt = 0;
  const refreshState = {};

  // Loop until Claude Code terminates the monitor process at session end.
  while (true) {
    await maybeRefreshLicense(refreshState);

    const now = Date.now();
    if (now >= nextDrainAt) {
      const before = transfer.queuedFileCount();
      await sweep();
      const after = transfer.queuedFileCount();
      drainInterval = nextDrainInterval(before, after, drainInterval);
      nextDrainAt = now + drainInterval;
    }

    await sleep(INTERVAL_MS);
  }
}

if (require.main === module) {
  // Exit cleanly on SIGTERM / SIGINT so Claude Code's monitor lifecycle works.
  // Nothing on disk is lost on abrupt exit because sealed event logs and pending
  // transcripts survive for the next retry pass.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      log(`received ${sig}, exiting`);
      process.exit(0);
    });
  }

  main().catch((err) => {
    log(`fatal: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { nextDrainInterval, maybeRefreshLicense, INTERVAL_MS, MAX_INTERVAL_MS };

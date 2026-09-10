#!/usr/bin/env node
/**
 * Long-running queue drain and license refresh daemon, launched as a plugin
 * monitor.
 *
 * Two jobs, every sweep, for the lifetime of an interactive session:
 *
 *   1. Keep the license token fresh. Hooks never refresh; before this daemon
 *      did, a token only rotated at SessionStart or inside a drain that had
 *      data to send, so a long session went dark once the token expired
 *      (ADR 001, decision 2). The refresh step runs on every tick regardless
 *      of the drain backoff below; its own failure backoff and terminal
 *      states live in the license status record.
 *   2. Drain durable queues. The SessionStart hook only retries pending
 *      uploads once; if the backend is down at session start and comes back
 *      later, sealed event logs and transcript delta chunks would otherwise
 *      wait for the next session.
 *
 * Relationship to SessionStart retry:
 *   - This does NOT replace `retryFailedLogs` / `retryFailedTranscripts` in
 *     `session_start.js`. Monitors only run in interactive sessions and
 *     require Claude Code v2.1.105+, so SessionStart remains the floor.
 *   - The first sweep here is intentionally delayed by INITIAL_DELAY_MS so
 *     it doesn't race with the SessionStart pass for the same files. The
 *     pending-file unlink on success makes a duplicate attempt a harmless
 *     no-op anyway, but we might as well not thrash.
 *
 * Output contract: every stdout line from a plugin monitor becomes a Claude-
 * facing notification. We write diagnostics to stderr (which just surfaces
 * in Claude Code's own logs, not notifications) and keep stdout silent.
 */

const transfer = require("../lib/transfer");
const credstore = require("../credstore");
const { ensureFreshLicense } = require("../lib/license-activation");
const { readLicenseStatus, refreshBlockedReason } = require("../lib/license-status");
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

  const status = readLicenseStatus();
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
    await ensureFreshLicense(deviceId, { source: "daemon" });
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

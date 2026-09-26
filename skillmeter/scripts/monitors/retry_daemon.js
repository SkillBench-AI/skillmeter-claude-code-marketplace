#!/usr/bin/env node
/**
 * Drain queues during interactive sessions. The drains refresh the license
 * themselves, just before they send, so this loop never refreshes on its own.
 * SessionStart and Stop spawn the same drain when plugin monitors are
 * unavailable.
 * Delay the first sweep to reduce overlap with startup retries.
 * Keep stdout silent: monitor stdout becomes a Claude notification. Use stderr
 * for diagnostics.
 */

const transfer = require("../lib/transfer");
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

  // Draining follows an adaptive schedule (nextDrainInterval) so a dead
  // backend slows uploads down.
  let drainInterval = INTERVAL_MS;
  let nextDrainAt = 0;

  // Loop until Claude Code terminates the monitor process at session end.
  while (true) {
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

module.exports = { nextDrainInterval, INTERVAL_MS, MAX_INTERVAL_MS };

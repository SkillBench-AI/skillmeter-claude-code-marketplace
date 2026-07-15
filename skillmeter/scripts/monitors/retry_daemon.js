#!/usr/bin/env node
/**
 * Long-running queue drain daemon, launched as a plugin monitor.
 *
 * Rationale: the SessionStart hook only retries pending uploads once. If the
 * backend happens to be down when a session starts and comes back five
 * minutes in, sealed event logs and pending transcripts sit on disk until the
 * *next* session. This daemon closes that gap by scanning durable queues on a
 * loop for the lifetime of an interactive session.
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
const { getRetryDaemonIntervalMs } = require("../lib/config");

const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = getRetryDaemonIntervalMs();
// Cap for the adaptive backoff when sweeps make no progress (e.g. the backend
// is down). Resets to INTERVAL_MS as soon as the queue shrinks.
const MAX_INTERVAL_MS = 30 * 60_000;

function log(msg) {
  // stderr so it's plugin-debug info, not a Claude notification.
  process.stderr.write(`[skillmeter-monitor] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // Adaptive backoff: when a sweep makes no progress and files remain (backend
  // down, refresh failing), exponentially grow the wait up to MAX_INTERVAL_MS
  // so we don't tight-loop on a dead endpoint. Reset to the base interval the
  // moment the queue shrinks. In-memory only — no per-file state.
  let interval = INTERVAL_MS;

  // Loop until Claude Code terminates the monitor process at session end.
  while (true) {
    const before = transfer.queuedFileCount();
    await sweep();
    const after = transfer.queuedFileCount();

    if (after > 0 && after >= before) {
      interval = Math.min(interval * 2, MAX_INTERVAL_MS);
    } else {
      interval = INTERVAL_MS;
    }

    await sleep(interval);
  }
}

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

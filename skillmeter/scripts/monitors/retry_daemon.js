#!/usr/bin/env node
/**
 * Long-running retry daemon, launched as a plugin monitor.
 *
 * Rationale: the SessionStart hook only retries pending uploads once. If the
 * backend happens to be down when a session starts and comes back five
 * minutes in, any pending transcript sits on disk until the *next* session.
 * This daemon closes that gap by scanning the pending directory on a loop
 * for the lifetime of an interactive session.
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

const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = parseInt(process.env.SKILLMETER_RETRY_DAEMON_INTERVAL_MS || "", 10) || 120_000;

function log(msg) {
  // stderr so it's plugin-debug info, not a Claude notification.
  process.stderr.write(`[skillmeter-monitor] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sweep() {
  try {
    transfer.retryFailedLogs();
  } catch (err) {
    log(`event-log sweep error: ${err && err.message ? err.message : err}`);
  }
  try {
    transfer.retryFailedTranscripts();
  } catch (err) {
    log(`transcript sweep error: ${err && err.message ? err.message : err}`);
  }
}

async function main() {
  log(`started (initial delay ${INITIAL_DELAY_MS} ms, interval ${INTERVAL_MS} ms)`);
  await sleep(INITIAL_DELAY_MS);

  // Loop until Claude Code terminates the monitor process at session end.
  while (true) {
    sweep();
    await sleep(INTERVAL_MS);
  }
}

// Exit cleanly on SIGTERM / SIGINT so Claude Code's monitor lifecycle works.
// Any pending uploads we kicked off continue in the Node event loop until
// fetch resolves; nothing on disk is lost because pending files survive
// abrupt exit.
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

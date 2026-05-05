#!/usr/bin/env node
/**
 * One-shot durable queue drain, spawned detached by final-session hooks.
 *
 * This process exists to reduce upload latency without making Claude Code wait
 * on network I/O. Queue files remain the source of truth: failed uploads leave
 * sealed event logs and pending transcripts on disk for SessionStart / monitor
 * retry.
 */

const {
  clearDrainOnceLock,
  drainQueuesOnce,
} = require("./lib/transfer");

async function main() {
  try {
    await drainQueuesOnce();
  } finally {
    clearDrainOnceLock();
  }
}

main().catch((err) => {
  process.stderr.write(`[skillmeter-drain-once] ${err && err.message ? err.message : err}\n`);
  clearDrainOnceLock();
  process.exit(0);
});

#!/usr/bin/env node
/**
 * Drain durable queues in a detached process so hooks do not wait on uploads.
 * Failed uploads remain available for SessionStart or monitor retries.
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

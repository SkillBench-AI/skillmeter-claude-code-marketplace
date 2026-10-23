#!/usr/bin/env node
/**
 * Retry durable uploads periodically after SessionStart.
 * A heartbeat lock coordinates monitors across sessions. Idle and lifetime limits
 * bound the detached process; queued data survives exit. Diagnostics use stderr.
 */

const logger = require("../logger.js");

const INITIAL_DELAY_MS = Math.max(
  1,
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_INITIAL_DELAY_MS || "", 10) || 60_000
);
const INTERVAL_MS = Math.max(
  1,
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_INTERVAL_MS || "", 10) || 120_000
);
const MAX_LIFETIME_MS = Math.max(
  1,
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_MAX_LIFETIME_MS || "", 10) || 8 * 60 * 60 * 1000
);
// Stop after this many consecutive sweeps with nothing queued (≈ idle window).
const MAX_IDLE_SWEEPS = Math.max(
  1,
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_MAX_IDLE_SWEEPS || "", 10) || 15
);

const startedAt = Date.now();
let idleSweeps = 0;
let stopping = false;

function log(msg) {
  process.stderr.write(`[skillmeter-monitor] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`exiting (${reason})`);
  logger.clearRetryDaemonLock();
  process.exit(code);
}

// Refresh before each drain. Healthy tokens normally need no network call;
// refresh errors leave the sweep running and can be retried on a later sweep.
async function maybeRefreshLicense() {
  try {
    const deviceId = logger.getDeviceId();
    if (!deviceId) return;
    await logger.tryRefreshLicense(deviceId);
  } catch (err) {
    log(`license refresh error: ${err && err.message ? err.message : err}`);
  }
}

async function sweep() {
  // If another daemon has taken over the lock, stand down.
  if (!logger.ownsRetryDaemonLock()) {
    shutdown("another retry monitor owns the lock");
    return;
  }
  logger.refreshRetryDaemonLock();

  // Refresh before draining so the drain uploads with the freshest token.
  await maybeRefreshLicense();

  let queued = 0;
  try {
    queued = await logger.drainQueuesOnce();
  } catch (err) {
    log(`sweep error: ${err && err.message ? err.message : err}`);
  }

  // Opportunistically prune fully-uploaded / aged-out files.
  try {
    logger.cleanupStaleFiles();
  } catch {}

  if (queued > 0) {
    idleSweeps = 0;
  } else {
    idleSweeps += 1;
  }
}

async function main() {
  log(
    `started (initial delay ${INITIAL_DELAY_MS} ms, interval ${INTERVAL_MS} ms)`
  );
  // Claim/refresh the lock up front in case we were launched standalone.
  logger.refreshRetryDaemonLock();
  await sleep(INITIAL_DELAY_MS);

  while (!stopping) {
    await sweep();

    if (Date.now() - startedAt > MAX_LIFETIME_MS) {
      shutdown("max lifetime reached");
      return;
    }
    if (idleSweeps >= MAX_IDLE_SWEEPS) {
      shutdown("queues idle");
      return;
    }

    await sleep(INTERVAL_MS);
  }
}

if (require.main === module) {
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => shutdown(`received ${sig}`));
  }

  main().catch((err) => {
    log(`fatal: ${err && err.message ? err.message : err}`);
    logger.clearRetryDaemonLock();
    process.exit(1);
  });
}

module.exports = { sweep, maybeRefreshLicense, main };

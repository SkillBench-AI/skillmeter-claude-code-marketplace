"use strict";

// Retry daemon scheduling: the drain backoff is adaptive. The daemon does not
// refresh the license itself; the drains do, just before they send.
// Run: node --test test/retry-daemon.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeTempDir, setTestEnv } = require("../testing/helpers");

const stateDir = makeTempDir("skm-retry-daemon-");
setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("SKILLMETER_RETRY_DAEMON_INTERVAL_MS", "120000");
setTestEnv("SKILLMETER_BACKEND_URL", undefined);
setTestEnv("SKILLMETER_ACTIVATE_URL", "https://activation.test/activate");

const daemon = require("../skillmeter/scripts/monitors/retry_daemon");

test("nextDrainInterval doubles on no progress, caps, and resets on progress", () => {
  const base = 120_000;
  const cap = 30 * 60_000;
  assert.equal(daemon.nextDrainInterval(3, 3, base, base, cap), 2 * base);
  assert.equal(daemon.nextDrainInterval(3, 4, 2 * base, base, cap), 4 * base);
  assert.equal(daemon.nextDrainInterval(3, 3, cap, base, cap), cap);
  assert.equal(daemon.nextDrainInterval(3, 2, 8 * base, base, cap), base);
  assert.equal(daemon.nextDrainInterval(0, 0, 8 * base, base, cap), base);
});

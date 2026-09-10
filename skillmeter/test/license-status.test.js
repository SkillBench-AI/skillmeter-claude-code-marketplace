"use strict";

// License refresh status record: backoff math and the record transitions the
// retry daemon, SessionStart, and the sign-in commands rely on (ADR 001, D2).
// Run: node --test skillmeter/test/license-status.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, setTestEnv } = require("../testing/helpers");

const stateDir = makeTempDir("skm-license-status-");
setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("SKILLMETER_RETRY_DAEMON_INTERVAL_MS", "120000");

const ls = require("../scripts/lib/license-status");

const MIN = 60_000;
const BASE = 2 * MIN;
const CAP = 30 * MIN;

test("backoffDelayMs doubles from the base and stops at the cap", () => {
  const delays = [1, 2, 3, 4, 5, 6].map((n) => ls.backoffDelayMs(n, BASE, CAP) / MIN);
  assert.deepEqual(delays, [2, 4, 8, 16, 30, 30]);
  assert.equal(ls.backoffDelayMs(0, BASE, CAP), 0);
});

test("backoffExhausted flips only after a full cap-length wait has failed", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((n) => ls.backoffExhausted(n, BASE, CAP)),
    [false, false, false, false, false, true, true]
  );
});

test("refreshBlockedReason: null, backoff, terminal", () => {
  const now = 1_000_000;
  assert.equal(ls.refreshBlockedReason(null, now), null);
  assert.equal(ls.refreshBlockedReason({ next_retry_at: null, terminal: null }, now), null);
  assert.equal(ls.refreshBlockedReason({ next_retry_at: now + 1, terminal: null }, now), "backoff");
  assert.equal(ls.refreshBlockedReason({ next_retry_at: now - 1, terminal: null }, now), null);
  assert.equal(
    ls.refreshBlockedReason({ next_retry_at: null, terminal: { reason: "revoked" } }, now),
    "terminal"
  );
});

test("record lives next to credentials.json and starts empty", () => {
  ls.clearLicenseStatus();
  assert.equal(path.dirname(ls.LICENSE_STATUS_FILE), stateDir);
  assert.ok(fs.existsSync(ls.LICENSE_STATUS_FILE));
  const s = ls.readLicenseStatus();
  assert.equal(s.consecutive_failures, 0);
  assert.equal(s.terminal, null);
  assert.equal(s.next_retry_at, null);
  assert.equal(s.updated_by, "signin");
});

test("failures advance the backoff and the sixth failure at the cap is terminal", () => {
  ls.clearLicenseStatus();
  const t0 = 10_000_000;
  let s;
  for (let i = 1; i <= 5; i++) {
    s = ls.recordRefreshFailure({
      source: "daemon",
      kind: "refresh",
      status: 500,
      message: "HTTP 500",
      now: t0 + i,
      baseMs: BASE,
      capMs: CAP,
    });
    assert.equal(s.consecutive_failures, i);
    assert.equal(s.terminal, null, `failure ${i} must not be terminal`);
    assert.equal(s.last_outcome, "transient_failure");
    assert.equal(s.next_retry_at, t0 + i + ls.backoffDelayMs(i, BASE, CAP));
  }
  assert.equal(s.next_retry_at - (t0 + 5), CAP);
  assert.equal(ls.refreshBlockedReason(s, t0 + 5 + CAP - 1), "backoff");
  assert.equal(ls.refreshBlockedReason(s, t0 + 5 + CAP), null);

  s = ls.recordRefreshFailure({ source: "daemon", now: t0 + 6, baseMs: BASE, capMs: CAP });
  assert.equal(s.consecutive_failures, 6);
  assert.equal(s.terminal.reason, ls.TERMINAL_REASONS.BACKOFF_EXHAUSTED);
  assert.equal(s.next_retry_at, null);
  assert.equal(s.last_outcome, "terminal");
  assert.equal(ls.refreshBlockedReason(s, t0 + 7), "terminal");
});

test("success resets the counters and clears terminal", () => {
  ls.recordTerminal({ source: "daemon", reason: ls.TERMINAL_REASONS.REVOKED, status: 402, now: 5 });
  let s = ls.readLicenseStatus();
  assert.equal(s.terminal.reason, "revoked");
  assert.equal(s.last_error.status, 402);

  s = ls.recordRefreshSuccess({ source: "session_start", outcome: "reactivated", now: 9 });
  assert.equal(s.consecutive_failures, 0);
  assert.equal(s.terminal, null);
  assert.equal(s.next_retry_at, null);
  assert.equal(s.last_error, null);
  assert.equal(s.last_outcome, "reactivated");
  assert.equal(s.last_success_at, 9);
  assert.equal(s.updated_by, "session_start");
});

test("clearTerminal keeps history but re-arms retries; clearLicenseStatus wipes", () => {
  ls.recordRefreshSuccess({ source: "daemon", now: 100 });
  ls.recordTerminal({ source: "daemon", reason: ls.TERMINAL_REASONS.GH_UNAUTHENTICATED, now: 200 });
  let s = ls.clearTerminal({ source: "session_start" });
  assert.equal(s.terminal, null);
  assert.equal(s.consecutive_failures, 0);
  assert.equal(s.next_retry_at, null);
  assert.equal(s.last_success_at, 100, "history survives clearTerminal");
  assert.equal(s.last_error.kind, "gh_unauthenticated", "last error kept for notices");

  s = ls.clearLicenseStatus({ source: "signin" });
  assert.equal(s.last_success_at, null);
  assert.equal(s.last_error, null);
});

test("a terminal record stays terminal when a late transient failure lands", () => {
  ls.clearLicenseStatus();
  ls.recordTerminal({ source: "daemon", reason: ls.TERMINAL_REASONS.REVOKED, status: 402, now: 50 });
  const s = ls.recordRefreshFailure({ source: "session_start", kind: "refresh", status: 500, now: 60, baseMs: BASE, capMs: CAP });
  assert.equal(s.terminal.reason, "revoked", "terminal is not overwritten by a failure write");
  assert.equal(s.next_retry_at, null);
  assert.equal(s.last_attempt_at, 60);
  assert.equal(s.last_error.status, 500, "the late failure is still recorded as history");
});

test("a record with another schema version is ignored", () => {
  fs.writeFileSync(ls.LICENSE_STATUS_FILE, JSON.stringify({ schema_version: 99, terminal: { reason: "x" } }));
  assert.equal(ls.readLicenseStatus().terminal, null);
});

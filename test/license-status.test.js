"use strict";

// License refresh status record: backoff math and the record transitions the
// retry daemon, SessionStart, and the sign-in commands rely on (ADR 001, D2).
// Run: node --test test/license-status.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, setTestEnv } = require("../testing/helpers");

const stateDir = makeTempDir("skm-license-status-");
setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("SKILLMETER_RETRY_DAEMON_INTERVAL_MS", "120000");

const ls = require("../skillmeter/scripts/lib/license-status");

const MIN = 60_000;
const BASE = 2 * MIN;
const CAP = 30 * MIN;

test("backoffDelayMs doubles from the base and stops at the cap", () => {
  const delays = [1, 2, 3, 4, 5, 6].map((n) => ls.backoffDelayMs(n, BASE, CAP) / MIN);
  assert.deepEqual(delays, [2, 4, 8, 16, 30, 30]);
  assert.equal(ls.backoffDelayMs(0, BASE, CAP), 0);
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

test("failures advance the backoff and keep retrying at the cap; an outage is never terminal", () => {
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

  for (let i = 6; i <= 20; i++) {
    s = ls.recordRefreshFailure({ source: "daemon", now: t0 + i, baseMs: BASE, capMs: CAP });
    assert.equal(s.terminal, null, `failure ${i} must not be terminal`);
    assert.equal(s.next_retry_at, t0 + i + CAP, "retries continue at the cap");
  }
  assert.equal(ls.refreshBlockedReason(s, t0 + 20 + CAP), null, "recovers on its own");
});

test("a backoff_exhausted record left by an older version does not block refresh", () => {
  const legacy = {
    terminal: { reason: ls.TERMINAL_REASONS.BACKOFF_EXHAUSTED, at: 1 },
    next_retry_at: null,
  };
  assert.equal(ls.refreshBlockedReason(legacy, 2), null);
  const revoked = { terminal: { reason: ls.TERMINAL_REASONS.REVOKED, at: 1 } };
  assert.equal(ls.refreshBlockedReason(revoked, 2), "terminal");
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
  ls.recordTerminal({ source: "daemon", reason: ls.TERMINAL_REASONS.REACTIVATION_REQUIRED, now: 200 });
  let s = ls.clearTerminal({ source: "session_start" });
  assert.equal(s.terminal, null);
  assert.equal(s.consecutive_failures, 0);
  assert.equal(s.next_retry_at, null);
  assert.equal(s.last_success_at, 100, "history survives clearTerminal");
  assert.equal(s.last_error.kind, "reactivation_required", "last error kept for notices");

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

test("updateLicenseStatus re-applies a mutation on top of a concurrent write instead of overwriting it", () => {
  ls.clearLicenseStatus();
  let injected = false;
  const result = ls.updateLicenseStatus((prev) => {
    if (!injected) {
      injected = true;
      // Simulate another process committing between our read and our write.
      const other = { ...ls.readLicenseStatus(), terminal: { reason: "revoked", at: 1, status: 402, message: "" }, revision: (prev.revision || 0) + 1 };
      fs.writeFileSync(ls.LICENSE_STATUS_FILE, JSON.stringify(other));
    }
    return { ...prev, last_attempt_at: 777, updated_by: "daemon" };
  });
  assert.equal(result.last_attempt_at, 777, "our change landed");
  assert.equal(result.terminal.reason, "revoked", "the concurrent terminal write was preserved, not overwritten");
  const onDisk = ls.readLicenseStatus();
  assert.equal(onDisk.terminal.reason, "revoked");
  assert.equal(onDisk.last_attempt_at, 777);
  assert.equal(onDisk.revision, result.revision);
});

test("revision increases by one per committed transition", () => {
  ls.clearLicenseStatus();
  const r0 = ls.readLicenseStatus().revision;
  ls.recordRefreshFailure({ source: "daemon", now: 1, baseMs: BASE, capMs: CAP });
  ls.recordRefreshSuccess({ source: "daemon", now: 2 });
  assert.equal(ls.readLicenseStatus().revision, r0 + 2);
});

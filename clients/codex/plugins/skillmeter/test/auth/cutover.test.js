"use strict";
const { isolateHome, license, sessionFileIn } = require("../../test-support/plugin.cjs");
const home = isolateHome({ device_id: "SYNTHETIC", hash_salt: "synthetic" });
delete process.env.SKILLMETER_STATE_DIR;
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const store = require("../../scripts/credstore");
const logger = require("../../scripts/logger");
const queue = require("../../scripts/lib/transcript-delta");
const { prepareSession } = require("../../scripts/session_start");
const session = sessionFileIn(path.join(home, ".skillbench"));
const batch = path.join(logger.LOG_DIR, `events.jsonl.${Date.now()}`);
const bytes = '{"event":"synthetic-legacy-event","session_id":"old-tenant"}\n';
const signin = () => store.commitSignin({ jwt: license(), refreshToken: "synthetic-refresh", generation: store.markEngaged() });
const realFetch = global.fetch;
let requests;
beforeEach(() => {
  fs.rmSync(logger.LOG_DIR, { recursive: true, force: true });
  fs.mkdirSync(logger.LOG_DIR, { recursive: true });
  fs.rmSync(session, { force: true });
  fs.writeFileSync(batch, bytes);
  requests = 0;
  global.fetch = async () => { requests++; return { ok: true }; };
});
after(() => { global.fetch = realFetch; fs.rmSync(home, { recursive: true, force: true }); });

test("locked first-run batch blocks sign-in and delivery until a later purge succeeds", async () => {
  const release = queue.acquireLock(`${batch}.lock`);
  assert.ok(release);
  try {
    assert.equal(prepareSession(), false);
    assert.equal(store.isEventCutoverComplete(), false);
    assert.equal(signin(), false);
    assert.equal(await logger.processSealedBatch(batch), "held");
    assert.equal(requests, 0);
    assert.equal(fs.readFileSync(batch, "utf8"), bytes);
  } finally { release(); }
  assert.equal(await logger.processSealedBatch(batch), "auth");
  assert.equal(requests, 0);
  assert.equal(prepareSession(), true);
  assert.equal(fs.existsSync(batch), false);
  assert.equal(signin(), true);
  // A post-cutover row demonstrates that the gate resumes delivery.
  fs.writeFileSync(batch, '{"event":"synthetic-current-event"}\n');
  assert.equal(await logger.processSealedBatch(batch), "sent");
  assert.equal(requests, 1);
});

test("sign-in intent before SessionStart does not prove cutover completion", () => {
  const generation = store.markEngaged();
  assert.ok(fs.existsSync(session));
  assert.equal(store.commitSignin({ jwt: license(), refreshToken: "r", generation }), false);
  assert.equal(prepareSession(), true);
  assert.equal(fs.existsSync(batch), false);
  assert.equal(store.commitSignin({ jwt: license(), refreshToken: "r", generation }), true);
});

test("an existing markerless broker session is held without purging or refreshing", async () => {
  const saved = JSON.stringify({ license_jwt: license(), refresh_token: "synthetic-refresh", auth_generation: "old" });
  fs.writeFileSync(session, saved);
  assert.equal(prepareSession(), false);
  assert.equal(store.getLicenseToken(), null);
  assert.equal(store.recoverySnapshot().signedOut, true);
  assert.equal(await logger.processSealedBatch(batch), "auth");
  assert.equal(await logger.transferEventLog(batch), "auth");
  assert.equal(signin(), false);
  assert.equal(fs.readFileSync(batch, "utf8"), bytes);
  assert.equal(requests, 0);
});

test("partial purge failure and thrown errors cannot publish completion", () => {
  assert.equal(store.completeEventCutover(() => false), false);
  assert.throws(() => store.completeEventCutover(() => { throw new Error("disk failure"); }), /disk failure/);
  assert.equal(store.isEventCutoverComplete(), false);
  assert.equal(signin(), false);
  assert.equal(prepareSession(), true);
});

test("crash after purge but before marker commit is recoverable", () => {
  assert.throws(() => store.completeEventCutover(() => {
    assert.equal(logger.purgeEventLogs(), true);
    throw new Error("interrupted");
  }), /interrupted/);
  assert.equal(store.isEventCutoverComplete(), false);
  assert.equal(prepareSession(), true);
  assert.equal(signin(), true);
});

test("sign-in cannot interleave with purge under the session lock", () => {
  const result = store.completeEventCutover(() => {
    const child = spawnSync(process.execPath, ["-e", `
      const s = require(${JSON.stringify(require.resolve("../../scripts/credstore"))});
      try { s.markEngaged(); process.exit(2); }
      catch (e) { process.exit(e.message === 'credential-store-busy' ? 0 : 3); }
    `], { env: process.env, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    return logger.purgeEventLogs();
  });
  assert.equal(result, true);
});

test("completion survives sign-out and never purges later batches on SessionStart", () => {
  assert.equal(prepareSession(), true);
  assert.equal(signin(), true);
  store.signOut();
  fs.writeFileSync(batch, bytes);
  assert.equal(prepareSession(), true);
  assert.equal(fs.readFileSync(batch, "utf8"), bytes);
});

test("signin CLI reports an ambiguous cutover hold before contacting the broker", () => {
  fs.writeFileSync(session, JSON.stringify({ license_jwt: license(), refresh_token: "r" }));
  const child = spawnSync(process.execPath, ["-e", `
    global.fetch = () => { throw new Error('unexpected-network'); };
    require(${JSON.stringify(require.resolve("../../scripts/signin"))});
  `], { env: process.env, encoding: "utf8", timeout: 5000 });
  assert.notEqual(child.status, 0);
  assert.match(child.stdout + child.stderr, /event queue cutover is incomplete/);
  assert.doesNotMatch(child.stderr, /unexpected-network/);
  assert.equal(fs.readFileSync(batch, "utf8"), bytes);
});

test("malformed session state holds the queue instead of treating it as a fresh install", () => {
  for (const value of ['{broken', 'null', '[]']) {
    fs.writeFileSync(session, value);
    assert.equal(prepareSession(), false);
    assert.equal(fs.readFileSync(batch, "utf8"), bytes);
    assert.equal(store.getLicenseToken(), null);
  }
});

test("a busy session lock leaves the queue untouched and can be retried", () => {
  const { acquireLock } = require("../../scripts/lib/credential-lock");
  const release = acquireLock(`${session}.lock`);
  assert.ok(release);
  try {
    assert.equal(prepareSession(), false);
    assert.equal(fs.readFileSync(batch, "utf8"), bytes);
  } finally { release(); }
  assert.equal(prepareSession(), true);
});

test("cutover retries preserve transcript and cursor files", () => {
  const transcript = path.join(logger.LOG_DIR, "transcripts", "synthetic-cursor.json");
  fs.mkdirSync(path.dirname(transcript));
  fs.writeFileSync(transcript, '{"cursor":1}\n');
  assert.equal(prepareSession(), true);
  assert.equal(fs.readFileSync(transcript, "utf8"), '{"cursor":1}\n');
});

test("an existing broker session with no pending events completes without losing its session", () => {
  fs.renameSync(batch, `${batch}.sent`);
  const token = license();
  fs.writeFileSync(session, JSON.stringify({ license_jwt: token, refresh_token: "r", auth_generation: "existing" }));
  assert.equal(prepareSession(), true);
  assert.equal(store.getLicenseToken(), token);
  assert.equal(store.getAuthGeneration(), "existing");
  assert.equal(fs.readFileSync(`${batch}.sent`, "utf8"), bytes);
});


test("an unknown cutover version cannot authorize capture or trigger a destructive downgrade", () => {
  fs.writeFileSync(session, JSON.stringify({ event_cutover: 2 }));
  assert.equal(prepareSession(), false);
  assert.equal(store.getLicenseToken(), null);
  assert.equal(signin(), false);
  assert.equal(fs.readFileSync(batch, "utf8"), bytes);
});


test("an unreadable event directory is a hold, never evidence of an empty queue", () => {
  const readdir = fs.readdirSync;
  fs.readdirSync = function (file, ...args) {
    if (file === logger.LOG_DIR) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return readdir.call(this, file, ...args);
  };
  try {
    assert.equal(prepareSession(), false);
    fs.writeFileSync(session, JSON.stringify({ license_jwt: license(), refresh_token: "r" }));
    assert.equal(prepareSession(), false);
    assert.equal(store.getLicenseToken(), null);
    assert.equal(fs.readFileSync(batch, "utf8"), bytes);
  } finally { fs.readdirSync = readdir; }
});

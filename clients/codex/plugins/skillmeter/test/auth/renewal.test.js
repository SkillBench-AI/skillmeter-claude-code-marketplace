"use strict";
// License renewal through the broker (ADR 005): the refresh token grant, then
// /activate pinned to the license's tenant, single-flight across processes.
// Also the credential lock's reaping and fencing rules. The broker and the
// license server are fakes; no request leaves the process.
const { license, writeCredentials, sessionFileIn } = require("../../test-support/plugin.cjs");
const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { once } = require("node:events");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-renewal-"));
const stateDir = path.join(root, ".skillbench");
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PLUGIN_DATA = path.join(root, "data");
process.env.SKILLMETER_STATE_DIR = stateDir;
for (const name of ["SKILLMETER_BROKER_URL", "SKILLMETER_ACTIVATE_URL"]) delete process.env[name];

const sessionFile = sessionFileIn(stateDir);
const now = () => Math.floor(Date.now() / 1000);
const expiring = license({ exp: now() + 60, jti: "expiring" });
const renewed = license({ jti: "renewed" });
const credentials = { device_id: "TEST-DEVICE", hash_salt: "test", license_jwt: expiring, refresh_token: "refresh-1" };

const credstore = require("../../scripts/credstore");
const logger = require("../../scripts/logger");
const activation = require("../../scripts/lib/license-activation");
const { acquireLock } = require("../../scripts/lib/credential-lock");
const realFetch = global.fetch;
const realError = console.error;

const readSession = () => JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const renewLock = () => path.join(path.dirname(sessionFile), ".renew.lock");
function otherProcess(code) {
  childProcess.execFileSync(process.execPath, ["-e", `
    const store = require(${JSON.stringify(require.resolve("../../scripts/credstore"))});
    ${code}
  `], { env: process.env });
}

// A fake broker and license server. `grant` and `activate` return
// { status, body }; every request is recorded.
let requests, stderr;
function serve({ grant = () => ({ status: 200, body: { id_token: "id-token", refresh_token: "refresh-2" } }),
  activate = () => ({ status: 200, body: { token: renewed } }), revoke = () => ({ status: 200, body: {} }) } = {}) {
  global.fetch = async (url, options) => {
    const kind = url.endsWith("/oauth2/token") ? "grant" : url.endsWith("/oauth2/revoke") ? "revoke"
      : url.endsWith("/activate") ? "activate" : assert.fail(`unexpected request to ${url}`);
    const body = kind === "activate" ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body));
    const request = { kind, url, body, authorization: options.headers.Authorization };
    requests.push(request);
    const reply = await { grant, activate, revoke }[kind](request);
    const text = JSON.stringify(reply.body ?? {});
    return { ok: reply.status < 300, status: reply.status, text: async () => text, json: async () => JSON.parse(text) };
  };
}
const kinds = () => requests.map(r => r.kind);

beforeEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  writeCredentials(root, credentials, { stateDir });
  credstore.refreshFromDisk();
  logger.clearLicenseRejected();
  requests = []; stderr = [];
  console.error = (...args) => stderr.push(args.join(" "));
  global.fetch = async () => assert.fail("unexpected network attempt");
});
afterEach(() => {
  console.error = realError;
  global.fetch = realFetch;
  // A leaked refresh token in a log line reaches terminals and diagnostics.
  for (const secret of ["refresh-1", "refresh-2", "id-token"]) {
    assert.ok(!stderr.join("\n").includes(secret), `stderr must not contain ${secret}`);
  }
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("a fresh license is returned without renewing", async () => {
  writeCredentials(root, { ...credentials, license_jwt: renewed }, { stateDir });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), renewed);
});

test("an expiring license renews through the grant and /activate pinned to the tenant", async () => {
  serve();
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), renewed);
  assert.deepEqual(kinds(), ["grant", "activate"]);
  const [grant, exchange] = requests;
  assert.equal(grant.body.grant_type, "refresh_token");
  assert.equal(grant.body.refresh_token, "refresh-1");
  assert.equal(grant.body.client_id, "skillmeter-plugin");
  assert.equal(exchange.authorization, "Bearer id-token");
  assert.deepEqual(exchange.body, { device_id: "TEST-DEVICE", org: "acme" });
  const session = readSession();
  assert.equal(session.license_jwt, renewed);
  assert.equal(session.refresh_token, "refresh-2", "the rotated refresh token is the session now");
  assert.equal(activation.readStatus().failures, 0);
});

test("a broker that does not rotate keeps the same refresh token", async () => {
  serve({ grant: () => ({ status: 200, body: { id_token: "id-token" } }) });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), renewed);
  assert.equal(readSession().refresh_token, "refresh-1");
});

test("a collector rejection forces renewal of a license that looks fresh", async () => {
  const fresh = license({ jti: "fresh-but-rejected" });
  writeCredentials(root, { ...credentials, license_jwt: fresh }, { stateDir });
  logger.markLicenseRejected(401);
  serve();
  assert.equal(await logger.tryRefreshLicense("TEST-DEVICE"), renewed);
  assert.equal(logger.isLicenseRejected(), false);
});

for (const error of ["invalid_grant", "invalid_client"]) test(`${error} ends the session for good, without retrying`, async () => {
  serve({ grant: () => ({ status: 400, body: { error } }) });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), null);
  assert.equal(activation.readStatus().terminal.reason, activation.TERMINAL.REACTIVATION_REQUIRED);
  requests = [];
  await activation.ensureFreshLicense("TEST-DEVICE", { force: true });
  assert.deepEqual(kinds(), [], "a terminal session makes no further requests");
});

for (const [name, reply] of [["402", { status: 402, body: { code: "revoked" } }], ["404 for the pinned tenant", { status: 404, body: { code: "membership_removed" } }]])
test(`/activate ${name} drops the session, purges and revokes the rotated refresh token`, async () => {
  let purged = null;
  serve({ activate: () => reply });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE", { onRevoked: token => { purged = token; } }), null);
  assert.deepEqual(kinds(), ["grant", "activate", "revoke"]);
  assert.equal(requests[2].body.token, "refresh-2", "the live refresh token is the one revoked");
  assert.equal(requests[2].body.token_type_hint, "refresh_token");
  assert.equal(purged, expiring);
  const session = readSession();
  assert.equal(session.license_jwt, undefined);
  assert.equal(session.refresh_token, undefined);
  assert.notEqual(session.signed_out, true, "not a sign-out: signing in to a workspace that licenses the user resumes");
  assert.equal(activation.readStatus().terminal.reason, activation.TERMINAL.REVOKED);
  assert.equal(credstore.getLicenseToken(), null);
});

test("a rotation survives a failed /activate, and the next renewal uses it", async () => {
  serve({ activate: () => ({ status: 503, body: { error: "unavailable" } }) });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), expiring, "the current license is kept");
  assert.equal(readSession().refresh_token, "refresh-2");
  const status = activation.readStatus();
  assert.equal(status.failures, 1);
  assert.ok(status.next_retry_at > Date.now());

  requests = [];
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), expiring);
  assert.deepEqual(kinds(), [], "backoff holds the next attempt");

  activation.clearStatus();
  serve({ grant: request => ({ status: 200, body: { id_token: "id-token", refresh_token: request.body.refresh_token === "refresh-2" ? "refresh-3" : "wrong" } }) });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), renewed);
  assert.equal(requests[0].body.refresh_token, "refresh-2");
  assert.equal(readSession().refresh_token, "refresh-3");
});

test("a 401 from /activate is transient: the broker just issued the token", async () => {
  serve({ activate: () => ({ status: 401, body: {} }) });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), expiring);
  assert.equal(activation.readStatus().terminal, null);
  assert.equal(activation.readStatus().failures, 1);
});

test("overlapping renewals in one process make one grant", async () => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  serve({ grant: async () => { await gate; return { status: 200, body: { id_token: "id-token", refresh_token: "refresh-2" } }; } });
  const first = activation.ensureFreshLicense("TEST-DEVICE");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), expiring, "the second caller does not renew");
  unblock();
  assert.equal(await first, renewed);
  assert.deepEqual(kinds(), ["grant", "activate"]);
});

test("a renewal held by another process is not repeated", async () => {
  childProcess.execFileSync(process.execPath, ["-e", `
    const { acquireLock } = require(${JSON.stringify(require.resolve("../../scripts/lib/credential-lock"))});
    acquireLock(${JSON.stringify(renewLock())});
  `]);
  // The holder exited, so its lock is reclaimed at once; a live holder is not.
  const release = acquireLock(renewLock());
  try { assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), expiring); }
  finally { release(); }
  assert.deepEqual(kinds(), []);
});

test("a renewal that another process already committed is reused under the lock", async () => {
  otherProcess(`store.commitRefresh(${JSON.stringify(renewed)}, store.recoverySnapshot());`);
  serve();
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE", { force: true }), renewed);
});

for (const [action, code] of [
  ["sign-out", "store.signOut();"],
  ["sign-in", `store.commitSignin({ jwt: ${JSON.stringify(license({ jti: "other-signin" }))}, refreshToken: "other-refresh" });`],
]) test(`a ${action} during the grant is never overwritten`, async () => {
  serve({ grant: () => { otherProcess(code); return { status: 200, body: { id_token: "id-token", refresh_token: "refresh-2" } }; } });
  await activation.ensureFreshLicense("TEST-DEVICE");
  const session = readSession();
  assert.notEqual(session.license_jwt, renewed);
  assert.notEqual(session.refresh_token, "refresh-2");
  assert.deepEqual(kinds(), ["grant"], "a superseded renewal stops before /activate");
  if (action === "sign-out") assert.equal(session.signed_out, true);
  else assert.equal(session.refresh_token, "other-refresh");
});

test("a sign-in during /activate keeps the new sign-in's license", async () => {
  const other = license({ jti: "other-signin" });
  serve({ activate: () => {
    otherProcess(`store.commitSignin({ jwt: ${JSON.stringify(other)}, refreshToken: "other-refresh" });`);
    return { status: 200, body: { token: renewed } };
  } });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), other);
  assert.deepEqual([readSession().license_jwt, readSession().refresh_token], [other, "other-refresh"]);
});

test("a signed-out session, another device or no refresh token never renews", async () => {
  serve();
  assert.equal(await activation.ensureFreshLicense("ANOTHER-DEVICE"), null);
  writeCredentials(root, { ...credentials, refresh_token: undefined }, { stateDir });
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE"), null);
  credstore.signOut();
  assert.equal(await activation.ensureFreshLicense("TEST-DEVICE", { force: true }), null);
  assert.deepEqual(kinds(), []);
});

test("another client's fields in the shared file never reach this session", () => {
  const shared = path.join(stateDir, "credentials.json");
  fs.writeFileSync(shared, JSON.stringify({ ...JSON.parse(fs.readFileSync(shared, "utf8")),
    license_jwt: license({ jti: "claude" }), signed_out: true, auth_generation: "claude" }));
  assert.equal(credstore.getLicenseToken(), expiring);
  assert.equal(credstore.getSignedOut(), false);
  credstore.signOut();
  const after = JSON.parse(fs.readFileSync(shared, "utf8"));
  assert.equal(after.auth_generation, "claude", "this plugin never writes session fields to the shared file");
});

// ---------------------------------------------------------------------------
// The credential lock
// ---------------------------------------------------------------------------

test("writers read current state after waiting for the lock", async () => {
  const release = acquireLock(`${sessionFile}.lock`);
  const child = childProcess.spawn(process.execPath, ["-e", `
    const store = require(${JSON.stringify(require.resolve("../../scripts/credstore"))});
    process.send("ready");
    store.signOut();
    process.disconnect();
  `], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  try {
    await once(child, "message");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(readSession().signed_out, undefined);
    fs.writeFileSync(sessionFile, JSON.stringify({ ...readSession(), custom_field: "kept" }));
  } finally { release(); }
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(readSession().custom_field, "kept");
  assert.equal(readSession().signed_out, true);
});

// The age backstop can reap a paused holder, so a writer re-checks ownership
// before it persists.
test("a holder can tell that its lock was reaped", () => {
  const lock = `${sessionFile}.lock.fence`;
  const release = acquireLock(lock);
  assert.equal(release.stillHeld(), true);

  fs.unlinkSync(lock);
  assert.equal(release.stillHeld(), false);

  const replacement = acquireLock(lock);
  assert.equal(release.stillHeld(), false, "the replacement owner is not us");
  replacement();
});

// A replacement owner can land on a recycled inode; rewriting the owner file in
// place reproduces that on any filesystem.
test("a replacement owner is not mistaken for us when the inode is recycled", () => {
  const lock = `${sessionFile}.lock.recycled`;
  const release = acquireLock(lock);
  assert.equal(release.stillHeld(), true);
  const inode = fs.statSync(lock).ino;

  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  assert.equal(fs.statSync(lock).ino, inode, "same inode, different owner");
  assert.equal(release.stillHeld(), false, "ownership is by token, not inode");

  release();
  assert.equal(fs.existsSync(lock), true, "we must not unlink another owner's lock");
  fs.unlinkSync(lock);
});

test("a mutation preempted mid-flight retries on the newer state instead of clobbering", () => {
  let calls = 0;
  const outcome = credstore.mutateSession(session => {
    calls += 1;
    if (calls === 1) {
      // Paused past the staleness ceiling: reaped, and another writer commits.
      fs.unlinkSync(`${sessionFile}.lock`);
      fs.writeFileSync(sessionFile, JSON.stringify({ ...readSession(), custom_field: "other" }));
    }
    session.ours = true;
  });

  assert.equal(outcome, true);
  assert.equal(calls, 2, "the preempted attempt was retried, not persisted");
  assert.equal(readSession().ours, true, "our change landed");
  assert.equal(readSession().custom_field, "other", "the other writer's change survived");
});

// A pid can be reused by an unrelated process after a crash, so age, not
// liveness, decides when a stale lock is reaped.
for (const [name, owner] of [["a live unrelated process", JSON.stringify({ pid: process.pid })], ["an unparseable owner file", "not json"]]) {
  test(`a stale lock naming ${name} is still reaped`, () => {
    const lock = `${sessionFile}.lock.stale`;
    fs.writeFileSync(lock, owner);
    const old = Date.now() - 120_000;
    fs.utimesSync(lock, old / 1000, old / 1000);
    const release = acquireLock(lock);
    assert.equal(typeof release, "function", "the stale owner was reaped");
    release();
    assert.equal(fs.existsSync(lock), false);
  });
}

test("a fresh lock naming a live process is still respected", () => {
  const lock = `${sessionFile}.lock.fresh`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));

  assert.equal(acquireLock(lock), null, "a live owner is never evicted early");
  fs.unlinkSync(lock);
});

// A dead owner is recovered at once, without waiting for the age backstop.
test("a crashed writer's fresh lock is recovered immediately without evicting a live owner", () => {
  const lock = `${sessionFile}.lock`;
  childProcess.execFileSync(process.execPath, ["-e", `
    require(${JSON.stringify(require.resolve("../../scripts/lib/credential-lock"))})
      .acquireLock(${JSON.stringify(lock)});
  `]);
  const release = acquireLock(lock);
  assert.equal(typeof release, "function");
  try { assert.equal(acquireLock(lock), null); }
  finally { release(); }
  assert.equal(fs.existsSync(lock), false);
});

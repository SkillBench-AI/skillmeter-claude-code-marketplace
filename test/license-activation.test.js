"use strict";

// ADR001 refresh behavior: routine renewal, transient backoff, terminal
// 401/410/402 and shared status coordination. No silent GitHub activation.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, setTestEnv, makeJwt, writeJson } = require("../testing/helpers");

const stateDir = makeTempDir("skm-license-activation-");

setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("SKILLMETER_RETRY_DAEMON_INTERVAL_MS", "1000");
setTestEnv("SKILLMETER_ACTIVATE_URL", "https://activation.test/activate");
setTestEnv("SKILLMETER_BACKEND_URL", undefined);

const credstore = require("../skillmeter/scripts/credstore");
const licenseStatus = require("../skillmeter/scripts/lib/license-status");
const { refreshLicense, ensureFreshLicense, _acquireRefreshLock: acquireRefreshLock } = require("../skillmeter/scripts/lib/license-activation");
const { LOG_DIR } = require("../skillmeter/scripts/lib/paths");

const DEVICE_ID = "11111111-2222-4333-8444-555555555555";
const LOCK_FILE = path.join(LOG_DIR, ".license-refresh.lock");
const CRED_FILE = path.join(stateDir, "credentials.json");

function jwt({ expiresInSec }) {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    iat: Math.floor(Date.now() / 1000) - 60,
    aud: "https://skillbench.meter.skillbench.ai",
    sub: "170497842",
    github_id: 45455072,
    org: { login: "SkillBench-AI" },
  });
}
const EXPIRED = () => jwt({ expiresInSec: -60 });
const FRESH = () => jwt({ expiresInSec: 3600 });

function writeCreds(licenseJwt) {
  const store = { device_id: DEVICE_ID, hash_salt: "0123456789abcdef0123456789abcdef" };
  if (licenseJwt) store.license_jwt = licenseJwt;
  writeJson(CRED_FILE, store);
}

// fetch stub: queue of responses, records calls.
const calls = [];
let responses = [];
function respond(status, body) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  };
}
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  if (responses.length === 0) throw new Error(`unexpected fetch ${url}`);
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return next;
};
process.on("exit", () => {
  global.fetch = realFetch;
});

const realPath = process.env.PATH;

beforeEach(() => {
  calls.length = 0;
  responses = [];
  writeCreds(EXPIRED());
  licenseStatus.clearLicenseStatus({ source: "test" });
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  process.env.PATH = realPath;
});

test("fresh token: no network call, token returned as-is", async () => {
  const fresh = FRESH();
  writeCreds(fresh);
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), fresh);
  assert.equal(calls.length, 0);
});

test("force refreshes a token that looks fresh locally (the server said 401)", async () => {
  const fresh = FRESH();
  writeCreds(fresh);
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "drain" }), fresh);
  assert.equal(calls.length, 0, "a fresh token is left alone");

  const next = FRESH();
  responses = [respond(200, { token: next })];
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "drain", force: true }), next);
  assert.equal(calls.length, 1);
});

test("no stored token: nothing happens (A4 relaxes this)", async () => {
  writeCreds(null);
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 0);
});

test("routine expiry: /refresh rotates, stores, and records success", async () => {
  const next = FRESH();
  responses = [respond(200, { token: next })];
  const got = await refreshLicense(DEVICE_ID, { source: "daemon" });
  assert.equal(got, next);
  assert.equal(credstore.getLicenseTokenUncached(), next);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/refresh$/);
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.last_outcome, "rotated");
  assert.equal(s.consecutive_failures, 0);
  assert.equal(s.updated_by, "daemon");
});

test("transient 500: keep the token and back off", async () => {
  const before = credstore.getLicenseTokenUncached();
  responses = [respond(500, "boom")];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 1, "no /activate after a transient refresh failure");
  assert.equal(credstore.getLicenseTokenUncached(), before);
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.last_outcome, "transient_failure");
  assert.equal(s.consecutive_failures, 1);
  assert.equal(s.last_error.kind, "refresh");
  assert.equal(s.last_error.status, 500);
  assert.ok(s.next_retry_at > Date.now() - 1000);
  assert.equal(s.terminal, null);
});

for (const [label, token] of [
  ["a token that is not a JWT", () => "not-a-jwt"],
  ["an already-expired token", () => EXPIRED()],
]) {
  test(`a 200 carrying ${label} is transient and keeps the stored token`, async () => {
    const before = credstore.getLicenseTokenUncached();
    responses = [respond(200, { token: token() })];
    assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
    assert.equal(credstore.getLicenseTokenUncached(), before, "the working token is not replaced");
    const s = licenseStatus.readLicenseStatus();
    assert.equal(s.last_outcome, "transient_failure", "backs off instead of counting a rotation");
    assert.equal(s.consecutive_failures, 1);
  });
}

test("a refresh lock dated well into the future blocks for one cooldown, not until the clock catches up", async () => {
  // The clock moved back after another process wrote the lock.
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, "999 0\n");
  const future = new Date(Date.now() + 3 * 60 * 60_000);
  fs.utimesSync(LOCK_FILE, future, future);

  // First look: the lock is re-dated to now, not reclaimed, so a refresh that
  // may still be in flight under it is not duplicated.
  const current = credstore.getLicenseTokenUncached();
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "daemon" }), current);
  assert.equal(calls.length, 0);
  assert.ok(Math.abs(Date.now() - fs.statSync(LOCK_FILE).mtimeMs) < 60_000, "lock re-dated to now");

  // One cooldown later the refresh proceeds as usual.
  const aged = new Date(Date.now() - 120_000);
  fs.utimesSync(LOCK_FILE, aged, aged);
  const next = FRESH();
  responses = [respond(200, { token: next })];
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "daemon" }), next);
  assert.equal(calls.length, 1);
});

test("network error is transient too, and failures accumulate", async () => {
  // refreshLicense itself never gates on the record (ensureFreshLicense does),
  // so two back-to-back calls both reach the network and both count.
  responses = [new Error("ECONNRESET")];
  await refreshLicense(DEVICE_ID, { source: "drain" });
  responses = [new Error("ECONNRESET")];
  await refreshLicense(DEVICE_ID, { source: "drain" });
  assert.equal(licenseStatus.readLicenseStatus().consecutive_failures, 2);
  assert.equal(calls.length, 2);
});

test("402 on /refresh is terminal (revoked)", async () => {
  responses = [respond(402, { error: "license cancelled" })];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 1);
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.terminal.reason, licenseStatus.TERMINAL_REASONS.REVOKED);
  assert.equal(s.terminal.status, 402);
});

// 410 and 401 both mean "this token can never be rotated again". There used
// to be a silent `gh auth token` → /activate recovery behind them; with the
// GitHub path gone there is nothing the daemon can do, because the device
// grant needs a browser it does not have. So both end the retry loop rather
// than burning backoff on a call that cannot succeed.
test("410 is terminal: no second call, and the reason names what the user must do", async () => {
  responses = [respond(410, { error: "token too old" })];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 1, "nothing is attempted after the refresh is refused");
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.terminal.reason, licenseStatus.TERMINAL_REASONS.REACTIVATION_REQUIRED);
  assert.equal(s.terminal.status, 410);
  assert.match(s.terminal.message, /skillmeter:signin/);
});

test("401 is terminal the same way — a rotated signing key is not retryable either", async () => {
  responses = [respond(401, {})];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 1);
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.terminal.reason, licenseStatus.TERMINAL_REASONS.REACTIVATION_REQUIRED);
  assert.equal(s.terminal.status, 401);
});

// The stored token is left alone. It is expired and unrotatable, but the
// claims still carry the tenant and the meter endpoint, which the notices and
// the status banner read to tell the person which workspace they have fallen
// out of.
test("a terminal refresh does not delete the licence it could not rotate", async () => {
  const before = credstore.getLicenseTokenUncached();
  responses = [respond(410, {})];
  await refreshLicense(DEVICE_ID, { source: "daemon" });
  assert.equal(credstore.getLicenseTokenUncached(), before);
});

test("ensureFreshLicense skips the network while the record says terminal or backoff", async () => {
  licenseStatus.recordTerminal({ source: "daemon", reason: "revoked", status: 402 });
  const before = credstore.getLicenseTokenUncached();
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "daemon" }), before);
  assert.equal(calls.length, 0);

  licenseStatus.clearLicenseStatus({ source: "test" });
  licenseStatus.recordRefreshFailure({ source: "daemon", now: Date.now(), baseMs: 60_000 });
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "daemon" }), before);
  assert.equal(calls.length, 0);
});

test("ensureFreshLicense refreshes once the record is clear, and honours the lock cooldown", async () => {
  const next = FRESH();
  responses = [respond(200, { token: next })];
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "daemon" }), next);
  assert.equal(calls.length, 1);
  assert.ok(fs.existsSync(LOCK_FILE));

  // Expired again right away: the lock is younger than the cooldown, so the
  // second caller returns what it has without a network call.
  writeCreds(EXPIRED());
  const current = credstore.getLicenseTokenUncached();
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "drain" }), current);
  assert.equal(calls.length, 1);
});

test("signed out: neither path makes a network call", async () => {
  const store = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  store.signed_out = true;
  writeJson(CRED_FILE, store);
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 0);
});

test("refresh lock: exclusive create, live lock refused, stale lock claimed and replaced, replaced-by-live lock refused", () => {
  const now = Date.now();
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  assert.equal(acquireRefreshLock(false, 60_000, now), true, "no lock: acquired");
  assert.match(fs.readFileSync(LOCK_FILE, "utf8"), new RegExp(`^${process.pid} `));

  assert.equal(acquireRefreshLock(false, 60_000, now), false, "live lock, not judged stale: refused");
  assert.equal(acquireRefreshLock(true, 60_000, now), false, "judged stale by the caller, but the re-check sees a live lock: refused");

  // Age the lock past the cooldown: the takeover claims and replaces it.
  const old = new Date(now - 120_000);
  fs.utimesSync(LOCK_FILE, old, old);
  assert.equal(acquireRefreshLock(true, 60_000, now), true, "stale lock: claimed and replaced");
  assert.ok(now - fs.statSync(LOCK_FILE).mtimeMs < 60_000, "the replacement lock is fresh");
  assert.equal(fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".stale")).length, 0, "claim file cleaned up");
});

for (const status of [200, 401, 402, 500]) {
  test(`late refresh ${status} cannot cross a same-token sign-out/sign-in cycle`, async () => {
    const token = credstore.getLicenseTokenUncached();
    responses = [respond(status, { token: FRESH() })];
    const pending = refreshLicense(DEVICE_ID, { source: "old-process" });
    // The network response resolves on the next microtask, after the new intent.
    credstore.signOut();
    credstore.markEngaged();
    credstore.commitSignin({ jwt: token });
    licenseStatus.clearLicenseStatus({ source: "new-signin" });
    const before = fs.readFileSync(licenseStatus.LICENSE_STATUS_FILE, "utf8");
    assert.equal(await pending, null);
    assert.equal(credstore.getLicenseTokenUncached(), token);
    assert.equal(fs.readFileSync(licenseStatus.LICENSE_STATUS_FILE, "utf8"), before);
  });
}

test("ensureFreshLicense does not return a pre-signout token after an awaited refresh", async () => {
  responses = [respond(200, { token: FRESH() })];
  const pending = ensureFreshLicense(DEVICE_ID);
  credstore.signOut();
  assert.equal(await pending, null);
  assert.equal(credstore.getLicenseTokenUncached(), null);
});

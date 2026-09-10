"use strict";

// Refresh orchestration (ADR 001, decision 2): /refresh on routine expiry,
// silent gh re-activation only on 410/401, transient failures back off, 402 and
// a missing gh are terminal, and ensureFreshLicense honours the status record.
// Run: node --test skillmeter/test/license-activation.test.js

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, setTestEnv, makeJwt, writeJson } = require("../testing/helpers");

const stateDir = makeTempDir("skm-license-activation-");
const emptyBin = makeTempDir("skm-empty-bin-");
const ghBin = makeTempDir("skm-gh-bin-");
fs.writeFileSync(path.join(ghBin, "gh"), "#!/bin/sh\necho ghs_fake_token\n", { mode: 0o755 });

setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("SKILLMETER_RETRY_DAEMON_INTERVAL_MS", "1000");
setTestEnv("SKILLMETER_ACTIVATE_URL", "https://activation.test/activate");
setTestEnv("SKILLMETER_BACKEND_URL", undefined);

const credstore = require("../scripts/credstore");
const licenseStatus = require("../scripts/lib/license-status");
const { refreshLicense, ensureFreshLicense } = require("../scripts/lib/license-activation");
const { LOG_DIR } = require("../scripts/lib/paths");

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
function withGh(present) {
  process.env.PATH = present ? `${ghBin}:/usr/bin:/bin` : emptyBin;
}

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

test("transient 500: keep the token, back off, do not touch gh", async () => {
  withGh(true);
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

test("402 on /refresh is terminal (revoked); no re-activation", async () => {
  withGh(true);
  responses = [respond(402, { error: "license cancelled" })];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 1);
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.terminal.reason, licenseStatus.TERMINAL_REASONS.REVOKED);
  assert.equal(s.terminal.status, 402);
});

test("410 with gh unavailable is terminal (gh_unauthenticated)", async () => {
  withGh(false);
  responses = [respond(410, { error: "token too old" })];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 1, "activation endpoint not called when gh has no token");
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.terminal.reason, licenseStatus.TERMINAL_REASONS.GH_UNAUTHENTICATED);
});

test("410 with gh available: silent /activate re-activates and commits", async () => {
  withGh(true);
  const next = FRESH();
  responses = [respond(410, {}), respond(200, { token: next })];
  const got = await refreshLicense(DEVICE_ID, { source: "session_start" });
  assert.equal(got, next);
  assert.equal(credstore.getLicenseTokenUncached(), next);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/activate$/);
  assert.equal(calls[1].opts.headers.Authorization, "Bearer ghs_fake_token");
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.last_outcome, "reactivated");
  assert.equal(s.consecutive_failures, 0);
});

test("401 with gh available: re-activation is attempted; a 5xx there is a transient activate failure", async () => {
  withGh(true);
  responses = [respond(401, {}), respond(503, "down")];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "daemon" }), null);
  assert.equal(calls.length, 2);
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.last_outcome, "transient_failure");
  assert.equal(s.last_error.kind, "activate");
  assert.equal(s.consecutive_failures, 1);
});

test("402 from /activate after a 410 is terminal (revoked)", async () => {
  withGh(true);
  responses = [respond(410, {}), respond(402, { error: "cancelled" })];
  await refreshLicense(DEVICE_ID, { source: "daemon" });
  assert.equal(licenseStatus.readLicenseStatus().terminal.reason, "revoked");
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

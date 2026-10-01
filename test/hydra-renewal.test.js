"use strict";

// ADR 005: a session with a broker refresh token renews through the refresh
// token grant and /activate pinned to its tenant, never through /refresh. The
// broker and the license server are a fetch stub; nothing reaches a network.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, setTestEnv, makeJwt, writeCredentials, readSession } = require("../testing/helpers");

const stateDir = makeTempDir("skm-hydra-renewal-");
setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("SKILLMETER_ACTIVATE_URL", "https://activation.test/activate");
setTestEnv("SKILLMETER_BROKER_URL", "https://id.test");
setTestEnv("SKILLMETER_BACKEND_URL", undefined);

const credstore = require("../skillmeter/scripts/credstore");
const licenseStatus = require("../skillmeter/scripts/lib/license-status");
const { refreshLicense, ensureFreshLicense } = require("../skillmeter/scripts/lib/license-activation");
const { LOG_DIR } = require("../skillmeter/scripts/lib/paths");

const DEVICE_ID = "11111111-2222-4333-8444-555555555555";
const LOCK_FILE = path.join(LOG_DIR, ".license-refresh.lock");
const REFRESH_TOKEN = "ory_rt_fixture-original";

function license(expiresInSec, slug = "acme") {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    sub: "tenant-uuid",
    broker_sub: "broker-user",
    org: { login: slug },
    orgs: ["acme-gh"],
    aud: `https://${slug}.meter.skillbench.example`,
  });
}

function signedIn({ refreshToken = REFRESH_TOKEN, jwt = license(-60) } = {}) {
  const fields = { device_id: DEVICE_ID, hash_salt: "0123456789abcdef0123456789abcdef", license_jwt: jwt };
  if (refreshToken) fields.refresh_token = refreshToken;
  writeCredentials(stateDir, fields);
}

// fetch stub: a queue of responses keyed by what they answer, and every call.
const calls = [];
let responses = [];
function respond(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  };
}
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const call = { url: String(url), opts };
  if (opts?.headers?.["Content-Type"] === "application/x-www-form-urlencoded") {
    call.form = Object.fromEntries(new URLSearchParams(opts.body));
  } else if (opts?.body) {
    call.json = JSON.parse(opts.body);
  }
  calls.push(call);
  if (responses.length === 0) throw new Error(`unexpected fetch ${url}`);
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return next;
};
process.on("exit", () => { global.fetch = realFetch; });

// Every refresh token that passes through, so the log check below can look
// for all of them.
const SECRETS = [REFRESH_TOKEN, "ory_rt_fixture-rotated", "ory_rt_fixture-second"];
const logged = [];
const realError = console.error;
console.error = (...args) => { logged.push(args.join(" ")); };
process.on("exit", () => { console.error = realError; });

beforeEach(() => {
  calls.length = 0;
  responses = [];
  logged.length = 0;
  signedIn();
  licenseStatus.clearLicenseStatus({ source: "test" });
  try { fs.unlinkSync(LOCK_FILE); } catch {}
});

const TOKEN_URL = "https://id.test/oauth2/token";
const REVOKE_URL = "https://id.test/oauth2/revoke";
const ACTIVATE_URL = "https://activation.test/activate";

test("renewal: refresh token grant, then /activate pinned to the tenant; the rotated token and the license are stored", async () => {
  const fresh = license(900);
  responses = [
    respond(200, { id_token: "id-token-1", refresh_token: "ory_rt_fixture-rotated", access_token: "opaque" }),
    respond(200, { token: fresh }),
  ];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), fresh);

  assert.deepEqual(calls.map((c) => c.url), [TOKEN_URL, ACTIVATE_URL], "never /refresh");
  assert.equal(calls[0].form.grant_type, "refresh_token");
  assert.equal(calls[0].form.refresh_token, REFRESH_TOKEN);
  assert.equal(calls[1].opts.headers.Authorization, "Bearer id-token-1");
  assert.deepEqual(calls[1].json, { device_id: DEVICE_ID, org: "acme" });

  const session = readSession(stateDir);
  assert.equal(session.refresh_token, "ory_rt_fixture-rotated");
  assert.equal(session.license_jwt, fresh);
  assert.equal(licenseStatus.readLicenseStatus().last_outcome, "rotated");
});

test("a rotated refresh token is kept even when the exchange after it fails, and the next renewal uses it", async () => {
  responses = [
    respond(200, { id_token: "id-token-1", refresh_token: "ory_rt_fixture-rotated" }),
    respond(503, "unavailable"),
  ];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), null);
  assert.equal(readSession(stateDir).refresh_token, "ory_rt_fixture-rotated");
  assert.equal(licenseStatus.readLicenseStatus().last_outcome, "transient_failure");

  const fresh = license(900);
  responses = [
    respond(200, { id_token: "id-token-2", refresh_token: "ory_rt_fixture-second" }),
    respond(200, { token: fresh }),
  ];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), fresh);
  assert.equal(calls[2].form.refresh_token, "ory_rt_fixture-rotated");
});

test("invalid_grant ends the session: terminal, no /activate, and no fallback to /refresh", async () => {
  responses = [respond(400, { error: "invalid_grant", error_description: "token revoked" })];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), null);
  assert.deepEqual(calls.map((c) => c.url), [TOKEN_URL]);
  const status = licenseStatus.readLicenseStatus();
  assert.equal(status.terminal.reason, licenseStatus.TERMINAL_REASONS.REACTIVATION_REQUIRED);
  // Later drains do not retry until a sign-in.
  assert.equal(await ensureFreshLicense(DEVICE_ID, { source: "drain" }), credstore.getLicenseToken());
  assert.equal(calls.length, 1);
});

for (const [label, status] of [["402 (license cancelled, or no workspace left)", 402], ["404 for the pinned tenant (left or removed)", 404]]) {
  test(`/activate ${label} drops the session, stops recording and revokes at the broker`, async () => {
    responses = [
      respond(200, { id_token: "id-token-1", refresh_token: "ory_rt_fixture-rotated" }),
      respond(status, { error: "x", code: status === 402 ? "revoked" : "workspace_not_found" }),
      respond(200, ""),
    ];
    assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), null);
    assert.equal(credstore.isSignedIn(), false);
    assert.equal(credstore.getSignedOut(), false, "not a sign-out");
    const session = readSession(stateDir);
    assert.equal(session.license_jwt, undefined);
    assert.equal(session.refresh_token, undefined);
    assert.equal(licenseStatus.readLicenseStatus().terminal.reason, licenseStatus.TERMINAL_REASONS.REVOKED);
    assert.equal(calls[2].url, REVOKE_URL);
    assert.equal(calls[2].form.token, "ory_rt_fixture-rotated", "the live token, not the spent one");
  });
}

for (const [label, response] of [
  ["a network error", new Error("ECONNRESET")],
  ["a broker 5xx", respond(502, "bad gateway")],
  ["a response without an id_token", respond(200, { access_token: "opaque" })],
]) {
  test(`${label} at the broker is transient and keeps the session`, async () => {
    responses = [response];
    assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), null);
    assert.equal(readSession(stateDir).refresh_token, REFRESH_TOKEN);
    assert.equal(licenseStatus.readLicenseStatus().last_outcome, "transient_failure");
    assert.equal(licenseStatus.readLicenseStatus().terminal, null);
  });
}

test("a 401 from /activate after a fresh broker token is transient, not the end of the session", async () => {
  responses = [respond(200, { id_token: "id-token-1" }), respond(401, { error: "invalid broker token" })];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), null);
  assert.equal(licenseStatus.readLicenseStatus().terminal, null);
  assert.equal(readSession(stateDir).refresh_token, REFRESH_TOKEN, "the broker did not rotate, so the token is unchanged");
});

test("a session without a refresh token still renews through /refresh", async () => {
  signedIn({ refreshToken: null });
  const fresh = license(900);
  responses = [respond(200, { token: fresh })];
  assert.equal(await refreshLicense(DEVICE_ID, { source: "drain" }), fresh);
  assert.deepEqual(calls.map((c) => c.url), ["https://activation.test/refresh"]);
});

test("concurrent drains renew once", async () => {
  const fresh = license(900);
  responses = [
    respond(200, { id_token: "id-token-1", refresh_token: "ory_rt_fixture-rotated" }),
    respond(200, { token: fresh }),
  ];
  const [a, b] = await Promise.all([
    ensureFreshLicense(DEVICE_ID, { source: "drain" }),
    ensureFreshLicense(DEVICE_ID, { source: "drain" }),
  ]);
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
  assert.ok([a, b].includes(fresh));
});

test("a sign-in stores the refresh token with the license, and one without clears an older one", () => {
  const generation = credstore.markEngaged();
  const expected = { generation, deviceId: DEVICE_ID };
  assert.equal(credstore.commitSignin({ jwt: license(900), refreshToken: "ory_rt_fixture-second", expected }), true);
  assert.equal(readSession(stateDir).refresh_token, "ory_rt_fixture-second");
  assert.equal(credstore.commitSignin({ jwt: license(900) }), true);
  assert.equal(readSession(stateDir).refresh_token, undefined);
});

test("no refresh token ever reaches a log line", async () => {
  responses = [
    respond(200, { id_token: "id-token-1", refresh_token: "ory_rt_fixture-rotated" }),
    respond(500, "internal error"),
  ];
  await refreshLicense(DEVICE_ID, { source: "drain" });
  responses = [respond(400, { error: "invalid_grant" })];
  await refreshLicense(DEVICE_ID, { source: "drain", force: true });
  assert.ok(logged.length > 0);
  for (const line of logged) {
    for (const secret of SECRETS) assert.ok(!line.includes(secret), `leaked in: ${line}`);
  }
});

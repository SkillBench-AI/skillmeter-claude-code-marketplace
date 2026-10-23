"use strict";
// The bin/ entry points against isolated homes. Network sign-in is not exercised.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PLUGIN_ROOT, tempDir, writeCredentials, makeJwt, license, sessionFileIn, consentPolicyFileIn } = require("../../test-support/plugin.cjs");

function home(credentials) {
  const dir = tempDir("sk-bin-home");
  writeCredentials(dir, credentials);
  return dir;
}
// The broker points at a closed loopback port: sign-out's revoke fails fast
// instead of reaching the real sign-in service.
function run(tool, args, dir) {
  return spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "bin", tool), ...args], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, PLUGIN_DATA: path.join(dir, "data"),
      SKILLMETER_STATE_DIR: "", SKILLMETER_BROKER_URL: "http://127.0.0.1:9" },
  });
}
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const readCredentials = dir => readJson(path.join(dir, ".skillbench", "credentials.json"));
const readSession = dir => readJson(sessionFileIn(path.join(dir, ".skillbench")));
const readPolicy = dir => readJson(consentPolicyFileIn(path.join(dir, ".skillbench")));
const now = () => Math.floor(Date.now() / 1000);

test("sk-jwt reports no stored license when unauthenticated", () => {
  const result = run("sk-jwt", [], home({ device_id: "DEV-1", hash_salt: "abcd" }));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no license JWT stored/i);
  assert.match(result.stdout, /DEV-1/);
});

test("sk-jwt renders claims for a valid token without leaking the raw token", () => {
  const jwt = license({ sub: "tenant-1", broker_sub: "person-9", org: { login: "acme" }, orgs: ["acme", "beta"],
    aud: "https://acme.meter.skillbench.com", iat: now(), exp: now() + 3600 });
  const result = run("sk-jwt", [], home({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: jwt }));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Tenant \(sub\)\s+tenant-1/);
  assert.match(result.stdout, /Workspace\s+acme/);
  assert.match(result.stdout, /User \(broker_sub\)\s+person-9/);
  assert.match(result.stdout, /GitHub orgs\s+acme, beta/);
  assert.match(result.stdout, /Telemetry endpoint\s+https:\/\/acme\.meter\.skillbench\.com/);
  assert.match(result.stdout, /Status\s+valid/);
  assert.equal(result.stdout.includes(jwt), false, "raw JWT must not be printed");
});

test("sk-jwt flags an expired token", () => {
  const jwt = makeJwt({ sub: "u", aud: "https://x.meter.skillbench.com", exp: now() - 3600 });
  assert.match(run("sk-jwt", [], home({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: jwt })).stdout, /EXPIRED/i);
});

// The pause is in Codex's consent record and covers only Codex.
test("sk-telemetry disable --global pauses through the Codex consent record and enable --global resumes", () => {
  const dir = home({ device_id: "DEV-1", hash_salt: "abcd" });
  assert.equal(run("sk-telemetry", ["disable", "--global"], dir).status, 0);
  assert.equal(readPolicy(dir).global.enabled, false);
  assert.equal("telemetry_disabled" in readCredentials(dir), false);
  assert.equal(run("sk-telemetry", ["enable", "--global"], dir).status, 0);
  assert.equal(readPolicy(dir).global.enabled, true);
});

test("signout ends this client's session, keeps the device identity and pauses nothing globally", () => {
  const dir = home({ device_id: "DEV-1", hash_salt: "abcd", license_jwt: license(), refresh_token: "synthetic-refresh" });
  const result = run("signout", [], dir);
  assert.equal(result.status, 0, result.stderr);
  const session = readSession(dir);
  assert.equal(session.license_jwt, undefined);
  assert.equal(session.refresh_token, undefined);
  assert.equal(session.signed_out, true);
  assert.deepEqual(readCredentials(dir), { device_id: "DEV-1", hash_salt: "abcd" });
  assert.equal(fs.existsSync(consentPolicyFileIn(path.join(dir, ".skillbench"))), false, "not a global pause");
  assert.equal(fs.existsSync(path.join(dir, ".skillbench", "telemetry-policy.json")), false, "no machine-wide record");
  assert.equal((result.stdout + result.stderr).includes("synthetic-refresh"), false, "the refresh token is never printed");
});

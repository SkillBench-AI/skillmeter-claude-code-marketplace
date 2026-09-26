"use strict";

// ADR 005: the session (license, sign-in intent, sign-out) is this client's
// alone; the shared credentials.json keeps the device identity and other
// clients' fields. Sign-in intents are still bound to their generation.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir, setTestEnv, writeJson, writeCredentials, sessionPath } = require("../testing/helpers");
const state = makeTempDir("credential-generation-");
setTestEnv("SKILLMETER_STATE_DIR", state);
const store = require("../skillmeter/scripts/credstore");
const status = require("../skillmeter/scripts/lib/license-status");
const shared = path.join(state, "credentials.json");
const session = sessionPath(state);
const original = { device_id: "fixture-device", hash_salt: "fixture-salt", license_jwt: "fixture-token",
  future: { preserved: true }, telemetry_disabled: true, allowed_github_orgs: ["fixture"] };
beforeEach(() => { writeCredentials(state, original); status.clearLicenseStatus(); });

test("sign-in intent rejects sign-out/reengagement even when token is reused", () => {
  const generation = store.markEngaged();
  const expected = { generation, deviceId: original.device_id };
  store.signOut(); store.markEngaged();
  store.commitSignin({ jwt: original.license_jwt });
  const before = fs.readFileSync(session);
  assert.equal(store.commitSignin({ jwt: "late-issuance", expected }), false);
  assert.deepEqual(fs.readFileSync(session), before);
});

test("same-intent refresh does not cancel browser issuance, a device change does", () => {
  store.markEngaged();
  const expected = store.recoverySnapshot();
  assert.equal(store.commitRefresh("rotated", expected), true);
  assert.equal(store.commitSignin({ jwt: "browser", expected }), true);
  const next = store.recoverySnapshot();
  writeJson(shared, { ...JSON.parse(fs.readFileSync(shared)), device_id: "other-device" });
  assert.equal(store.commitSignin({ jwt: "late", expected: next }), false);
  assert.equal(store.commitRefresh("late", next), false);
});

test("the auth lifecycle never writes the shared store", () => {
  const before = fs.readFileSync(shared);
  store.signOut(); store.markEngaged(); store.commitSignin({ jwt: "next" });
  const generation = JSON.parse(fs.readFileSync(session)).auth_generation;
  assert.equal(store.commitRefresh("refreshed", store.recoverySnapshot()), true);
  assert.equal(JSON.parse(fs.readFileSync(session)).auth_generation, generation, "refresh keeps the intent");
  assert.deepEqual(fs.readFileSync(shared), before, "identity and other clients' fields untouched");
  assert.equal(store.getDeviceId(), original.device_id);
  assert.equal(store.getHashSalt(), original.hash_salt);
});

test("another client's session fields in the shared store never reach this session", () => {
  // What the Codex plugin or the VS Code extension may write there.
  writeJson(shared, { ...JSON.parse(fs.readFileSync(shared)), license_jwt: "codex-token", signed_out: true });
  assert.equal(store.getLicenseToken(), "fixture-token");
  assert.equal(store.isSignedIn(), true);
  store.signOut();
  assert.equal(JSON.parse(fs.readFileSync(shared)).license_jwt, "codex-token", "their license is theirs");
  writeJson(shared, { device_id: original.device_id, hash_salt: original.hash_salt, license_jwt: "vscode-token" });
  assert.equal(store.isSignedIn(), false, "their sign-in does not sign this client in");
});

test("first read without a session copies it from the shared store once, and leaves that store as it is", () => {
  fs.rmSync(session);
  writeJson(shared, { ...original, signed_out: true, auth_generation: "old-intent" });
  const before = fs.readFileSync(shared);
  assert.equal(store.getSignedOut(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(session)),
    { license_jwt: "fixture-token", signed_out: true, auth_generation: "old-intent" });
  assert.deepEqual(fs.readFileSync(shared), before);
  writeJson(shared, { ...original, license_jwt: "later-shared-token" });
  store.markEngaged();
  assert.equal(store.getLicenseToken(), "fixture-token", "copied once, not followed");
});

test("terminal status from a previous authentication context cannot block a new token", () => {
  status.recordTerminal({ reason: "revoked", status: 402 });
  assert.ok(status.readLicenseStatus().terminal);
  // A sign-in that did not go through clearLicenseStatus still changes the context.
  store.commitSignin({ jwt: "new-signin" });
  assert.equal(status.readLicenseStatus().terminal, null);
  status.recordRefreshFailure({ status: 500 });
  assert.equal(status.readLicenseStatus().consecutive_failures, 1);
});

test("busy session lock fails closed without modifying the session", () => {
  const { acquireLock } = require("../skillmeter/scripts/lib/credential-lock");
  const release = acquireLock(`${session}.lock`);
  const before = fs.readFileSync(session);
  try { assert.throws(() => store.signOut(), /credential-store-busy/); }
  finally { release(); }
  assert.deepEqual(fs.readFileSync(session), before);
});

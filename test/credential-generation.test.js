"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir, setTestEnv, writeJson } = require("../testing/helpers");
const state = makeTempDir("credential-generation-");
setTestEnv("SKILLMETER_STATE_DIR", state);
const store = require("../skillmeter/scripts/credstore");
const status = require("../skillmeter/scripts/lib/license-status");
const file = path.join(state, "credentials.json");
const original = { device_id: "fixture-device", hash_salt: "fixture-salt", license_jwt: "fixture-token",
  future: { preserved: true }, telemetry_disabled: true, allowed_github_orgs: ["fixture"] };
beforeEach(() => { writeJson(file, original); status.clearLicenseStatus(); });

test("sign-in intent rejects sign-out/reengagement even when token is reused", () => {
  const generation = store.markEngaged();
  const expected = { generation, deviceId: original.device_id };
  store.signOut(); store.markEngaged();
  store.commitSignin({ jwt: original.license_jwt });
  const before = fs.readFileSync(file);
  assert.equal(store.commitSignin({ jwt: "late-issuance", expected }), false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("same-intent refresh does not cancel browser issuance, a device change does", () => {
  store.markEngaged();
  const expected = store.recoverySnapshot();
  assert.equal(store.commitRefresh("rotated", expected), true);
  assert.equal(store.commitSignin({ jwt: "browser", expected }), true);
  const next = store.recoverySnapshot();
  writeJson(file, { ...JSON.parse(fs.readFileSync(file)), device_id: "other-device" });
  assert.equal(store.commitSignin({ jwt: "late", expected: next }), false);
  assert.equal(store.commitRefresh("late", next), false);
});

test("auth lifecycle preserves identity, unknown fields, and separate consent flags", () => {
  store.signOut(); store.markEngaged(); store.commitSignin({ jwt: "next" });
  const next = JSON.parse(fs.readFileSync(file));
  for (const key of ["device_id", "hash_salt", "future", "telemetry_disabled", "allowed_github_orgs"]) {
    assert.deepEqual(next[key], original[key]);
  }
  assert.equal(store.commitRefresh("refreshed", store.recoverySnapshot()), true);
  assert.equal(JSON.parse(fs.readFileSync(file)).auth_generation, next.auth_generation);
});

test("terminal status from a previous authentication context cannot block a new token", () => {
  status.recordTerminal({ reason: "revoked", status: 402 });
  assert.ok(status.readLicenseStatus().terminal);
  // Simulate the other client changing credentials without clearing Claude status.
  store.commitSignin({ jwt: "other-client-signin" });
  assert.equal(status.readLicenseStatus().terminal, null);
  status.recordRefreshFailure({ status: 500 });
  assert.equal(status.readLicenseStatus().consecutive_failures, 1);
});

test("busy credential lock fails closed without modifying stored identity", () => {
  const { acquireLock } = require("../skillmeter/scripts/lib/credential-lock");
  const release = acquireLock(`${file}.lock`);
  const before = fs.readFileSync(file);
  try { assert.throws(() => store.signOut(), /credential-store-busy/); }
  finally { release(); }
  assert.deepEqual(fs.readFileSync(file), before);
});

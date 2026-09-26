"use strict";

// A credential store that cannot be read is never silently replaced: a corrupt
// one is kept aside (with a notice) before it is reset, and an unreadable one
// is left alone.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, setTestEnv } = require("../testing/helpers");

const stateDir = makeTempDir("skm-cred-integrity-");
setTestEnv("SKILLMETER_STATE_DIR", stateDir);

const credstore = require("../skillmeter/scripts/credstore");

const CRED_FILE = path.join(stateDir, "credentials.json");

function asideFiles() {
  return fs.readdirSync(stateDir).filter((name) => name.startsWith("credentials.json.corrupt-"));
}

// Capture what the store says on stderr while fn runs.
function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try { fn(); } finally { console.error = original; }
  return lines.join("\n");
}

beforeEach(() => {
  for (const name of fs.readdirSync(stateDir)) {
    const file = path.join(stateDir, name);
    try { fs.chmodSync(file, 0o600); } catch {}
    fs.rmSync(file, { force: true, recursive: true });
  }
});

test("a truncated store is kept aside, reported, and then reset", () => {
  const original = '{"device_id":"ORIG-DEVICE","hash_salt":"abc","license_jwt":"x.y';
  fs.writeFileSync(CRED_FILE, original, { mode: 0o600 });

  let deviceId;
  const stderr = captureStderr(() => { deviceId = credstore.getDeviceId(); });

  assert.ok(deviceId, "a new identity is created");
  assert.notEqual(deviceId, "ORIG-DEVICE");
  assert.match(stderr, /Credential store was unreadable/);
  assert.match(stderr, /\/skillmeter:signin/);
  const aside = asideFiles();
  assert.equal(aside.length, 1, "the original bytes are kept");
  assert.equal(fs.readFileSync(path.join(stateDir, aside[0]), "utf8"), original);
  assert.equal((fs.statSync(path.join(stateDir, aside[0])).mode & 0o777), 0o600);
});

for (const root of ["null", "[]", '"text"']) {
  test(`a store whose root is ${root} reads as empty instead of crashing`, () => {
    fs.writeFileSync(CRED_FILE, root, { mode: 0o600 });
    assert.equal(credstore.getLicenseToken(), null);
    assert.equal(credstore.hasValidLicense(), false);
    captureStderr(() => credstore.getDeviceId());
    assert.equal(asideFiles().length, 1);
  });
}

test("a healthy store is not reported or copied", () => {
  fs.writeFileSync(CRED_FILE, JSON.stringify({ device_id: "ORIG-DEVICE" }), { mode: 0o600 });
  let deviceId;
  const stderr = captureStderr(() => { deviceId = credstore.getOrCreateHashSalt() && credstore.getDeviceId(); });
  assert.equal(deviceId, "ORIG-DEVICE");
  assert.doesNotMatch(stderr, /Credential store was unreadable/);
  assert.equal(asideFiles().length, 0);
});

test("an unreadable store is left intact rather than overwritten", { skip: process.getuid?.() === 0 && "root can read any file" }, () => {
  fs.writeFileSync(CRED_FILE, JSON.stringify({ device_id: "ORIG-DEVICE", license_jwt: "keep" }), { mode: 0o600 });
  fs.chmodSync(CRED_FILE, 0);
  try {
    assert.throws(() => credstore.getDeviceId(), /credential store unreadable/);
  } finally {
    fs.chmodSync(CRED_FILE, 0o600);
  }
  const kept = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  assert.equal(kept.device_id, "ORIG-DEVICE");
  assert.equal(kept.license_jwt, "keep");
});

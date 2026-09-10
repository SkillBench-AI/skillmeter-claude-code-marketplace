"use strict";

// Retry daemon scheduling: the drain backoff stays adaptive while the license
// refresh check runs every tick and respects the status record (ADR 001, D2).
// Run: node --test skillmeter/test/retry-daemon.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { makeTempDir, setTestEnv, makeJwt, writeJson } = require("../testing/helpers");

const stateDir = makeTempDir("skm-retry-daemon-");
setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("SKILLMETER_RETRY_DAEMON_INTERVAL_MS", "120000");
setTestEnv("SKILLMETER_BACKEND_URL", undefined);
setTestEnv("SKILLMETER_ACTIVATE_URL", "https://activation.test/activate");

const daemon = require("../scripts/monitors/retry_daemon");
const licenseStatus = require("../scripts/lib/license-status");

test("requiring the daemon module does not start the loop", () => {
  assert.equal(typeof daemon.nextDrainInterval, "function");
  assert.equal(typeof daemon.maybeRefreshLicense, "function");
});

test("nextDrainInterval doubles on no progress, caps, and resets on progress", () => {
  const base = 120_000;
  const cap = 30 * 60_000;
  assert.equal(daemon.nextDrainInterval(3, 3, base, base, cap), 2 * base);
  assert.equal(daemon.nextDrainInterval(3, 4, 2 * base, base, cap), 4 * base);
  assert.equal(daemon.nextDrainInterval(3, 3, cap, base, cap), cap);
  assert.equal(daemon.nextDrainInterval(3, 2, 8 * base, base, cap), base);
  assert.equal(daemon.nextDrainInterval(0, 0, 8 * base, base, cap), base);
});

test("maybeRefreshLicense makes no network call while the record is terminal, and logs once", async () => {
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "11111111-2222-4333-8444-555555555555",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({ exp: Math.floor(Date.now() / 1000) - 60, aud: "https://x.meter.skillbench.ai" }),
  });
  licenseStatus.recordTerminal({ source: "daemon", reason: "gh_unauthenticated" });

  const realFetch = global.fetch;
  let fetched = 0;
  global.fetch = async () => { fetched++; throw new Error("must not be called"); };
  const lines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const state = {};
    await daemon.maybeRefreshLicense(state);
    await daemon.maybeRefreshLicense(state);
  } finally {
    process.stderr.write = realWrite;
    global.fetch = realFetch;
  }
  assert.equal(fetched, 0);
  const terminalLines = lines.filter((l) => l.includes("license refresh stopped"));
  assert.equal(terminalLines.length, 1, "terminal state is logged once, not every tick");
});

test("maybeRefreshLicense clears a stale terminal record once the token is valid again", async () => {
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "11111111-2222-4333-8444-555555555555",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, aud: "https://x.meter.skillbench.ai" }),
  });
  licenseStatus.recordTerminal({ source: "daemon", reason: "revoked", status: 402 });

  const realFetch = global.fetch;
  let fetched = 0;
  global.fetch = async () => { fetched++; throw new Error("must not be called"); };
  try {
    await daemon.maybeRefreshLicense({});
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(fetched, 0, "a fresh token needs no network call");
  const s = licenseStatus.readLicenseStatus();
  assert.equal(s.terminal, null, "stale terminal state is dropped");
  assert.equal(s.updated_by, "daemon");
});

test("maybeRefreshLicense renews a token that hooks still accept but that expires within one sweep", async () => {
  const fs = require("fs");
  const { LOG_DIR } = require("../scripts/lib/paths");
  try { fs.unlinkSync(path.join(LOG_DIR, ".license-refresh.lock")); } catch {}
  licenseStatus.clearLicenseStatus({ source: "test" });
  // Expires in 6 minutes: outside the hooks' 5-minute skew, inside the daemon's
  // 5 + 2 minute look-ahead, so the daemon must renew it on this tick.
  const soon = makeJwt({ exp: Math.floor(Date.now() / 1000) + 6 * 60, aud: "https://x.meter.skillbench.ai" });
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "11111111-2222-4333-8444-555555555555",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: soon,
  });
  const renewed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, aud: "https://x.meter.skillbench.ai" });
  const realFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ token: renewed }), text: async () => "" };
  };
  try {
    await daemon.maybeRefreshLicense({});
  } finally {
    global.fetch = realFetch;
  }
  assert.deepEqual(urls, ["https://activation.test/refresh"]);
  const store = JSON.parse(fs.readFileSync(path.join(stateDir, "credentials.json"), "utf8"));
  assert.equal(store.license_jwt, renewed, "token rotated ahead of the hooks' threshold");
});

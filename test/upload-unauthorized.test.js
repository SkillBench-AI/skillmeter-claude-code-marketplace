"use strict";

// A 401 from an upload means the server rejected a token that looked fresh
// here (a clock running ahead, a key rotation). The drain refreshes once,
// bypassing the local expiry check, and resends only the rejected files. The
// rejection is not the chunk's fault, so no retry budget is spent on it.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  makeJwt,
  makeTempDir,
  setTestEnv,
  writeJson,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-unauth-state-");
const DATA_DIR = makeTempDir("skm-unauth-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
setTestEnv("SKILLMETER_ACTIVATE_URL", "https://activation.test/activate");
setTestEnv("SKILLMETER_BACKEND_URL", "https://collector.skillbench.example");

const ORG = "skillbench-ai";
const REPO = { repoKey: `github.com/${ORG}/unauthorized`, org: ORG };

function license() {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    org: { login: ORG },
    aud: "https://acme.meter.skillbench.example",
    nonce: Math.random(),
  });
}

const store = require("../skillmeter/scripts/lib/telemetry-store");
const transfer = require("../skillmeter/scripts/lib/transfer");
const credstore = require("../skillmeter/scripts/credstore");
const licenseStatus = require("../skillmeter/scripts/lib/license-status");
const { REPOSITORIES_LOG_DIR, LOG_DIR } = require("../skillmeter/scripts/lib/paths");

const realFetch = global.fetch;
process.on("exit", () => { global.fetch = realFetch; });

let calls;
beforeEach(() => {
  writeJson(path.join(STATE_DIR, "credentials.json"), {
    device_id: "UNAUTH-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: license(),
  });
  writeTelemetryPolicy(STATE_DIR, { orgs: { [ORG]: true }, repositories: { [REPO.repoKey]: true } });
  licenseStatus.clearLicenseStatus({ source: "test" });
  fs.rmSync(REPOSITORIES_LOG_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(LOG_DIR, ".license-refresh.lock"), { force: true });
  calls = [];
});

// Transcript POSTs answer from `uploads`; /refresh mints a new token.
function stubFetch(uploads) {
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/refresh")) {
      return { ok: true, status: 200, json: async () => ({ token: license() }), text: async () => "" };
    }
    const status = uploads.shift() ?? 500;
    return { ok: status < 300, status, text: async () => "", json: async () => ({}) };
  };
}

function sealOne() {
  return transfer.sealDeltaChunk(
    "unauthorized.jsonl",
    [JSON.stringify({ uuid: "u-1" })],
    { seq: 1, reset: false, resetBaselineSeq: null, promptId: "live" },
    REPO
  );
}

test("a 401 refreshes once and resends the chunk", async () => {
  store.setRepositoryOverride(REPO.repoKey, true);
  const body = sealOne();
  const before = credstore.getLicenseTokenUncached();
  stubFetch([401, 202]);

  const result = await transfer.drainDeltaChunks(100);

  assert.equal(result.ok, 1, "sent on the retry");
  assert.equal(fs.existsSync(body), false);
  assert.equal(calls.filter((u) => u.endsWith("/refresh")).length, 1, "one refresh");
  assert.notEqual(credstore.getLicenseTokenUncached(), before, "the new token is stored");
});

test("a 401 that persists keeps the chunk without spending its retry budget", async () => {
  store.setRepositoryOverride(REPO.repoKey, true);
  const body = sealOne();
  stubFetch([401, 401]);

  const result = await transfer.drainDeltaChunks(100);

  assert.equal(result.ok, 0);
  assert.equal(fs.existsSync(body), true, "kept for the next drain");
  const meta = JSON.parse(fs.readFileSync(body.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  assert.ok(!meta.uploadAttempts, "no retry budget spent on a rejected token");
  assert.equal(calls.filter((u) => u.endsWith("/refresh")).length, 1, "still only one refresh");
});

test("other failures still spend the retry budget and trigger no refresh", async () => {
  store.setRepositoryOverride(REPO.repoKey, true);
  const body = sealOne();
  stubFetch([500]);

  await transfer.drainDeltaChunks(100);

  const meta = JSON.parse(fs.readFileSync(body.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  assert.equal(meta.uploadAttempts, 1);
  assert.equal(calls.filter((u) => u.endsWith("/refresh")).length, 0);
});

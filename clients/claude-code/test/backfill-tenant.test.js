"use strict";

// Historical chunks belong to the tenant their offer was accepted under. A
// later sign-in to another tenant, even one whose license lists the same
// GitHub org, must never receive them.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test, beforeEach } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  setTestEnv,
  writeJson,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-bf-tenant-state-");
const DATA_DIR = makeTempDir("skm-bf-tenant-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
// Uploads go to the stubbed fetch below, never to an ambient endpoint.
setTestEnv("SKILLMETER_BACKEND_URL", "https://collector.skillbench.example");

const ORG = "skillbench-ai";
const REPO = { repoKey: "github.com/skillbench-ai/tenant", org: ORG };
writeJson(path.join(STATE_DIR, "credentials.json"), {
  device_id: "BF-TENANT-DEVICE",
  hash_salt: "0123456789abcdef0123456789abcdef",
});
writeTelemetryPolicy(STATE_DIR, { orgs: { [ORG]: true } });

const { SESSION_FILE } = require("../skillmeter/scripts/credstore");

// The license lives in this client's session (ADR 005), so a sign-in to
// another tenant replaces it there.
function signIn(audience) {
  writeJson(SESSION_FILE, {
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: ORG },
      orgs: [ORG],
      aud: audience,
    }),
  });
}

function signOut() {
  writeJson(SESSION_FILE, { signed_out: true });
}

signIn("https://dev.meter.skillbench.example");

const backfillState = require("../skillmeter/scripts/lib/backfill-state");
const transfer = require("../skillmeter/scripts/lib/transfer");
const { currentTenantFingerprint } = require("../skillmeter/scripts/lib/tenant");
const { REPOSITORIES_LOG_DIR } = require("../skillmeter/scripts/lib/paths");

const realFetch = global.fetch;
process.on("exit", () => { global.fetch = realFetch; });

let sent;
beforeEach(() => {
  fs.rmSync(backfillState.BACKFILL_STATE_FILE, { force: true });
  fs.rmSync(REPOSITORIES_LOG_DIR, { recursive: true, force: true });
  signIn("https://dev.meter.skillbench.example");
  sent = [];
  global.fetch = async (url) => {
    sent.push(url);
    return { ok: true, status: 202, text: async () => "" };
  };
});

function acceptOffer(tenantFingerprint = currentTenantFingerprint()) {
  backfillState.initializeBackfillLifecycle();
  const { state } = backfillState.claimBackfillOffer("", { manual: true });
  const begun = backfillState.beginBackfill(state.offer_id, {
    org: ORG,
    repositoryIds: ["aaaaaaaaaaaa"],
    repositoryKeys: [REPO.repoKey],
    tenantFingerprint,
  });
  assert.equal(begun.started, true);
  return state.offer_id;
}

function sealHistorical(offerId, name = "history") {
  const body = transfer.sealDeltaChunk(
    `${name}.jsonl`,
    [JSON.stringify({ uuid: `${name}-1` })],
    { seq: 1, reset: false, resetBaselineSeq: null, promptId: "backfill", backfillOfferId: offerId },
    REPO
  );
  assert.ok(body);
  return body;
}

test("an offer cannot start without the tenant it is accepted under", () => {
  backfillState.initializeBackfillLifecycle();
  const { state } = backfillState.claimBackfillOffer("", { manual: true });
  const begun = backfillState.beginBackfill(state.offer_id, {
    org: ORG,
    repositoryIds: ["aaaaaaaaaaaa"],
    repositoryKeys: [REPO.repoKey],
  });
  assert.equal(begun.started, false);
  assert.equal(backfillState.readBackfillState().upload_authorized, false);
});

test("history is uploaded to the tenant that accepted it", async () => {
  sealHistorical(acceptOffer());
  const result = await transfer.drainDeltaChunks(10);
  assert.equal(result.ok, 1);
  assert.equal(sent.length, 1);
});

test("history is never sent to another tenant that lists the same org", async () => {
  const body = sealHistorical(acceptOffer());
  signOut();
  signIn("https://prod.meter.skillbench.example");

  await transfer.drainDeltaChunks(10);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(body), false);
});

test("history waits while signed out and resumes for the same tenant", async () => {
  const body = sealHistorical(acceptOffer());
  signOut();
  await transfer.drainDeltaChunks(10);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(body), true);

  signIn("https://dev.meter.skillbench.example");
  const result = await transfer.drainDeltaChunks(10);
  assert.equal(result.ok, 1);
  assert.equal(sent.length, 1);
});

test("a kept earlier offer stays bound to its own tenant", async () => {
  const first = acceptOffer();
  backfillState.finishBackfill(first, "failed", { error: "retry" });
  backfillState.claimBackfillOffer("", { manual: true });
  assert.equal(backfillState.backfillOfferTenant(first), currentTenantFingerprint());

  const body = sealHistorical(first);
  signIn("https://prod.meter.skillbench.example");
  await transfer.drainDeltaChunks(10);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(body), false);
});

test("an offer accepted before tenants were recorded is not sent", async () => {
  const offerId = acceptOffer();
  const state = backfillState.readBackfillState();
  delete state.tenant_fingerprint;
  writeJson(backfillState.BACKFILL_STATE_FILE, state);

  const body = sealHistorical(offerId);
  await transfer.drainDeltaChunks(10);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(body), false);
});

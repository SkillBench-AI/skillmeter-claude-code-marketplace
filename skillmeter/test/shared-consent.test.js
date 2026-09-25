"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  readJson,
  runNode,
  setTestEnv,
  writeFile,
  writeJson,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-shared-consent-state-");
const DATA_DIR = makeTempDir("skm-shared-consent-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);

const HASH_SALT = "0123456789abcdef0123456789abcdef";
const LICENSE = makeJwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  org: { login: "skillbench-ai" },
  aud: "https://example.test",
});
writeJson(path.join(STATE_DIR, "credentials.json"), {
  device_id: "SHARED-CONSENT-DEVICE",
  hash_salt: HASH_SALT,
  license_jwt: LICENSE,
});
// The helper writes organizations at consent_version 1 and repositories with
// no version at all: both are legacy choices under ADR 004.
writeTelemetryPolicy(STATE_DIR, {
  orgs: { "skillbench-ai": true },
  repositories: { "github.com/skillbench-ai/legacy": true },
});

const store = require("../scripts/lib/telemetry-store");
const transfer = require("../scripts/lib/transfer");
const repositoryQueue = require("../scripts/lib/repository-queue");
const auditQueue = require("../scripts/lib/organization-audit-queue");
const { resolveTelemetryGate } = require("../scripts/lib/telemetry-policy");

const REPOSITORY_TELEMETRY_SCRIPT = path.resolve(
  __dirname,
  "../scripts/repository_telemetry.js"
);
const POLICY_FILE = path.join(STATE_DIR, "telemetry-policy.json");

function silentFetch(t) {
  const previousFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => {
    fetches++;
    return { ok: true };
  };
  t.after(() => { global.fetch = previousFetch; });
  return () => fetches;
}

test("legacy ON choices are reported and stamped once by acknowledgement", () => {
  const legacy = store.legacyConsentRecords();
  assert.deepEqual(legacy, {
    organizations: ["skillbench-ai"],
    repositories: ["github.com/skillbench-ai/legacy"],
  });
  assert.equal(store.acknowledgementRequired(), true);

  const revision = store.getPolicyRevision();
  const result = store.acknowledgeConsentStatement(revision);
  assert.equal(result.acknowledged, 2);
  assert.equal(result.revision, revision + 1);
  assert.equal(store.acknowledgementRequired(), false);

  const policy = readJson(POLICY_FILE);
  assert.equal(policy.organizations["skillbench-ai"].consent_version, store.CONSENT_VERSION);
  assert.equal(policy.organizations["skillbench-ai"].enabled, true);
  assert.equal(policy.repositories["github.com/skillbench-ai/legacy"].consent_version, store.CONSENT_VERSION);
  assert.ok(policy.repositories["github.com/skillbench-ai/legacy"].acknowledged_at > 0);
  assert.equal(fs.existsSync(store.OBSERVED_FILE), true);
});

test("new choices record the current consent statement version", () => {
  store.setRepositoryOverride("github.com/skillbench-ai/fresh", true);
  store.setOrganizationConsent("skillbench-ai", false);
  const policy = readJson(POLICY_FILE);
  assert.equal(policy.repositories["github.com/skillbench-ai/fresh"].consent_version, 2);
  assert.equal(policy.organizations["skillbench-ai"].consent_version, 2);
  assert.equal(policy.organizations["skillbench-ai"].enabled, false);
  store.setOrganizationConsent("skillbench-ai", true);
  assert.equal(store.acknowledgementRequired(), false);
});

test("an explicit repository OFF purges during the global pause; an unset choice holds", async (t) => {
  const offKey = "github.com/skillbench-ai/off-under-pause";
  const unsetKey = "github.com/skillbench-ai/unset-under-pause";
  store.setRepositoryOverride(offKey, true);
  const offBody = transfer.sealDeltaChunk(
    "off.jsonl",
    [JSON.stringify({ uuid: "off-1" })],
    { seq: 1, reset: false, resetBaselineSeq: null },
    { repoKey: offKey, org: "skillbench-ai" }
  );
  const unsetBody = transfer.sealDeltaChunk(
    "unset.jsonl",
    [JSON.stringify({ uuid: "unset-1" })],
    { seq: 1, reset: false, resetBaselineSeq: null },
    { repoKey: unsetKey, org: "skillbench-ai" }
  );
  assert.ok(fs.existsSync(offBody) && fs.existsSync(unsetBody));

  store.setGlobalEnabled(false);
  t.after(() => store.setGlobalEnabled(true));
  const fetches = silentFetch(t);

  store.setRepositoryOverride(offKey, false);
  assert.equal(
    repositoryQueue.queueDisposition(repositoryQueue.queueContextForRepository(offKey, "skillbench-ai")),
    "delete"
  );
  assert.equal(
    repositoryQueue.queueDisposition(repositoryQueue.queueContextForRepository(unsetKey, "skillbench-ai")),
    "pause"
  );

  transfer.purgeDisallowedQueues();
  assert.equal(fs.existsSync(offBody), false);
  assert.equal(fs.existsSync(unsetBody), true);
  await transfer.drainDeltaChunks(10);
  assert.equal(fetches(), 0);
  assert.equal(fs.existsSync(unsetBody), true);
});

test("organization OFF purges audit queues before the global pause is considered", (t) => {
  const context = { tenantFingerprint: auditQueue.tenantFingerprint(LICENSE, HASH_SALT) };
  assert.equal(auditQueue.organizationAuditDisposition(context), "send");

  store.setGlobalEnabled(false);
  t.after(() => {
    store.setGlobalEnabled(true);
    store.setOrganizationConsent("skillbench-ai", true);
  });
  assert.equal(auditQueue.organizationAuditDisposition(context), "pause");

  store.setOrganizationConsent("skillbench-ai", false);
  assert.equal(auditQueue.organizationAuditDisposition(context), "delete");
});

test("a malformed policy file blocks capture and controls and keeps its bytes", () => {
  const original = fs.readFileSync(POLICY_FILE, "utf8");
  writeFile(POLICY_FILE, "{ this is not json");
  try {
    assert.equal(store.getPolicyBlockedReason(), "malformed");
    assert.equal(store.readPolicy().blocked, "malformed");
    assert.equal(store.getOrganizationConsent("skillbench-ai"), null);
    assert.deepEqual(
      resolveTelemetryGate({
        policyBlocked: store.getPolicyBlockedReason(),
        globalDisabled: false,
        hasValidLicense: true,
        repoOrgOwned: true,
        orgConsent: true,
        projectOptIn: true,
      }),
      { capture: false, mode: "policy_unreadable", reason: "malformed" }
    );
    assert.throws(
      () => store.setRepositoryOverride("github.com/skillbench-ai/blocked", true),
      (err) => err && err.code === "POLICY_BLOCKED"
    );
    assert.equal(
      repositoryQueue.queueDisposition(
        repositoryQueue.queueContextForRepository("github.com/skillbench-ai/legacy", "skillbench-ai")
      ),
      "pause"
    );
    assert.equal(fs.readFileSync(POLICY_FILE, "utf8"), "{ this is not json");
  } finally {
    writeFile(POLICY_FILE, original);
  }
  assert.equal(store.getPolicyBlockedReason(), null);
});

test("an unsupported schema version blocks without being rewritten", () => {
  const original = fs.readFileSync(POLICY_FILE, "utf8");
  const future = { ...JSON.parse(original), schema_version: 99, future_field: true };
  writeJson(POLICY_FILE, future);
  try {
    assert.equal(store.getPolicyBlockedReason(), "unsupported_schema");
    assert.throws(() => store.setGlobalEnabled(false), (err) => err?.code === "POLICY_BLOCKED");
    assert.deepEqual(readJson(POLICY_FILE), future);
  } finally {
    writeFile(POLICY_FILE, original);
  }
});

test("a policy file that disappears after observation holds until it is back", () => {
  const original = fs.readFileSync(POLICY_FILE, "utf8");
  assert.equal(store.getPolicyBlockedReason(), null);
  fs.unlinkSync(POLICY_FILE);
  try {
    assert.equal(store.getPolicyBlockedReason(), "missing_after_observation");
    assert.throws(
      () => store.setRepositoryOverride("github.com/skillbench-ai/gone", true),
      (err) => err?.code === "POLICY_BLOCKED"
    );
    assert.equal(fs.existsSync(POLICY_FILE), false, "controls never recreate a lost policy");
  } finally {
    writeFile(POLICY_FILE, original);
  }
  assert.equal(store.getPolicyBlockedReason(), null);
});

test("first use with no policy file is not a hold", () => {
  const freshState = makeTempDir("skm-first-use-state-");
  const freshData = makeTempDir("skm-first-use-data-");
  writeJson(path.join(freshState, "credentials.json"), {
    device_id: "FIRST-USE-DEVICE",
    hash_salt: HASH_SALT,
    license_jwt: LICENSE,
  });
  const result = runNode(REPOSITORY_TELEMETRY_SCRIPT, ["list"], {
    env: { SKILLMETER_STATE_DIR: freshState, CLAUDE_PLUGIN_DATA: freshData },
  });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.policyBlocked, null);
  assert.equal(state.acknowledgementRequired, false);
  assert.equal(typeof state.statement, "string");
  assert.equal(fs.existsSync(path.join(freshState, "telemetry-policy.json")), true);
});

test("the acknowledge command stamps legacy choices and rejects a stale revision", () => {
  writeTelemetryPolicy(STATE_DIR, {
    orgs: { "skillbench-ai": true },
    repositories: { "github.com/skillbench-ai/cli-legacy": true },
  });
  const list = runNode(REPOSITORY_TELEMETRY_SCRIPT, ["list"]);
  assert.equal(list.status, 0, list.stderr);
  const state = JSON.parse(list.stdout);
  assert.equal(state.acknowledgementRequired, true);

  const stale = runNode(REPOSITORY_TELEMETRY_SCRIPT, ["acknowledge", String(state.revision + 5)]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.deepEqual(JSON.parse(stale.stdout), { revision: state.revision, acknowledged: 0, stale: true });

  const ok = runNode(REPOSITORY_TELEMETRY_SCRIPT, ["acknowledge", String(state.revision)]);
  assert.equal(ok.status, 0, ok.stderr);
  const result = JSON.parse(ok.stdout);
  assert.equal(result.acknowledged, 2);
  assert.equal(result.stale, false);
  assert.equal(JSON.parse(runNode(REPOSITORY_TELEMETRY_SCRIPT, ["list"]).stdout).acknowledgementRequired, false);
});

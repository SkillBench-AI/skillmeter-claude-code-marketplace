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
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-policy-state-");
const DATA_DIR = makeTempDir("skm-policy-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);

writeJson(path.join(STATE_DIR, "credentials.json"), {
  device_id: "POLICY-TEST-DEVICE",
  hash_salt: "0123456789abcdef0123456789abcdef",
  license_jwt: makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    org: { login: "skillbench-ai" },
  }),
  org_telemetry_migration_version: 1,
  org_telemetry_consents: {
    "skillbench-ai": {
      enabled: true,
      policy_version: 1,
      source: "user",
    },
  },
});

const store = require("../scripts/lib/telemetry-store");
const transfer = require("../scripts/lib/transfer");
const settings = require("../scripts/lib/settings");

function makeSettingsRepo(name, settings) {
  const repo = makeTempDir(`skm-policy-${name}-`);
  writeJson(path.join(repo, ".claude", "settings.local.json"), settings);
  return repo;
}

test("an existing pre-consent license is imported as legacy org enabled", () => {
  const stateDir = makeTempDir("skm-policy-legacy-license-");
  writeJson(path.join(stateDir, "credentials.json"), {
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: "SkillBench-AI" },
    }),
  });
  const probe = [
    "const s=require('./skillmeter/scripts/lib/telemetry-store');",
    "process.stdout.write(JSON.stringify(s.readPolicy()));",
  ].join("");
  const result = runNode("-e", [probe], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, SKILLMETER_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const policy = JSON.parse(result.stdout);
  assert.equal(policy.organizations["skillbench-ai"].enabled, true);
  assert.equal(policy.organizations["skillbench-ai"].source, "legacy");
});

test("legacy migration removes only telemetry and preserves adjacent settings", () => {
  const repo = makeSettingsRepo("preserve", {
    permissions: { defaultMode: "acceptEdits" },
    skillmeter: {
      telemetry: false,
      activate_url: "https://example.invalid/activate",
    },
  });
  const repoKey = "github.com/skillbench-ai/preserve";

  const result = store.migrateLegacyRepositorySetting(repo, repoKey);
  assert.equal(result.migrated, true);
  assert.equal(result.cleaned, true);
  assert.equal(store.getRepositoryOverride(repoKey), false);
  assert.deepEqual(
    readJson(path.join(repo, ".claude", "settings.local.json")),
    {
      permissions: { defaultMode: "acceptEdits" },
      skillmeter: {
        activate_url: "https://example.invalid/activate",
      },
    }
  );
});

test("telemetry-only legacy settings file is deleted after import", () => {
  const repo = makeSettingsRepo("delete", {
    skillmeter: { telemetry: true },
  });
  const settingsPath = path.join(repo, ".claude", "settings.local.json");
  assert.equal(
    store.migrateLegacyRepositorySetting(
      repo,
      "github.com/skillbench-ai/delete"
    ).cleaned,
    true
  );
  assert.equal(fs.existsSync(settingsPath), false);
  assert.equal(fs.existsSync(path.dirname(settingsPath)), true);
});

test("legacy cleanup refuses a settings file changed after import read", () => {
  const repo = makeSettingsRepo("fingerprint", {
    skillmeter: { telemetry: true },
  });
  const snapshot = settings.getTelemetryOptInSnapshot(repo);
  writeJson(path.join(repo, ".claude", "settings.local.json"), {
    skillmeter: {
      telemetry: true,
      github_client_id: "new-concurrent-value",
    },
  });
  assert.equal(
    settings.removeTelemetryOptIn(
      repo,
      snapshot.value,
      snapshot.fingerprint
    ),
    false
  );
  assert.equal(
    readJson(path.join(repo, ".claude", "settings.local.json"))
      .skillmeter.github_client_id,
    "new-concurrent-value"
  );
});

test("legacy OFF wins across clones but never overrides a user decision", () => {
  const onClone = makeSettingsRepo("clone-on", {
    skillmeter: { telemetry: true },
  });
  const offClone = makeSettingsRepo("clone-off", {
    skillmeter: { telemetry: false },
  });
  const repoKey = "github.com/skillbench-ai/shared";

  store.migrateLegacyRepositorySetting(onClone, repoKey);
  store.migrateLegacyRepositorySetting(offClone, repoKey);
  assert.equal(store.getRepositoryOverride(repoKey), false);

  store.setRepositoryOverride(repoKey, true);
  const staleClone = makeSettingsRepo("clone-stale", {
    skillmeter: { telemetry: false },
  });
  store.migrateLegacyRepositorySetting(staleClone, repoKey);
  assert.equal(store.getRepositoryOverride(repoKey), true);
  assert.equal(
    fs.existsSync(path.join(staleClone, ".claude", "settings.local.json")),
    false
  );
});

test("stale policy revision is rejected without mutation", () => {
  const repoKey = "github.com/skillbench-ai/revision";
  const revision = store.getPolicyRevision();
  store.setRepositoryOverride(repoKey, true, revision);
  assert.throws(
    () => store.setRepositoryOverride(repoKey, false, revision),
    (err) => err && err.code === "STALE_POLICY"
  );
  assert.equal(store.getRepositoryOverride(repoKey), true);
});

test("repository OFF purges queued chunks before fetch", async (t) => {
  const repoKey = "github.com/skillbench-ai/purge";
  store.setRepositoryOverride(repoKey, true);
  const body = transfer.sealDeltaChunk(
    "purge.jsonl",
    [JSON.stringify({ uuid: "purge-1" })],
    { seq: 1, reset: false, resetBaselineSeq: null },
    { repoKey, org: "skillbench-ai" }
  );
  assert.ok(body && fs.existsSync(body));

  const previousFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => {
    fetches++;
    return { ok: true };
  };
  t.after(() => { global.fetch = previousFetch; });

  store.setRepositoryOverride(repoKey, false);
  await transfer.drainDeltaChunks(10);
  assert.equal(fetches, 0);
  assert.equal(fs.existsSync(body), false);
});

test("global OFF pauses queues without deleting them", async (t) => {
  const repoKey = "github.com/skillbench-ai/pause";
  store.setRepositoryOverride(repoKey, true);
  const body = transfer.sealDeltaChunk(
    "pause.jsonl",
    [JSON.stringify({ uuid: "pause-1" })],
    { seq: 1, reset: false, resetBaselineSeq: null },
    { repoKey, org: "skillbench-ai" }
  );
  assert.ok(body && fs.existsSync(body));

  const previousFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => {
    fetches++;
    return { ok: true };
  };
  t.after(() => { global.fetch = previousFetch; });

  store.setGlobalEnabled(false);
  await transfer.drainDeltaChunks(10);
  assert.equal(fetches, 0);
  assert.equal(fs.existsSync(body), true);
  store.setGlobalEnabled(true);
});

test("skipped periods advance a discard cursor without staging a chunk", () => {
  const repoKey = "github.com/skillbench-ai/discard";
  const transcript = path.join(
    makeTempDir("skm-policy-transcript-"),
    "discard.jsonl"
  );
  writeFile(
    transcript,
    [
      JSON.stringify({ type: "user", uuid: "u1" }),
      JSON.stringify({ type: "assistant", uuid: "u2" }),
      "",
    ].join("\n")
  );
  const repository = { repoKey, org: "skillbench-ai" };
  transfer.discardSkippedSessionArtifacts(
    { transcript_path: transcript },
    "POLICY-TEST-DEVICE",
    repository
  );
  assert.equal(
    transfer.readCursor("discard.jsonl", repository).lastUuid,
    "u2"
  );
  assert.equal(
    transfer.listDeltaChunks().some((file) => file.includes("discard")),
    false
  );
});

test("repo OFF purge preserves the discard cursor across re-enable", () => {
  const repoKey = "github.com/skillbench-ai/discard-resume";
  const transcript = path.join(
    makeTempDir("skm-policy-transcript-"),
    "discard-resume.jsonl"
  );
  const repository = { repoKey, org: "skillbench-ai" };
  writeFile(
    transcript,
    [
      JSON.stringify({ type: "user", uuid: "old-1" }),
      JSON.stringify({ type: "assistant", uuid: "old-2" }),
      "",
    ].join("\n")
  );
  store.setRepositoryOverride(repoKey, false);
  transfer.discardSkippedSessionArtifacts(
    { transcript_path: transcript },
    "POLICY-TEST-DEVICE",
    repository
  );
  transfer.purgeDisallowedQueues();
  assert.equal(
    transfer.readCursor("discard-resume.jsonl", repository).lastUuid,
    "old-2"
  );

  fs.appendFileSync(
    transcript,
    JSON.stringify({ type: "assistant", uuid: "new-1" }) + "\n"
  );
  store.setRepositoryOverride(repoKey, true);
  const result = transfer.stageTranscriptDelta(
    transcript,
    "prompt-1",
    "POLICY-TEST-DEVICE",
    repository
  );
  assert.equal(result.chunks, 1);
  const body = transfer.listDeltaChunks().find((file) => {
    const meta = readJson(file.replace(/\.jsonl$/, ".meta.json"));
    return meta.transcriptId === "discard-resume.jsonl";
  });
  assert.ok(body);
  assert.match(fs.readFileSync(body, "utf8"), /new-1/);
  assert.doesNotMatch(fs.readFileSync(body, "utf8"), /old-1|old-2/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  makeTempDir,
  setTestEnv,
  writeFile,
  writeJson,
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-legacy-state-");
const DATA_DIR = makeTempDir("skm-legacy-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);

writeJson(path.join(STATE_DIR, "credentials.json"), {
  device_id: "LEGACY-TEST-DEVICE",
  hash_salt: "0123456789abcdef0123456789abcdef",
  telemetry_disabled: false,
});

const paths = require("../scripts/lib/paths");
const store = require("../scripts/lib/telemetry-store");
const transfer = require("../scripts/lib/transfer");

test("legacy repository cleanup retries without rewriting policy", (t) => {
  const repo = makeTempDir("skm-legacy-repo-");
  const settingsDir = path.join(repo, ".claude");
  const settingsPath = path.join(settingsDir, "settings.local.json");
  const repoKey = "github.com/skillbench-ai/legacy-retry";
  writeJson(settingsPath, {
    skillmeter: { telemetry: false },
  });

  fs.chmodSync(settingsDir, 0o500);
  t.after(() => {
    try { fs.chmodSync(settingsDir, 0o700); } catch {}
  });

  const first = store.migrateLegacyRepositorySetting(repo, repoKey);
  assert.equal(first.migrated, true);
  assert.equal(first.cleaned, false);
  const revision = store.getPolicyRevision();

  const retry = store.migrateLegacyRepositorySetting(repo, repoKey);
  assert.equal(retry.migrated, false);
  assert.equal(retry.cleaned, false);
  assert.equal(store.getPolicyRevision(), revision);

  fs.chmodSync(settingsDir, 0o700);
  const cleaned = store.migrateLegacyRepositorySetting(repo, repoKey);
  assert.equal(cleaned.migrated, false);
  assert.equal(cleaned.cleaned, true);
  assert.equal(fs.existsSync(settingsPath), false);
  assert.deepEqual(cleaned.policy.migration.legacy_settings, {});
});

test("legacy unbound queue purge preserves repository queues and is idempotent", () => {
  const repository = paths.repositoryQueuePaths(
    "github.com/skillbench-ai/preserved",
    "0123456789abcdef0123456789abcdef"
  );
  const preserved = [
    repository.eventLog,
    path.join(repository.chunks, "chunk.jsonl"),
    path.join(repository.cursors, "cursor.json"),
  ];
  const removed = [
    paths.LOG_FILE,
    path.join(paths.LOG_DIR, "events.jsonl.123"),
    path.join(paths.TRANSCRIPTS_PENDING_DIR, "full.jsonl"),
    path.join(paths.TRANSCRIPTS_CHUNKS_DIR, "chunk.jsonl"),
    path.join(paths.TRANSCRIPTS_CURSORS_DIR, "cursor.json"),
  ];
  for (const filePath of [...preserved, ...removed]) {
    writeFile(filePath, "{}\n");
  }

  transfer.purgeLegacyUnboundQueue();
  transfer.purgeLegacyUnboundQueue();

  for (const filePath of removed) assert.equal(fs.existsSync(filePath), false);
  for (const filePath of preserved) assert.equal(fs.existsSync(filePath), true);
});

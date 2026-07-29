"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  readJson,
  setTestEnv,
  writeFile,
  writeJson,
  writeTelemetryPolicy,
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
    aud: "https://example.test",
  }),
});
writeTelemetryPolicy(STATE_DIR, { orgs: { "skillbench-ai": true } });

const store = require("../scripts/lib/telemetry-store");
const transfer = require("../scripts/lib/transfer");

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

test("an unset repository queue is deleted and never transmitted", () => {
  const repoKey = "github.com/skillbench-ai/not-selected";
  const body = transfer.sealDeltaChunk(
    "not-selected.jsonl",
    [JSON.stringify({ uuid: "not-selected-1" })],
    { seq: 1, reset: false, resetBaselineSeq: null },
    { repoKey, org: "skillbench-ai" }
  );
  assert.ok(body && fs.existsSync(body));

  transfer.purgeDisallowedQueues();
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
  store.setRepositoryOverride(repoKey, false);
  transfer.purgeDisallowedQueues();
  assert.equal(fs.existsSync(body), false);
});

test("backfill upload records detailed attempt and success diagnostics", async (t) => {
  const repoKey = "github.com/skillbench-ai/backfill-log";
  store.setOrganizationConsent("skillbench-ai", false);
  store.setRepositoryOverride(repoKey, false);
  writeJson(path.join(DATA_DIR, "backfill-state.json"), {
    schema_version: 1,
    lifecycle_id: "backfill-log-lifecycle",
    status: "completed",
    reason: "snapshot_queued",
    offer_id: "offer-log-test",
    org: "skillbench-ai",
    repository_ids: ["aaaaaaaaaaaa"],
    repository_keys: [repoKey],
    upload_authorized: true,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  const body = transfer.sealDeltaChunk(
    "backfill-log.jsonl",
    [JSON.stringify({ uuid: "backfill-log-1" })],
    {
      seq: 1,
      reset: false,
      resetBaselineSeq: null,
      promptId: "backfill",
      backfillOfferId: "offer-log-test",
    },
    { repoKey, org: "skillbench-ai" }
  );
  assert.ok(body && fs.existsSync(body));

  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 202 });
  t.after(() => { global.fetch = previousFetch; });

  store.setGlobalEnabled(false);
  const paused = await transfer.drainDeltaChunks(100);
  assert.equal(paused.ok, 0);
  assert.equal(fs.existsSync(body), true);
  store.setGlobalEnabled(true);

  const result = await transfer.drainDeltaChunks(100);
  assert.equal(result.ok, 1);
  assert.equal(fs.existsSync(body), false);

  const records = fs.readFileSync(
    path.join(DATA_DIR, "logs", "backfill.ndjson"),
    "utf8"
  )
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((record) => record.offerId === "offer-log-test");
  assert.deepEqual(
    records.map((record) => record.event),
    [
      "upload_batch_completed",
      "upload_batch_started",
      "upload_attempt",
      "upload_succeeded",
      "upload_batch_completed",
    ]
  );
  assert.equal(records[0].reason, "global_telemetry_disabled");
  assert.equal(records[3].httpStatus, 202);
  assert.equal(records[3].repository, repoKey);
  assert.ok(records[3].rawBytes > 0);
  assert.ok(records[3].gzipBytes > 0);

  store.setOrganizationConsent("skillbench-ai", true);
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

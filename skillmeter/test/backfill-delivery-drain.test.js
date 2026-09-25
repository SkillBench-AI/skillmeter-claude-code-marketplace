"use strict";

// Completion through the real upload path: stage a historical chunk, upload it
// through drainDeltaChunks against a stubbed backend, and check who announces.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test, beforeEach } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  readJson,
  setTestEnv,
  writeFile,
  writeJson,
} = require("../testing/helpers");

const DATA_DIR = makeTempDir("skm-backfill-drain-data-");
const STATE_DIR = makeTempDir("skm-backfill-drain-state-");
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_CONFIG_DIR", makeTempDir("skm-backfill-drain-claude-"));
// Reserved domain; every request is answered by the stub below.
setTestEnv("SKILLMETER_BACKEND_URL", "https://collector.skillbench.example");

writeJson(path.join(STATE_DIR, "credentials.json"), {
  device_id: "BACKFILL-DRAIN-DEVICE",
  hash_salt: "0123456789abcdef0123456789abcdef",
  license_jwt: makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    org: { login: "SkillBench-AI" },
  }),
});

const backfillState = require("../scripts/lib/backfill-state");
const { prepareHistoricalRecords } = require("../scripts/lib/backfill-snapshot");
const {
  BACKFILL_RESULT_FILE,
  settleBackfillDelivery,
} = require("../scripts/lib/backfill-delivery");
const transfer = require("../scripts/lib/transfer");

const REPOSITORY = {
  repoKey: "github.com/skillbench-ai/drain",
  org: "skillbench-ai",
};
const OFFER = "offer-drain";

function startBackfill() {
  writeJson(backfillState.BACKFILL_STATE_FILE, {
    schema_version: 1,
    lifecycle_id: "66666666-6666-4666-8666-666666666666",
    status: "running",
    reason: "snapshotting",
    offer_id: OFFER,
    org: REPOSITORY.org,
    repository_ids: ["aaaaaaaaaaaa"],
    repository_keys: [REPOSITORY.repoKey],
    upload_authorized: true,
    cutoff_at: Date.now() + 60_000,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

function stageHistory(name) {
  const transcript = path.join(DATA_DIR, `${name}.jsonl`);
  writeFile(transcript, JSON.stringify({
    type: "user",
    uuid: `${name}-a`,
    timestamp: "2026-06-01T09:00:00.000Z",
    message: { content: "historical" },
  }) + "\n");
  const staged = transfer.stageTranscriptSnapshot(transcript, REPOSITORY, {
    transformRecords: prepareHistoricalRecords,
    cutoffAt: Date.now() + 60_000,
    backfillOfferId: OFFER,
  });
  assert.equal(staged.chunks, 1);
}

async function drainAcknowledgingEverything() {
  const requests = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 202, text: async () => "" };
  };
  try {
    await transfer.drainDeltaChunks(5_000);
  } finally {
    global.fetch = realFetch;
  }
  return requests;
}

function logEvents() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, "logs", "backfill.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((record) => record.offerId === OFFER)
      .map((record) => record.event);
  } catch {
    return [];
  }
}

beforeEach(() => {
  fs.rmSync(path.join(DATA_DIR, "logs"), { recursive: true, force: true });
  fs.rmSync(BACKFILL_RESULT_FILE, { force: true });
});

test("the drain that uploads the last historical chunk announces the import", async () => {
  startBackfill();
  stageHistory("finished");
  backfillState.finishBackfill(OFFER, "completed", {
    processed_transcripts: 1,
    queued_chunks: 1,
  });

  const requests = await drainAcknowledgingEverything();
  assert.deepEqual(requests, [
    "https://collector.skillbench.example/logs/claude/transcript",
  ]);
  const result = readJson(BACKFILL_RESULT_FILE);
  assert.equal(result.status, "delivered");
  assert.equal(result.sessions, 1);
  assert.equal(result.setAsideChunks, 0);
  assert.ok(logEvents().includes("delivery_completed"));
});

test("a drain that empties the queue before the snapshot ends leaves it to the worker", async () => {
  startBackfill();
  stageHistory("early");

  // The worker spawns its drain before marking the snapshot finished.
  await drainAcknowledgingEverything();
  assert.equal(fs.existsSync(BACKFILL_RESULT_FILE), false);
  assert.equal(logEvents().includes("delivery_completed"), false);

  // What backfill_worker.js does right after finishBackfill.
  backfillState.finishBackfill(OFFER, "completed", {
    processed_transcripts: 1,
    queued_chunks: 1,
  });
  assert.equal(settleBackfillDelivery().status, "delivered");
  assert.equal(readJson(BACKFILL_RESULT_FILE).sessions, 1);
});

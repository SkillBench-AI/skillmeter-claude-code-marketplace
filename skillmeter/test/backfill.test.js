"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { test } = require("node:test");

const {
  makeTempDir,
  makeJwt,
  readJson,
  runNode,
  setTestEnv,
  writeFile,
  writeJson,
} = require("../testing/helpers");

const DATA_DIR = makeTempDir("skm-backfill-data-");
const STATE_DIR = makeTempDir("skm-backfill-state-");
const CLAUDE_CONFIG_DIR = makeTempDir("skm-backfill-claude-");
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_CONFIG_DIR", CLAUDE_CONFIG_DIR);

const backfillState = require("../scripts/lib/backfill-state");
const { prepareHistoricalRecords } = require("../scripts/lib/backfill-snapshot");
const transfer = require("../scripts/lib/transfer");

const REPOSITORY = {
  repoKey: "github.com/skillbench-ai/backfill",
  org: "skillbench-ai",
};

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("lifecycle asks once, survives updates, and resets after data removal", () => {
  const initial = backfillState.initializeBackfillLifecycle();
  assert.equal(initial.status, "pending");

  const first = backfillState.claimBackfillOffer(
    "11111111-1111-4111-8111-111111111111"
  );
  const second = backfillState.claimBackfillOffer();
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.state.status, "declined");

  const unchanged = backfillState.initializeBackfillLifecycle();
  assert.equal(unchanged.lifecycle_id, initial.lifecycle_id);
  assert.equal(unchanged.status, "declined");

  fs.unlinkSync(backfillState.BACKFILL_STATE_FILE);
  const reinstalled = backfillState.initializeBackfillLifecycle();
  assert.notEqual(reinstalled.lifecycle_id, initial.lifecycle_id);
  assert.equal(reinstalled.status, "pending");
});

test("an existing pre-feature install receives the one-time offer", () => {
  const existingState = makeTempDir("skm-backfill-existing-state-");
  const existingData = makeTempDir("skm-backfill-existing-data-");
  writeJson(path.join(existingState, "credentials.json"), {
    device_id: "EXISTING-DEVICE",
  });
  writeJson(path.join(existingState, "telemetry-policy.json"), {
    revision: 1,
  });
  const modulePath = path.resolve(
    __dirname,
    "../scripts/lib/backfill-state.js"
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const state=require(${JSON.stringify(modulePath)});` +
      "process.stdout.write(JSON.stringify(state.initializeBackfillLifecycle()));",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: existingData,
        SKILLMETER_STATE_DIR: existingState,
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.status, "pending");
  assert.equal(state.reason, "one_time_offer");
  assert.deepEqual(
    fs.readdirSync(existingState).sort(),
    ["credentials.json", "telemetry-policy.json"]
  );
});

test("running backfill freezes live staging without moving its cursor", () => {
  const claimed = backfillState.claimBackfillOffer();
  assert.equal(claimed.claimed, true);
  const running = backfillState.beginBackfill(claimed.state.offer_id, {
    org: REPOSITORY.org,
    repositoryIds: ["aaaaaaaaaaaa"],
    repositoryKeys: [REPOSITORY.repoKey],
  });
  assert.equal(running.started, true);
  assert.equal(backfillState.isBackfillUploadAuthorized({
    offerId: claimed.state.offer_id,
    org: REPOSITORY.org,
    repoKey: REPOSITORY.repoKey,
  }), true);
  assert.equal(backfillState.isBackfillUploadAuthorized({
    offerId: "another-offer",
    org: REPOSITORY.org,
    repoKey: REPOSITORY.repoKey,
  }), false);

  const transcript = path.join(DATA_DIR, "live.jsonl");
  writeFile(transcript, jsonl([
    { type: "user", uuid: "live-a", message: { content: "hello" } },
  ]));
  const result = transfer.stageTranscriptDelta(
    transcript,
    "prompt",
    "device",
    REPOSITORY
  );
  assert.deepEqual(result, { chunks: 0, deferred: true });
  assert.equal(transfer.readCursor("live.jsonl", REPOSITORY), null);

  backfillState.finishBackfill(claimed.state.offer_id, "completed");

  const completed = backfillState.readBackfillState();
  writeJson(backfillState.BACKFILL_STATE_FILE, {
    ...completed,
    status: "running",
    offer_id: "stale-offer",
    updated_at: Date.now() - backfillState.RUNNING_STALE_MS - 1,
  });
  assert.equal(backfillState.isBackfillRunning(), false);
  assert.equal(backfillState.readBackfillState().status, "failed");
});

test("snapshot seals through the final UUID and live delta continues after it", () => {
  writeJson(path.join(STATE_DIR, "credentials.json"), {
    device_id: "BACKFILL-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
  });
  const transcript = path.join(DATA_DIR, "history.jsonl");
  const records = [
    {
      type: "user",
      uuid: "history-a",
      cwd: "/Users/private/project",
      message: {
        content: [
          { type: "text", text: "contact person@example.com" },
          { type: "tool_result", content: "PRIVATE TOOL OUTPUT" },
          { type: "image", source: { data: "PRIVATE IMAGE" } },
        ],
      },
      toolUseResult: { stdout: "PRIVATE TOOL OUTPUT" },
    },
    {
      type: "assistant",
      uuid: "history-b",
      message: { content: "done" },
    },
    { type: "last-prompt" },
  ];
  writeFile(transcript, jsonl(records));

  const before = new Set(transfer.listDeltaChunks());
  const snapshot = transfer.stageTranscriptSnapshot(transcript, REPOSITORY, {
    transformRecords: prepareHistoricalRecords,
  });
  assert.equal(snapshot.chunks, 1);
  assert.equal(snapshot.lastUuid, "history-b");

  const cursor = transfer.readCursor("history.jsonl", REPOSITORY);
  assert.equal(cursor.lastUuid, "history-b");
  assert.equal(cursor.backfill, true);

  const bodyPath = transfer.listDeltaChunks().find((file) => !before.has(file));
  const body = fs.readFileSync(bodyPath, "utf8");
  assert.doesNotMatch(body, /PRIVATE TOOL OUTPUT|PRIVATE IMAGE/);
  assert.doesNotMatch(body, /person@example\.com|\/Users\/private/);
  assert.match(body, /history-a/);
  assert.match(body, /history-b/);
  assert.doesNotMatch(body, /last-prompt/);

  writeFile(transcript, jsonl([
    ...records,
    {
      type: "assistant",
      uuid: "history-c",
      message: { content: "new live content" },
    },
  ]));
  const live = transfer.stageTranscriptDelta(
    transcript,
    "prompt-live",
    "device",
    REPOSITORY
  );
  assert.equal(live.chunks, 1);
  assert.equal(
    transfer.readCursor("history.jsonl", REPOSITORY).lastUuid,
    "history-c"
  );
});

test("snapshot ignores a discarded cursor but skips a real upload cursor", () => {
  const discardedPath = path.join(DATA_DIR, "discarded.jsonl");
  writeFile(discardedPath, jsonl([
    { type: "user", uuid: "discard-a", message: { content: "old" } },
  ]));
  transfer.writeCursor({
    transcriptId: "discarded.jsonl",
    lastUuid: "discard-a",
    seq: 0,
    discarded: true,
  }, REPOSITORY);
  assert.equal(
    transfer.stageTranscriptSnapshot(
      discardedPath,
      REPOSITORY,
      { transformRecords: prepareHistoricalRecords }
    ).chunks,
    1
  );

  const existingPath = path.join(DATA_DIR, "existing.jsonl");
  writeFile(existingPath, jsonl([
    { type: "user", uuid: "existing-a", message: { content: "sent" } },
  ]));
  transfer.writeCursor({
    transcriptId: "existing.jsonl",
    lastUuid: "existing-a",
    seq: 1,
  }, REPOSITORY);
  assert.deepEqual(
    transfer.stageTranscriptSnapshot(existingPath, REPOSITORY),
    { chunks: 0, skipped: true, reason: "existing_cursor" }
  );
});

test("accept queues historical data without changing telemetry policy", async () => {
  const repo = makeTempDir("skm-backfill-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/SkillBench-AI/backfill-e2e.git\n'
  );
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const transcript = path.join(
    CLAUDE_CONFIG_DIR,
    "projects",
    "backfill-e2e",
    `${sessionId}.jsonl`
  );
  writeFile(transcript, jsonl([
    {
      type: "user",
      uuid: "e2e-a",
      cwd: repo,
      message: { content: "historical" },
    },
  ]));

  writeJson(path.join(STATE_DIR, "credentials.json"), {
    device_id: "BACKFILL-E2E-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: "SkillBench-AI" },
    }),
  });
  writeJson(backfillState.BACKFILL_STATE_FILE, {
    schema_version: 1,
    lifecycle_id: "44444444-4444-4444-8444-444444444444",
    status: "pending",
    reason: "one_time_offer",
    created_at: Date.now(),
    updated_at: Date.now(),
  });

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR,
    CLAUDE_PLUGIN_DATA: DATA_DIR,
    SKILLMETER_STATE_DIR: STATE_DIR,
  };
  const claim = runNode(
    path.resolve(__dirname, "../scripts/backfill.js"),
    [
      "claim",
      "44444444-4444-4444-8444-444444444444",
      "33333333-3333-4333-8333-333333333333",
    ],
    { cwd: repo, env }
  );
  assert.equal(claim.status, 0, claim.stderr);
  const offer = JSON.parse(claim.stdout);
  assert.equal(offer.claimed, true);

  const inventory = runNode(
    path.resolve(__dirname, "../scripts/repository_telemetry.js"),
    ["list"],
    { cwd: repo, env }
  );
  assert.equal(inventory.status, 0, inventory.stderr);
  const listed = JSON.parse(inventory.stdout);
  const target = listed.repositories.find(
    (repository) => repository.displayName === "@skillbench-ai/backfill-e2e"
  );
  assert.ok(target);

  const accepted = runNode(
    path.resolve(__dirname, "../scripts/backfill.js"),
    [
      "accept",
      "44444444-4444-4444-8444-444444444444",
      offer.offerId,
      String(listed.revision),
      "skillbench-ai",
      target.id,
    ],
    { cwd: repo, env }
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).started, true);
  const unchangedPolicy = readJson(
    path.join(STATE_DIR, "telemetry-policy.json")
  );
  assert.notEqual(
    unchangedPolicy.repositories[
      "github.com/skillbench-ai/backfill-e2e"
    ]?.enabled,
    true
  );

  const deadline = Date.now() + 3_000;
  let finalState;
  while (Date.now() < deadline) {
    finalState = readJson(backfillState.BACKFILL_STATE_FILE);
    if (finalState.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.processed_transcripts, 1);
  assert.equal(finalState.queued_chunks, 1);
  assert.equal(
    transfer.readCursor(`${sessionId}.jsonl`, {
      repoKey: "github.com/skillbench-ai/backfill-e2e",
      org: "skillbench-ai",
    }).lastUuid,
    "e2e-a"
  );

  // The worker marks snapshot completion before its detached drain exits.
  // Wait for that child to clear its lock so temp-dir cleanup cannot race it.
  const drainLock = path.join(DATA_DIR, "logs", ".drain-once.lock");
  while (Date.now() < deadline && fs.existsSync(drainLock)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(drainLock), false);

  const logRecords = fs.readFileSync(
    path.join(DATA_DIR, "logs", "backfill.ndjson"),
    "utf8"
  )
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((record) => record.offerId === offer.offerId);
  const events = new Set(logRecords.map((record) => record.event));
  for (const event of [
    "worker_spawned",
    "worker_started",
    "scan_completed",
    "snapshot_progress",
    "snapshot_completed",
    "drain_requested",
    "upload_batch_started",
    "upload_deferred",
    "upload_batch_completed",
  ]) {
    assert.ok(events.has(event), `missing backfill log event: ${event}`);
  }
  assert.ok(logRecords.every((record) => !("transcriptContent" in record)));

  const snapshotMeta = transfer.listDeltaChunks()
    .map((bodyPath) => readJson(
      bodyPath.replace(/\.jsonl$/, ".meta.json")
    ))
    .find((meta) => meta.transcriptId === `${sessionId}.jsonl`);
  assert.equal(snapshotMeta.promptId, "backfill");
  assert.equal(snapshotMeta.backfillOfferId, offer.offerId);

  transfer.purgeDisallowedQueues();
  assert.ok(
    transfer.listDeltaChunks().some((bodyPath) =>
      readJson(bodyPath.replace(/\.jsonl$/, ".meta.json"))
        .backfillOfferId === offer.offerId
    ),
    "telemetry-off cleanup must preserve the consented historical chunk"
  );
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  makeTempDir,
  readJson,
  setTestEnv,
  writeJson,
} = require("../testing/helpers");

const DATA_DIR = makeTempDir("skm-backfill-monitor-");
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);

const {
  BACKFILL_LOG_FILE,
  appendBackfillLog,
} = require("../scripts/lib/backfill-log");
const {
  formatNotification,
  pendingBackfillChunks,
} = require("../scripts/monitors/backfill_monitor");

test("backfill monitor is registered as an always-on plugin monitor", () => {
  const monitors = readJson(
    path.resolve(__dirname, "../monitors/monitors.json")
  );
  const monitor = monitors.find(
    (entry) => entry.name === "skillmeter-backfill-monitor"
  );
  assert.deepEqual(monitor, {
    name: "skillmeter-backfill-monitor",
    command:
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/monitors/backfill_monitor.js"',
    description:
      "Reports detached historical backfill snapshot and upload progress",
  });
});

test("structured backfill log is private, append-only NDJSON", () => {
  const record = appendBackfillLog("upload_failed", {
    offerId: "offer-a",
    repository: "github.com/skillbench-ai/example",
    transcriptId: "11111111-1111-4111-8111-111111111111",
    error:
      `${process.env.HOME}/private/transcript.jsonl ` +
      "https://tenant.example/upload\nfailed",
  });
  assert.equal(record.event, "upload_failed");

  const stored = JSON.parse(
    fs.readFileSync(BACKFILL_LOG_FILE, "utf8").trim()
  );
  assert.equal(stored.offerId, "offer-a");
  assert.equal(stored.repository, "github.com/skillbench-ai/example");
  assert.match(stored.error, /\[HOME\]/);
  assert.match(stored.error, /\[ENDPOINT\]/);
  assert.doesNotMatch(stored.error, /private\/transcript/);
  assert.doesNotMatch(stored.error, /tenant\.example/);
  assert.equal(fs.statSync(BACKFILL_LOG_FILE).mode & 0o777, 0o600);
  assert.equal(appendBackfillLog("../invalid", {}), null);
});

test("monitor reports lifecycle summaries without transcript content", () => {
  assert.equal(
    formatNotification({
      event: "snapshot_completed",
      processedTranscripts: 21,
      queuedChunks: 21,
      skippedTranscripts: 15,
    }),
    "SkillMeter backfill snapshot complete: 21 sessions, 21 upload chunks queued, 15 skipped."
  );
  assert.equal(
    formatNotification({
      event: "upload_batch_completed",
      uploaded: 20,
      failed: 1,
      deferred: 0,
    }),
    "SkillMeter backfill upload pass complete: 20 sent, 1 failed, 0 deferred."
  );
  assert.equal(
    formatNotification({
      event: "upload_attempt",
      transcriptContent: "must not be shown",
    }),
    ""
  );
  assert.equal(
    formatNotification({
      event: "upload_batch_completed",
      uploaded: 0,
      failed: 0,
      deferred: 21,
    }),
    ""
  );
});

test("monitor counts only backfill upload chunks", () => {
  const chunks = path.join(
    DATA_DIR,
    "logs",
    "repositories",
    "aaaaaaaaaaaa",
    "transcripts",
    "chunks"
  );
  writeJson(path.join(chunks, "backfill.meta.json"), {
    promptId: "backfill",
  });
  writeJson(path.join(chunks, "live.meta.json"), {
    promptId: "live",
  });
  assert.equal(pendingBackfillChunks(), 1);
});

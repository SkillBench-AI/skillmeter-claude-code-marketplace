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
  formatDiagnostic,
  formatNotification,
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
    // Monitor commands get `${...}` substituted but nothing exported, so the
    // data dir is passed through explicitly.
    command:
      'CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" ' +
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/monitors/backfill_monitor.js"',
    description: "SkillMeter history backfill",
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

test("progress stays quiet; the finished import is announced by its own hook", () => {
  for (const record of [
    { event: "worker_spawned", workerPid: 123, repositoryCount: 2 },
    { event: "scan_completed", sessionsIncluded: 21, sessionsSkipped: 15 },
    {
      event: "snapshot_completed",
      processedTranscripts: 21,
      queuedChunks: 21,
      skippedTranscripts: 15,
    },
    { event: "upload_batch_completed", uploaded: 20, failed: 1, deferred: 0 },
    { event: "delivery_completed", sessions: 21, setAsideChunks: 0 },
    { event: "upload_attempt", transcriptContent: "must not be shown" },
  ]) {
    assert.equal(formatNotification(record), "", record.event);
  }
});

test("a failed worker is announced because the import will not finish", () => {
  assert.equal(
    formatNotification({ event: "worker_failed", error: "Backfill worker failed." }),
    "SkillMeter history import failed: Backfill worker failed."
  );
});

// ---- output contract -------------------------------------------------------
// Every stdout line from a plugin monitor becomes one Claude-facing
// notification, so a per-failure line is a flood: the notification re-invokes
// the session, the session's Stop hook spawns another drain, and that drain
// fails the same chunks again. Retry noise goes to stderr instead.

test("per-attempt upload failures never become Claude notifications", () => {
  assert.equal(
    formatNotification({
      event: "upload_failed",
      repository: "github.com/skillbench-ai/example",
      transcriptId: "e982c12e-621b-49c6-9a82-564ab0fb7f9c",
      seq: 3,
      httpStatus: 500,
      error: "HTTP 500",
    }),
    ""
  );
  assert.equal(
    formatNotification({ event: "upload_deferred", reason: "license_unavailable" }),
    ""
  );
});

test("retry noise is still visible as monitor diagnostics on stderr", () => {
  assert.match(
    formatDiagnostic({
      event: "upload_failed",
      repository: "github.com/skillbench-ai/example",
      transcriptId: "e982c12e-621b-49c6-9a82-564ab0fb7f9c",
      seq: 3,
      attempts: 4,
      error: "HTTP 500",
    }),
    /seq 3.*HTTP 500/
  );
  assert.equal(formatDiagnostic({ event: "snapshot_completed" }), "");
});

test("a set-aside chunk is a diagnostic; the completion notice counts it", () => {
  const record = {
    event: "upload_abandoned",
    repository: "github.com/skillbench-ai/example",
    transcriptId: "e982c12e-621b-49c6-9a82-564ab0fb7f9c",
    seq: 3,
    attempts: 8,
    error: "HTTP 500",
  };
  assert.equal(formatNotification(record), "");
  assert.equal(
    formatDiagnostic(record),
    "upload set aside: github.com/skillbench-ai/example seq 3 after 8 attempts, HTTP 500"
  );
});

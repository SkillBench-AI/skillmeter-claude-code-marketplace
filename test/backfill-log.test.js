"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const { test } = require("node:test");

const { makeTempDir, setTestEnv } = require("../testing/helpers");

setTestEnv("CLAUDE_PLUGIN_DATA", makeTempDir("skm-backfill-log-"));

const {
  BACKFILL_LOG_FILE,
  appendBackfillLog,
} = require("../skillmeter/scripts/lib/backfill-log");

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

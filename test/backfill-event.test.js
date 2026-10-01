"use strict";

// The BackfillCompleted event: one per accepted import, with an outcome of
// success, partial_success or failed, sent only under the import's own consent
// and tenant.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { test, beforeEach } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  setTestEnv,
  writeJson,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-bf-event-state-");
const DATA_DIR = makeTempDir("skm-bf-event-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
setTestEnv("SKILLMETER_BACKEND_URL", "https://collector.skillbench.example");

const ORG = "skillbench-ai";
const REPO_KEY = "github.com/skillbench-ai/events";
writeJson(path.join(STATE_DIR, "credentials.json"), {
  device_id: "BF-EVENT-DEVICE",
  hash_salt: "0123456789abcdef0123456789abcdef",
});
writeTelemetryPolicy(STATE_DIR, { orgs: { [ORG]: true } });

const { SESSION_FILE } = require("../skillmeter/scripts/credstore");
function signIn(audience = "https://dev.meter.skillbench.example") {
  writeJson(SESSION_FILE, {
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: ORG },
      orgs: [ORG],
      aud: audience,
    }),
  });
}
signIn();

const backfillState = require("../skillmeter/scripts/lib/backfill-state");
const store = require("../skillmeter/scripts/lib/telemetry-store");
const transfer = require("../skillmeter/scripts/lib/transfer");
const { currentTenantFingerprint } = require("../skillmeter/scripts/lib/tenant");
const { LOG_DIR } = require("../skillmeter/scripts/lib/paths");
const {
  BACKFILL_EVENT_DIR,
  OUTCOMES,
  classifyBackfillOutcome,
  listBackfillEvents,
} = require("../skillmeter/scripts/lib/backfill-event");
const {
  queueUnqueuedBackfillEvent,
  settleBackfillDelivery,
} = require("../skillmeter/scripts/lib/backfill-delivery");

const OFFER = "11111111-2222-4333-8444-555555555555";
const realFetch = global.fetch;
process.on("exit", () => { global.fetch = realFetch; });

let posted;
beforeEach(() => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  fs.rmSync(backfillState.BACKFILL_STATE_FILE, { force: true });
  signIn();
  store.setGlobalEnabled(true);
  posted = [];
  global.fetch = async (url, options) => {
    posted.push({
      url: String(url),
      headers: options.headers,
      lines: zlib.gunzipSync(options.body).toString().trim().split("\n").map(JSON.parse),
    });
    return { ok: true, status: 202, text: async () => "" };
  };
});

// A finished import of `queued` chunks, accepted under the current tenant.
function finishedImport({ status = "completed", queued = 4, extra = {} } = {}) {
  writeJson(backfillState.BACKFILL_STATE_FILE, {
    schema_version: 1,
    lifecycle_id: "44444444-4444-4444-8444-444444444444",
    status,
    reason: status === "completed" ? "snapshot_queued" : "snapshot_failed",
    offer_id: OFFER,
    org: ORG,
    repository_ids: ["aaaaaaaaaaaa"],
    repository_keys: [REPO_KEY],
    tenant_fingerprint: currentTenantFingerprint(),
    upload_authorized: true,
    processed_transcripts: 3,
    skipped_transcripts: 1,
    queued_chunks: queued,
    cutoff_at: Date.now() - 60_000,
    completed_at: Date.now(),
    created_at: Date.now(),
    updated_at: Date.now(),
    error: "/Users/someone/.claude/projects/x.jsonl: EACCES",
    ...extra,
  });
}

function logSent(count) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.appendFileSync(path.join(LOG_DIR, "backfill.ndjson"), JSON.stringify({
      event: "upload_succeeded", offerId: OFFER, repository: REPO_KEY, transcriptId: `t-${i}`, seq: 1,
    }) + "\n");
  }
}

function queuedEvent() {
  const files = listBackfillEvents();
  assert.equal(files.length, 1, "exactly one event is queued");
  return JSON.parse(fs.readFileSync(files[0], "utf8")).event;
}

test("outcomes: success, partial_success and failed", () => {
  const c = (snapshotFailed, queuedChunks, sentChunks) =>
    classifyBackfillOutcome({ snapshotFailed, queuedChunks, sentChunks });
  assert.equal(c(false, 4, 4), OUTCOMES.SUCCESS);
  assert.equal(c(false, 0, 0), OUTCOMES.SUCCESS, "nothing to import");
  assert.equal(c(false, 4, 3), OUTCOMES.PARTIAL_SUCCESS, "some chunks unsent");
  assert.equal(c(true, 4, 4), OUTCOMES.PARTIAL_SUCCESS, "some sessions failed to snapshot");
  assert.equal(c(false, 4, 0), OUTCOMES.FAILED, "nothing acknowledged");
  assert.equal(c(true, 0, 0), OUTCOMES.FAILED, "failed before queuing");
});

test("a fully delivered import queues one success event", () => {
  finishedImport();
  logSent(4);
  assert.ok(settleBackfillDelivery());
  const event = queuedEvent();
  assert.equal(event.hook_event_name, "BackfillCompleted");
  assert.equal(event.session_id, OFFER);
  assert.equal(event.device_id, "BF-EVENT-DEVICE");
  assert.equal(event.level, "info");
  assert.equal(event.data.outcome, "success");
  assert.equal(event.data.reason, null);
  assert.deepEqual(
    [event.data.sessions, event.data.queued_chunks, event.data.sent_chunks, event.data.unsent_chunks],
    [3, 4, 4, 0]
  );
  assert.equal(settleBackfillDelivery(), null);
  assert.equal(listBackfillEvents().length, 1, "settling again queues nothing");
});

test("an import with unsent chunks is a partial success", () => {
  finishedImport();
  logSent(1);
  settleBackfillDelivery();
  const event = queuedEvent();
  assert.equal(event.data.outcome, "partial_success");
  assert.equal(event.data.reason, "chunks_unsent");
  assert.equal(event.level, "warn");
  assert.equal(event.data.unsent_chunks, 3);
});

test("an import with nothing acknowledged fails", () => {
  finishedImport();
  settleBackfillDelivery();
  assert.equal(queuedEvent().data.outcome, "failed");
});

test("a snapshot that failed before queuing still sends a failed event", () => {
  finishedImport({ status: "failed", queued: 0 });
  assert.ok(queueUnqueuedBackfillEvent(OFFER));
  const event = queuedEvent();
  assert.equal(event.data.outcome, "failed");
  assert.equal(event.data.reason, "snapshot_failed");
  assert.doesNotMatch(JSON.stringify(event), /Users|EACCES/, "stored error text is never sent");
});

test("an import with nothing to send is a success", () => {
  finishedImport({ queued: 0, extra: { processed_transcripts: 0 } });
  queueUnqueuedBackfillEvent(OFFER);
  assert.equal(queuedEvent().data.outcome, "success");
});

test("the event carries counts and identifiers only", () => {
  finishedImport();
  logSent(4);
  settleBackfillDelivery();
  assert.deepEqual(Object.keys(queuedEvent().data).sort(), [
    "completed_at", "cutoff_at", "manual", "offer_id", "outcome", "queued_chunks",
    "reason", "repositories", "sent_chunks", "sessions", "set_aside_chunks",
    "skipped_sessions", "unsent_chunks",
  ]);
});

test("the drain sends the event once, to the accepting tenant", async () => {
  finishedImport();
  logSent(4);
  settleBackfillDelivery();
  assert.equal(await transfer.drainBackfillEvents(), 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://collector.skillbench.example/logs/claude");
  assert.equal(posted[0].headers["X-Idempotency-Key"], `backfill-completed:${OFFER}`);
  assert.equal(posted[0].lines[0].hook_event_name, "BackfillCompleted");
  assert.equal(listBackfillEvents().length, 0);
  assert.equal(await transfer.drainBackfillEvents(), 0);
});

test("another tenant never receives it; signed out or paused, it waits", async () => {
  finishedImport();
  settleBackfillDelivery();

  writeJson(SESSION_FILE, { signed_out: true });
  await transfer.drainBackfillEvents();
  store.setGlobalEnabled(false);
  signIn();
  await transfer.drainBackfillEvents();
  store.setGlobalEnabled(true);
  assert.equal(posted.length, 0);
  assert.equal(listBackfillEvents().length, 1, "kept for the same tenant");

  signIn("https://prod.meter.skillbench.example");
  await transfer.drainBackfillEvents();
  assert.equal(posted.length, 0);
  assert.equal(listBackfillEvents().length, 0, "deleted unsent");
});

test("a failed send is retried after its backoff", async () => {
  finishedImport();
  settleBackfillDelivery();
  global.fetch = async () => ({ ok: false, status: 503, text: async () => "" });
  await transfer.drainBackfillEvents();
  const [file] = listBackfillEvents();
  const { retry } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(retry.uploadAttempts, 1);
  assert.ok(retry.nextAttemptAt > Date.now());

  global.fetch = async () => { throw new Error("must wait out the backoff"); };
  assert.equal(await transfer.drainBackfillEvents(), 0);

  const entry = JSON.parse(fs.readFileSync(file, "utf8"));
  writeJson(file, { ...entry, retry: { ...entry.retry, nextAttemptAt: Date.now() - 1 } });
  global.fetch = async () => ({ ok: true, status: 202, text: async () => "" });
  assert.equal(await transfer.drainBackfillEvents(), 1);
  assert.equal(fs.existsSync(BACKFILL_EVENT_DIR) && listBackfillEvents().length, 0);
});

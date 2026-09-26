"use strict";

// Regression tests for the backfill failure modes fixed together: a retry
// that dropped the previous run's unsent history, an unauthorized historical
// chunk that purged the repository's live queue, a second run that never
// announced, a dead worker that stayed "running", a corrupt state file that
// broke sign-in, unbounded upload concurrency, and live sessions deferred for
// the whole run.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test, beforeEach } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  setTestEnv,
  writeFile,
  writeJson,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-bf-robust-state-");
const DATA_DIR = makeTempDir("skm-bf-robust-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
// Uploads go to the stubbed fetch below, never to an ambient endpoint.
setTestEnv("SKILLMETER_BACKEND_URL", "https://collector.skillbench.example");

const ORG = "skillbench-ai";
const REPO = { repoKey: "github.com/skillbench-ai/robust", org: ORG };

writeJson(path.join(STATE_DIR, "credentials.json"), {
  device_id: "BF-ROBUST-DEVICE",
  hash_salt: "0123456789abcdef0123456789abcdef",
  license_jwt: makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    org: { login: ORG },
    aud: "https://acme.meter.skillbench.example",
  }),
});
writeTelemetryPolicy(STATE_DIR, { orgs: { [ORG]: true } });

const backfillState = require("../skillmeter/scripts/lib/backfill-state");
const store = require("../skillmeter/scripts/lib/telemetry-store");
const transfer = require("../skillmeter/scripts/lib/transfer");
const { REPOSITORIES_LOG_DIR } = require("../skillmeter/scripts/lib/paths");

const realFetch = global.fetch;
process.on("exit", () => { global.fetch = realFetch; });

beforeEach(() => {
  fs.rmSync(backfillState.BACKFILL_STATE_FILE, { force: true });
  fs.rmSync(REPOSITORIES_LOG_DIR, { recursive: true, force: true });
  global.fetch = realFetch;
});

// Claim and start a run for REPO; returns its offer id.
function startRun() {
  backfillState.initializeBackfillLifecycle();
  const { claimed, state } = backfillState.claimBackfillOffer("", { manual: true });
  assert.equal(claimed, true);
  const begun = backfillState.beginBackfill(state.offer_id, {
    org: ORG,
    repositoryIds: ["aaaaaaaaaaaa"],
    repositoryKeys: [REPO.repoKey],
  });
  assert.equal(begun.started, true);
  return state.offer_id;
}

function sealHistorical(offerId, name) {
  return transfer.sealDeltaChunk(
    `${name}.jsonl`,
    [JSON.stringify({ uuid: `${name}-1` })],
    { seq: 1, reset: false, resetBaselineSeq: null, promptId: "backfill", backfillOfferId: offerId },
    REPO
  );
}

test("a retry keeps uploading the previous run's unsent history", () => {
  const first = startRun();
  backfillState.finishBackfill(first, "failed", { error: "one transcript failed" });

  const retry = backfillState.claimBackfillOffer("", { manual: true });
  assert.equal(retry.claimed, true);
  assert.notEqual(retry.state.offer_id, first);

  // The user approved the first run; its queued chunks stay authorized.
  assert.equal(
    backfillState.isBackfillUploadAuthorized({ offerId: first, org: ORG, repoKey: REPO.repoKey }),
    true
  );
  // The new offer is not authorized until it is accepted.
  assert.equal(
    backfillState.isBackfillUploadAuthorized({ offerId: retry.state.offer_id, org: ORG, repoKey: REPO.repoKey }),
    false
  );
  // Nothing else is authorized by the kept offer.
  assert.equal(
    backfillState.isBackfillUploadAuthorized({ offerId: first, org: ORG, repoKey: "github.com/skillbench-ai/other" }),
    false
  );
});

test("an unauthorized historical chunk deletes only itself, not the live queue", async () => {
  store.setRepositoryOverride(REPO.repoKey, true);
  backfillState.initializeBackfillLifecycle();
  const live = transfer.sealDeltaChunk(
    "live.jsonl",
    [JSON.stringify({ uuid: "live-1" })],
    { seq: 1, reset: false, resetBaselineSeq: null, promptId: "live" },
    REPO
  );
  const orphan = sealHistorical("never-accepted-offer", "orphan");
  assert.ok(live && orphan);
  // The repository's active event log sits at the queue root; a queue purge
  // would delete it along with everything else the repository has queued.
  const eventLog = path.join(path.dirname(path.dirname(path.dirname(live))), "events.jsonl");
  writeFile(eventLog, JSON.stringify({ hook_event_name: "Stop" }) + "\n");

  const sent = [];
  global.fetch = async (url, options) => {
    sent.push(options?.headers?.["X-Idempotency-Key"] || url);
    return { ok: true, status: 202, text: async () => "" };
  };
  await transfer.drainDeltaChunks(100);

  assert.equal(fs.existsSync(orphan), false, "the unauthorized chunk is removed");
  assert.equal(fs.existsSync(eventLog), true, "the live event log survives");
  assert.equal(sent.length, 1, "only the live chunk is sent");
  assert.equal(fs.existsSync(live), false, "the live chunk was uploaded, not purged unsent");
});

test("a second run starts without the first run's delivery markers", () => {
  // A failed run can be retried manually; its settle recorded delivered_at.
  const first = startRun();
  backfillState.finishBackfill(first, "failed", { error: "one transcript failed" });
  backfillState.markBackfillDelivered(first);
  assert.ok(backfillState.readBackfillState().delivered_at);

  const second = startRun();
  const state = backfillState.readBackfillState();
  assert.equal(state.offer_id, second);
  assert.equal(state.delivered_at, undefined);
  assert.equal(state.completed_at, undefined);
});

test("a run whose worker died is reported as failed and can be retried", () => {
  const offerId = startRun();
  // A pid that cannot exist: the worker is gone.
  backfillState.updateBackfillProgress(offerId, { worker_pid: 2 ** 30 });

  const view = backfillState.publicBackfillState();
  assert.equal(view.status, "failed");
  assert.equal(backfillState.readBackfillState().error, "Backfill worker exited.");
  assert.equal(backfillState.claimBackfillOffer("", { manual: true }).claimed, true);
});

test("a live worker keeps its run", () => {
  const offerId = startRun();
  backfillState.updateBackfillProgress(offerId, { worker_pid: process.pid });
  assert.equal(backfillState.isBackfillRunning(), true);
});

test("an unreadable state file is set aside and replaced", () => {
  writeFile(backfillState.BACKFILL_STATE_FILE, "");
  const state = backfillState.initializeBackfillLifecycle();
  assert.equal(state.status, "declined");
  assert.equal(state.reason, "state_recovered");
  const aside = fs
    .readdirSync(path.dirname(backfillState.BACKFILL_STATE_FILE))
    .filter((name) => name.startsWith(`${path.basename(backfillState.BACKFILL_STATE_FILE)}.corrupt-`));
  assert.equal(aside.length > 0, true, "the unreadable file is kept for diagnosis");
  // The manual backfill can still claim a recovered state.
  assert.equal(backfillState.claimBackfillOffer("", { manual: true }).claimed, true);
});

test("a state file from a newer schema is left alone", () => {
  writeJson(backfillState.BACKFILL_STATE_FILE, { schema_version: 99, status: "pending" });
  assert.throws(() => backfillState.initializeBackfillLifecycle(), /newer SkillMeter version/);
  assert.equal(
    JSON.parse(fs.readFileSync(backfillState.BACKFILL_STATE_FILE, "utf8")).schema_version,
    99
  );
});

test("a drain uploads a large queue a few chunks at a time", async () => {
  const offerId = startRun();
  for (let i = 0; i < 12; i++) assert.ok(sealHistorical(offerId, `many-${i}`));

  let inFlight = 0;
  let peak = 0;
  global.fetch = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return { ok: true, status: 202, text: async () => "" };
  };
  const result = await transfer.drainDeltaChunks(100);

  assert.equal(result.ok, 12);
  assert.ok(peak > 1, "uploads still overlap");
  assert.ok(peak <= 4, `at most 4 uploads in flight, saw ${peak}`);
});

test("a live session with its own cursor keeps staging during a backfill", () => {
  startRun();
  const transcript = path.join(makeTempDir("skm-bf-robust-live-"), "live-session.jsonl");
  writeFile(transcript, JSON.stringify({ type: "user", uuid: "a", message: { content: "hi" } }) + "\n");
  transfer.writeCursor({ transcriptId: "live-session.jsonl", uuid: "a", seq: 1 }, REPO);
  fs.appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "b", message: { content: "more" } }) + "\n");

  const result = transfer.stageTranscriptDelta(transcript, "prompt", "device", REPO);
  assert.notEqual(result.deferred, true, "a cursor-bearing live transcript is not deferred");
  assert.ok(result.chunks > 0);
});

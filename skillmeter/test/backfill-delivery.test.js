"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test, beforeEach } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  readJson,
  runNode,
  setTestEnv,
  writeFile,
  writeJson,
} = require("../testing/helpers");

const DATA_DIR = makeTempDir("skm-backfill-delivery-");
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);

const backfillState = require("../scripts/lib/backfill-state");
const {
  BACKFILL_RESULT_FILE,
  announceBackfillFailure,
  countBackfillChunks,
  dashboardUrlFromAudiences,
  ensureBackfillResultFile,
  formatBackfillNotice,
  settleBackfillDelivery,
  takeBackfillNotice,
} = require("../scripts/lib/backfill-delivery");

const OFFER = "offer-current";
const CHUNKS = path.join(
  DATA_DIR,
  "logs",
  "repositories",
  "aaaaaaaaaaaa",
  "transcripts",
  "chunks"
);

function writeState(overrides = {}) {
  writeJson(backfillState.BACKFILL_STATE_FILE, {
    schema_version: 1,
    lifecycle_id: "44444444-4444-4444-8444-444444444444",
    status: "completed",
    reason: "snapshot_queued",
    offer_id: OFFER,
    processed_transcripts: 3,
    queued_chunks: 4,
    completed_at: Date.now(),
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  });
}

// A queued chunk is a body plus its sidecar; a set-aside chunk has both
// renamed with the quarantine suffix.
function queueChunk(name, meta, { quarantined = false } = {}) {
  const suffix = quarantined ? ".quarantined" : "";
  writeFile(path.join(CHUNKS, `${name}.jsonl${suffix}`), "{}\n");
  writeJson(path.join(CHUNKS, `${name}.meta.json${suffix}`), meta);
}

beforeEach(() => {
  fs.rmSync(path.join(DATA_DIR, "logs"), { recursive: true, force: true });
  fs.rmSync(BACKFILL_RESULT_FILE, { force: true });
  fs.rmSync(path.join(DATA_DIR, ".backfill-notified"), { force: true });
});

test("counts only this offer's historical chunks, separating set-aside ones", () => {
  queueChunk("a", { promptId: "backfill", backfillOfferId: OFFER });
  queueChunk("b", { promptId: "backfill", backfillOfferId: OFFER }, { quarantined: true });
  queueChunk("c", { promptId: "backfill", backfillOfferId: "offer-other" });
  queueChunk("d", { promptId: "live" });
  // A sidecar whose body is gone is invisible to the drain, so it must not
  // hold completion back forever.
  writeJson(path.join(CHUNKS, "orphan.meta.json"), {
    promptId: "backfill",
    backfillOfferId: OFFER,
  });

  assert.deepEqual(countBackfillChunks(OFFER), { pending: 1, setAside: 1 });
});

test("does not settle while the snapshot is still running", () => {
  writeState({ status: "running", completed_at: undefined });
  assert.equal(settleBackfillDelivery(), null);
  assert.equal(fs.existsSync(BACKFILL_RESULT_FILE), false);
});

test("does not settle while any chunk of the offer is still queued", () => {
  writeState();
  queueChunk("a", { promptId: "backfill", backfillOfferId: OFFER });
  assert.equal(settleBackfillDelivery(), null);
  assert.equal(backfillState.readBackfillState().delivered_at, undefined);
});

test("settles once when every chunk was acknowledged", () => {
  writeState();
  queueChunk("other", { promptId: "backfill", backfillOfferId: "offer-other" });

  const result = settleBackfillDelivery();
  assert.equal(result.status, "delivered");
  assert.equal(result.sessions, 3);
  assert.equal(result.setAsideChunks, 0);
  assert.deepEqual(readJson(BACKFILL_RESULT_FILE), result);
  assert.ok(backfillState.readBackfillState().delivered_at);

  // A later drain must not announce the same import again.
  assert.equal(settleBackfillDelivery(), null);
});

test("reports chunks that exhausted their retries as set aside", () => {
  writeState();
  queueChunk("b", { promptId: "backfill", backfillOfferId: OFFER }, { quarantined: true });
  const result = settleBackfillDelivery();
  assert.equal(result.setAsideChunks, 1);
  assert.equal(backfillState.readBackfillState().set_aside_chunks, 1);
});

test("a partly failed snapshot still settles what it queued", () => {
  writeState({ status: "failed", reason: "snapshot_failed" });
  assert.equal(settleBackfillDelivery().status, "delivered");
});

test("nothing queued means nothing to announce", () => {
  writeState({ queued_chunks: 0 });
  assert.equal(settleBackfillDelivery(), null);
});

test("an unset sentinel yields no notice", () => {
  ensureBackfillResultFile();
  assert.deepEqual(readJson(BACKFILL_RESULT_FILE), { status: "none" });
  assert.equal(takeBackfillNotice({ audiences: [] }), null);
});

test("a failure is announced only when nothing was queued, and only once", () => {
  writeState({
    status: "failed",
    reason: "snapshot_failed",
    queued_chunks: 0,
    error: "/Users/someone/.claude/projects/x.jsonl: EACCES",
  });
  assert.equal(announceBackfillFailure("offer-other"), null);
  assert.equal(announceBackfillFailure(OFFER).status, "failed");
  assert.equal(announceBackfillFailure(OFFER), null, "already announced");

  const notice = takeBackfillNotice({ audiences: [] });
  assert.match(notice.message, /history import failed/);
  assert.match(notice.message, /\/skillmeter:backfill\b/);
  assert.doesNotMatch(notice.message, /Users|EACCES/, "stored error text is never shown");
  assert.match(notice.desktop, /import failed/i);
});

test("a failure that still queued chunks is left to the delivery notice", () => {
  writeState({ status: "failed", reason: "snapshot_failed", queued_chunks: 2 });
  assert.equal(announceBackfillFailure(OFFER), null);
  assert.equal(fs.existsSync(BACKFILL_RESULT_FILE), false);
});

test("notice wording covers full delivery, set-aside chunks and the dashboard link", () => {
  const full = formatBackfillNotice(
    { status: "delivered", sessions: 1, setAsideChunks: 0 },
    "https://acme.skillbench.ai"
  );
  assert.match(full.message, /\b1 session sent\b/);
  assert.match(full.message, /https:\/\/acme\.skillbench\.ai/);
  assert.match(full.desktop, /\b1 session sent\b/);

  const unlinked = formatBackfillNotice(
    { status: "delivered", sessions: 2, setAsideChunks: 0 },
    null
  );
  assert.match(unlinked.message, /\b2 sessions sent\b/);
  assert.doesNotMatch(unlinked.message, /https?:\/\//);

  const partial = formatBackfillNotice(
    { status: "delivered", sessions: 5, setAsideChunks: 2 },
    null
  );
  assert.match(partial.message, /\b5 sessions processed\b/);
  assert.match(partial.message, /\b2 upload chunks could not be sent\b/);
  assert.match(partial.message, /\/skillmeter:backfill status\b/);
  assert.equal(formatBackfillNotice({ status: "none" }, null), null);
});

test("the dashboard link is derived only from a tenant meter audience", () => {
  assert.equal(
    dashboardUrlFromAudiences(["https://acme.meter.skillbench.ai"]),
    "https://acme.skillbench.ai"
  );
  assert.equal(
    dashboardUrlFromAudiences(["https://acme.meter.dev.skillbench.com"]),
    "https://acme.dev.skillbench.com"
  );
  assert.equal(dashboardUrlFromAudiences(["https://collector.example.com"]), null);
  assert.equal(dashboardUrlFromAudiences(["http://acme.meter.skillbench.ai"]), null);
  assert.equal(dashboardUrlFromAudiences(["not a url"]), null);
  assert.equal(dashboardUrlFromAudiences([]), null);
});

// ---- hooks, run as Claude Code runs them: a fresh process on isolated state --

function hookEnv() {
  const stateDir = makeTempDir("skm-backfill-hook-state-");
  const dataDir = makeTempDir("skm-backfill-hook-data-");
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "BACKFILL-HOOK-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      // Reserved domain: a test must never reach a real tenant.
      aud: "https://acme.meter.skillbench.example",
      org: { login: "SkillBench-AI" },
    }),
  });
  return {
    dataDir,
    env: {
      ...process.env,
      SKILLMETER_STATE_DIR: stateDir,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CONFIG_DIR: makeTempDir("skm-backfill-hook-claude-"),
    },
  };
}

test("FileChanged hook announces a finished import once, with a desktop notification", () => {
  const { dataDir, env } = hookEnv();
  writeJson(path.join(dataDir, "backfill-result.json"), {
    status: "delivered",
    offerId: OFFER,
    sessions: 2,
    queuedChunks: 2,
    setAsideChunks: 0,
    ts: Date.now(),
  });
  const script = path.resolve(__dirname, "../scripts/on_backfill_result.js");

  const first = runNode(script, [], { env });
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.match(output.systemMessage, /\b2 sessions sent\b/);
  // The dashboard link is derived from the license's tenant meter audience.
  assert.match(output.systemMessage, /https:\/\/acme\.skillbench\.example\b/);
  // OSC 777 framing is protocol, so the prefix and terminator stay exact.
  assert.ok(output.terminalSequence.startsWith("\u001b]777;notify;SkillMeter;"));
  assert.ok(output.terminalSequence.endsWith("\u0007"));
  assert.match(output.terminalSequence, /\b2 sessions sent\b/);

  const second = runNode(script, [], { env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
});

test("SessionStart watches the sentinel and announces an import that finished offline", () => {
  const { dataDir, env } = hookEnv();
  writeJson(path.join(dataDir, "backfill-state.json"), {
    schema_version: 1,
    lifecycle_id: "55555555-5555-4555-8555-555555555555",
    status: "completed",
    reason: "snapshot_queued",
    offer_id: OFFER,
    processed_transcripts: 4,
    queued_chunks: 4,
    completed_at: Date.now(),
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  const cwd = makeTempDir("skm-backfill-hook-cwd-");
  const script = path.resolve(__dirname, "../scripts/session_start.js");
  const start = () => runNode(script, [], {
    cwd,
    env,
    input: JSON.stringify({ session_id: "backfill-hook", cwd, source: "startup" }),
  });

  const first = start();
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.ok(
    output.hookSpecificOutput.watchPaths.includes(
      path.join(dataDir, "backfill-result.json")
    )
  );
  assert.match(
    output.systemMessage,
    /history import complete: 4 sessions sent\. Open SkillMeter: https:\/\/acme\.skillbench\.example/
  );
  assert.ok(readJson(path.join(dataDir, "backfill-state.json")).delivered_at);

  const second = JSON.parse(start().stdout);
  assert.doesNotMatch(second.systemMessage || "", /history import/);
});

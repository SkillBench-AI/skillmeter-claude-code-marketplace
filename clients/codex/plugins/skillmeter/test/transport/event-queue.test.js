"use strict";
// Sealed event batches: HTTP outcome classification, atomic writes, salvage,
// the retry cap and quarantine, stale cleanup, and transcript path collection.
const { isolateHome, makeJwt, tempDir } = require("../../test-support/plugin.cjs");
// Uploads need an unexpired license; without one every transfer stops at "auth".
isolateHome({ device_id: "TEST-DEVICE", hash_salt: "deadbeef", license_jwt: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) });
delete process.env.SKILLMETER_BACKEND_URL;
const tmpData = tempDir("sk-dur-data");
process.env.PLUGIN_DATA = tmpData;
process.env.SKILLMETER_MAX_BATCH_RETRIES = "3";

const fs = require("node:fs");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const logger = require("../../scripts/logger");

const BACKEND = "https://acme.meter.skillbench.com/logs/codex";
const realFetch = global.fetch;

// Scripted {status} responses; the last entry repeats once exhausted.
function stubFetch(sequence) {
  const calls = { count: 0 };
  global.fetch = async () => {
    const i = Math.min(calls.count, sequence.length - 1);
    calls.count += 1;
    const { status } = sequence[i];
    return { ok: status >= 200 && status < 300, status };
  };
  return calls;
}

function freshDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

let seq = 0;
function sealedBatch(contents) {
  const p = path.join(logger.LOG_DIR, `events.jsonl.${Date.now() + seq++}`);
  fs.writeFileSync(p, contents);
  return p;
}

const VALID = '{"a":1}\n{"b":2}\n';

beforeEach(() => {
  freshDir(logger.LOG_DIR);
  fs.rmSync(logger.POISON_DIR, { recursive: true, force: true });
});

afterEach(() => {
  global.fetch = realFetch;
});

test("isPermanentHttpStatus: 4xx permanent except 408/429; 5xx transient", () => {
  assert.equal(logger.isPermanentHttpStatus(400), true);
  assert.equal(logger.isPermanentHttpStatus(413), true);
  assert.equal(logger.isPermanentHttpStatus(422), true);
  assert.equal(logger.isPermanentHttpStatus(408), false);
  assert.equal(logger.isPermanentHttpStatus(429), false);
  assert.equal(logger.isPermanentHttpStatus(500), false);
  assert.equal(logger.isPermanentHttpStatus(503), false);
});

test("atomicAppendLine writes one newline-terminated record per call", () => {
  const f = path.join(logger.LOG_DIR, "active.jsonl");
  logger.atomicAppendLine(f, '{"x":1}');
  logger.atomicAppendLine(f, '{"y":2}\n');
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(lines, ['{"x":1}', '{"y":2}']);
  for (const l of lines) JSON.parse(l);
});

test("atomicWriteFileSync replaces content and leaves no temp file behind", () => {
  const f = path.join(logger.LOG_DIR, "atomic.txt");
  logger.atomicWriteFileSync(f, "hello");
  assert.equal(fs.readFileSync(f, "utf8"), "hello");
  const leftovers = fs.readdirSync(logger.LOG_DIR).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("salvageBatch drops only invalid lines, and rewrites only when something was dropped and something kept", () => {
  for (const [contents, expected, remaining] of [
    ['{"a":1}\nNOT JSON\n{"b":2}\n', { rewrote: true, kept: 2, dropped: 1 }, ['{"a":1}', '{"b":2}']],
    [VALID, { rewrote: false, kept: 2, dropped: 0 }, ['{"a":1}', '{"b":2}']],
    ["garbage\nmore garbage\n", { rewrote: false, kept: 0, dropped: 2 }, ["garbage", "more garbage"]],
  ]) {
    const p = sealedBatch(contents);
    const res = logger.salvageBatch(p);
    assert.deepEqual({ rewrote: res.rewrote, kept: res.kept, dropped: res.dropped }, expected, contents);
    assert.deepEqual(fs.readFileSync(p, "utf8").split("\n").filter(Boolean), remaining);
  }
});

test("processSealedBatch marks a batch .sent on 2xx and clears its meta", async () => {
  const p = sealedBatch(VALID);
  logger.writeBatchMeta(p, { attempts: 2 });
  stubFetch([{ status: 200 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "sent");
  assert.equal(fs.existsSync(`${p}.sent`), true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.existsSync(logger.batchMetaPath(p)), false);
});

test("processSealedBatch salvages a partially-poisoned batch then succeeds", async () => {
  const p = sealedBatch('{"a":1}\nBROKEN\n{"b":2}\n');
  const calls = stubFetch([{ status: 400 }, { status: 200 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "sent");
  assert.equal(calls.count, 2, "salvage triggers exactly one retry");
  assert.equal(fs.existsSync(`${p}.sent`), true);
  assert.equal(fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))), false);
});

test("processSealedBatch quarantines an all-valid batch the server permanently rejects", async () => {
  const p = sealedBatch(VALID);
  stubFetch([{ status: 400 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "poison");
  assert.equal(fs.existsSync(p), false, "original removed from the live queue");
  assert.equal(
    fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))),
    true,
    "moved into the poison dir, not deleted"
  );
});

test("processSealedBatch retries transient failures and quarantines at the retry cap", async () => {
  const p = sealedBatch(VALID);
  stubFetch([{ status: 503 }]);
  let outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "retry");
  assert.equal(logger.readBatchMeta(p).attempts, 1);

  outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "retry");
  assert.equal(logger.readBatchMeta(p).attempts, 2);

  outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "poison");
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))), true);
  assert.equal(fs.existsSync(logger.batchMetaPath(p)), false, "meta sidecar removed on quarantine");
});

test("processSealedBatch quarantines a batch older than the max age without uploading", async () => {
  const oldTs = Date.now() - (logger.BATCH_MAX_AGE_MS + 60_000);
  const p = path.join(logger.LOG_DIR, `events.jsonl.${oldTs}`);
  fs.writeFileSync(p, VALID);
  const calls = stubFetch([{ status: 200 }]);

  const outcome = await logger.processSealedBatch(p, BACKEND, 1000);
  assert.equal(outcome, "poison");
  assert.equal(calls.count, 0, "an aged-out batch is never uploaded");
  assert.equal(fs.existsSync(path.join(logger.POISON_DIR, path.basename(p))), true);
});

test("cleanupStaleFiles prunes old .sent logs, old poison files, and orphan meta", () => {
  const old = Date.now() / 1000 - 40 * 24 * 60 * 60;

  const sent = path.join(logger.LOG_DIR, "events.jsonl.1700000000020.sent");
  fs.writeFileSync(sent, VALID);
  fs.utimesSync(sent, old, old);

  fs.mkdirSync(logger.POISON_DIR, { recursive: true });
  const poison = path.join(logger.POISON_DIR, "events.jsonl.1700000000021");
  fs.writeFileSync(poison, VALID);
  fs.utimesSync(poison, old, old);

  const orphanMeta = path.join(logger.LOG_DIR, "events.jsonl.1700000000022.meta");
  fs.writeFileSync(orphanMeta, '{"attempts":1}\n');
  fs.utimesSync(orphanMeta, old, old);

  const freshSent = path.join(logger.LOG_DIR, "events.jsonl.1700000000023.sent");
  fs.writeFileSync(freshSent, VALID);

  logger.cleanupStaleFiles();

  assert.equal(fs.existsSync(sent), false, "old .sent pruned");
  assert.equal(fs.existsSync(poison), false, "old poison pruned");
  assert.equal(fs.existsSync(orphanMeta), false, "orphan meta pruned");
  assert.equal(fs.existsSync(freshSent), true, "fresh .sent retained");
});

test("transcript staging without a signed-in scope retains the source and creates no queue", () => {
  const source = path.join(tmpData, "no-consent.jsonl");
  fs.writeFileSync(source, VALID);
  assert.equal(logger.stageTranscriptForUpload(source), null);
  assert.equal(fs.readFileSync(source, "utf8"), VALID);
  assert.equal(logger.listPendingTranscripts().length, 0);
});

test("collectTranscriptPaths includes both subagent and session transcripts", () => {
  const sessionTranscript = path.join(tmpData, "session.jsonl");
  const agentTranscript = path.join(tmpData, "agent.jsonl");
  fs.writeFileSync(sessionTranscript, '{"type":"session"}\n');
  fs.writeFileSync(agentTranscript, '{"type":"agent"}\n');

  const paths = logger.collectTranscriptPaths({
    transcript_path: sessionTranscript,
    agent_transcript_path: agentTranscript,
  });

  assert.deepEqual(paths, [
    path.resolve(agentTranscript),
    path.resolve(sessionTranscript),
  ]);
});

test("collectTranscriptPaths falls back to Codex session store by session id", () => {
  const sessionId = "019edc5e-ac83-72f0-bdff-1f819107926a";
  const sessionsDir = path.join(tmpData, "codex-home", "sessions");
  const datedDir = path.join(sessionsDir, "2026", "06", "18");
  fs.mkdirSync(datedDir, { recursive: true });
  const transcript = path.join(
    datedDir,
    `rollout-2026-06-18T15-14-12-${sessionId}.jsonl`
  );
  fs.writeFileSync(transcript, '{"type":"session_meta"}\n');

  const paths = logger.collectTranscriptPaths(
    {
      session_id: sessionId,
      transcript_path: null,
      agent_transcript_path: null,
    },
    { sessionsDir }
  );

  assert.deepEqual(paths, [path.resolve(transcript)]);
});

test("collectTranscriptPaths fallback can match session_meta payload id", () => {
  const sessionId = "019edc5e-ac83-72f0-bdff-1f819107926a";
  const sessionsDir = path.join(tmpData, "codex-home-meta", "sessions");
  const datedDir = path.join(sessionsDir, "2026", "06", "18");
  fs.mkdirSync(datedDir, { recursive: true });
  const transcript = path.join(datedDir, "rollout-without-id.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId },
    }) + "\n"
  );

  const paths = logger.collectTranscriptPaths(
    {
      session_id: sessionId,
      transcript_path: null,
      agent_transcript_path: null,
    },
    { sessionsDir }
  );

  assert.deepEqual(paths, [path.resolve(transcript)]);
});

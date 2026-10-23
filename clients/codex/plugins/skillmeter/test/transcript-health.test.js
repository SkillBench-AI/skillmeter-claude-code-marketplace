"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const queue = require("../scripts/lib/transcript-delta");
const health = require("../scripts/lib/transcript-health");
const { inventory } = require("../scripts/transcript_inventory");
function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "capture-health-"));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const root = path.join(data, "logs/transcripts/chunks-v1"), source = path.join(data, "source.jsonl");
  const scope = { owner: "synthetic", deviceId: "synthetic", cwd: "/synthetic", org: "synthetic" };
  const stage = () => queue.stage(root, source, scope, "synthetic", { maxEnvelope: queue.ENVELOPE_RESERVE + 1000 });
  const dir = path.join(root, queue.hmac("synthetic", source));
  const line = content => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: content } }) + "\n";
  return { data, root, source, dir, stage, line };
}

test("stage recovery resolves only capture diagnostics and retains independent delivery failure", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, f.line(crypto.randomBytes(4000).toString("base64")));
  assert.throws(f.stage, /oversized-single-record/);
  const failed = health.inspect(f.dir).capture;
  assert.equal(failed.activeFailure.code, "oversized-single-record");
  assert.equal(failed.capturedBytes, 0);
  queue.recordFailure(f.dir, "delivery", "http-503", { seq: 1 });
  fs.writeFileSync(f.source, f.line("small synthetic record"));
  f.stage();
  const recovered = health.inspect(f.dir);
  assert.equal(recovered.capture.activeFailure, null);
  assert.equal(recovered.capture.lastFailure.code, "oversized-single-record");
  assert.notEqual(recovered.capture.attemptId, failed.attemptId);
  assert.equal(recovered.capture.capturedBytes, fs.statSync(f.source).size);
  assert.deepEqual(recovered.failures.map(f => f.code), ["http-503"]);
  await queue.drainDirectory(f.dir, async () => "sent");
  const delivered = health.inspect(f.dir);
  assert.deepEqual(delivered.failures, []);
  assert.equal(delivered.delivery.acknowledgedSeq, 1);
  assert.equal(delivered.delivery.lastFailure.code, "http-503");
  assert.deepEqual(inventory(f.data).chunkDiagnostics, {});
  assert.equal(inventory(f.data).downstream, "unknown");
});

test("successful delivery never clears a capture stall and a new retry does not inherit an old HTTP error", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, f.line("first")); f.stage();
  fs.appendFileSync(f.source, f.line(crypto.randomBytes(4000).toString("base64")));
  assert.throws(f.stage, /oversized-single-record/);
  queue.recordFailure(f.dir, "delivery", "http-401", { seq: 1 });
  await queue.drainDirectory(f.dir, async () => "retry");
  assert.equal(health.inspect(f.dir).delivery.activeFailure.code, "delivery-retry");
  await queue.drainDirectory(f.dir, async () => "sent");
  assert.equal(queue.pendingFiles(f.dir).length, 0);
  assert.deepEqual(health.inspect(f.dir).failures.map(f => f.code), ["oversized-single-record"]);
});

test("older diagnostics survive until the corresponding phase succeeds, including EOF recovery", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, f.line("first")); f.stage();
  fs.rmSync(path.join(f.dir, "capture-status.json"));
  fs.writeFileSync(path.join(f.dir, "diagnostic.json"), JSON.stringify({ code: "oversized-single-record", at: "2026-01-01T00:00:00Z" }));
  assert.equal(inventory(f.data).chunkDiagnostics["oversized-single-record"], 1);
  assert.equal(f.stage().status, "unchanged");
  assert.deepEqual(inventory(f.data).chunkDiagnostics, {});
  const legacy = JSON.parse(fs.readFileSync(path.join(f.dir, "diagnostic.json")));
  assert.equal(legacy.code, "oversized-single-record");
  assert.ok(legacy.resolvedAt);
  fs.writeFileSync(path.join(f.dir, "delivery-status.json"), "broken synthetic state");
  assert.ok(health.inspect(f.dir).failures.some(f => f.code === "status-unreadable"));
});

test("a delivery attempt after upgrade cannot overwrite a legacy-only capture failure", t => {
  const f = fixture(t);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(path.join(f.dir, "diagnostic.json"), JSON.stringify({ code: "oversized-single-record", at: "2026-01-01T00:00:00Z" }));
  queue.recordFailure(f.dir, "delivery", "http-503", { seq: 1 });
  assert.deepEqual(health.inspect(f.dir).failures.map(f => f.code).sort(), ["http-503", "oversized-single-record"]);
  health.update(f.dir, "delivery", null, { acknowledgedSeq: 1 }, queue.writeDurable);
  assert.deepEqual(health.inspect(f.dir).failures.map(f => f.code), ["oversized-single-record"]);
});

test("wrong-shaped status is unknown rather than a healthy observation", t => {
  const f = fixture(t);
  fs.mkdirSync(f.dir, { recursive: true });
  for (const value of [{}, { version: 1, phase: "capture", activeFailure: null }, { version: 1, phase: "capture", lastAttemptAt: "2026-01-01T00:00:00Z", activeFailure: null, lastSuccessAt: "2026-01-01T00:00:00Z", capturedBytes: -1 }]) {
    fs.writeFileSync(path.join(f.dir, "capture-status.json"), JSON.stringify(value));
    assert.equal(health.inspect(f.dir).capture.unreadable, true);
    assert.deepEqual(health.inspect(f.dir).failures.map(f => f.code), ["status-unreadable"]);
  }
});

test("a failing diagnostics write does not mask the capture error", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, f.line(crypto.randomBytes(4000).toString("base64")));
  const update = health.update;
  health.update = (dir, phase, code, ...rest) => {
    if (code) throw new Error("synthetic status write failure");
    return update(dir, phase, code, ...rest);
  };
  try {
    assert.throws(f.stage, /oversized-single-record/);
  } finally {
    health.update = update;
  }
  assert.equal(health.inspect(f.dir).capture, null, "no status was recorded, and nothing else was thrown");
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const queue = require("../../scripts/lib/transcript-delta");
const scope = { owner: "synthetic", deviceId: "synthetic", cwd: "/synthetic", org: "synthetic", consentStamp: "synthetic-stamp" };
const salt = "synthetic-salt";
const line = r => JSON.stringify(r) + "\n";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-projection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.jsonl"), queueRoot = path.join(root, "queue");
  const history = Array.from({ length: 8 }, (_, i) => ({ type: "message", role: i % 2 ? "assistant" : "user", content: crypto.randomBytes(800).toString("base64") }));
  const before = history.map(payload => ({ type: "response_item", payload }));
  const unique = { type: "compaction", content: "new summary alice@example.com" };
  const compacted = { type: "compacted", timestamp: "2026-09-26T00:00:00Z", payload: { window_id: "synthetic-window", replacement_history: [...history, unique], guardian_history: history, retained_context: { incomplete: false } } };
  const after = { type: "event_msg", payload: { type: "user_message", message: "after compaction" } };
  const bytes = [...before, compacted, after].map(line).join("");
  fs.writeFileSync(source, bytes);
  const stage = (options = {}) => queue.stage(queueRoot, source, scope, salt, { maxEnvelope: queue.ENVELOPE_RESERVE + 2400, ...options });
  const read = files => files.flatMap(f => zlib.gunzipSync(fs.readFileSync(f)).toString().trim().split("\n").map(JSON.parse));
  return { source, queueRoot, before, compacted, after, stage, read, bytes };
}

test("bounded compaction references only exact prior history, retaining unmatched context and record order", t => {
  const f = fixture(t), result = f.stage(), records = f.read(result.files);
  assert.equal(result.cursor.offset, Buffer.byteLength(f.bytes));
  assert.equal(records.length, 10);
  const compacted = records[8];
  assert.equal(compacted.timestamp, f.compacted.timestamp);
  assert.equal(compacted.payload.window_id, "synthetic-window");
  assert.deepEqual(compacted.payload.retained_context, { incomplete: false });
  for (const field of ["replacement_history", "guardian_history"]) {
    assert.equal(compacted._codex_compaction_projection.fields[field].referenced_entries, 8);
    for (let i = 0; i < 8; i++) {
      assert.deepEqual(compacted.payload[field][i], { type: "skillmeter_compaction_reference", source_uuid: records[i].uuid, pointer: "/payload" });
    }
  }
  assert.equal(compacted.payload.replacement_history[8].content, "new summary [EMAIL]");
  assert.deepEqual(records[9].payload, f.after.payload);
  for (const file of result.files) assert.ok(4 * Math.ceil(fs.statSync(file).size / 3) + queue.ENVELOPE_RESERVE <= queue.ENVELOPE_RESERVE + 2400);
  assert.equal(fs.readFileSync(f.source, "utf8"), f.bytes);
  assert.equal(f.stage().status, "unchanged");
});

for (const point of ["before-publish", "after-publish", "after-cursor"]) {
  test(`compaction crash recovery at ${point} preserves identities and retry bodies`, async t => {
    const f = fixture(t);
    assert.throws(() => f.stage({ fault: at => { if (at === point) throw new Error("synthetic crash"); } }));
    f.stage();
    const dir = queue.queueDirectories(f.queueRoot)[0], attempts = [];
    await queue.drainDirectory(dir, async (meta, body) => { attempts.push({ meta, body }); return "retry"; });
    await queue.drainDirectory(dir, async (meta, body) => { attempts.push({ meta, body }); return "sent"; });
    assert.deepEqual(attempts[0], attempts[1]);
    const records = attempts.slice(1).flatMap(a => zlib.gunzipSync(a.body).toString().trim().split("\n").map(JSON.parse));
    assert.equal(records.length, 10);
    assert.equal(new Set(records.map(r => r.uuid)).size, 10);
    assert.equal(records[8].payload.guardian_history[0].source_uuid, records[0].uuid);
    assert.equal(queue.pendingFiles(dir).length, 0);
  });
}

test("references work across stage boundaries and restart", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, f.before.map(line).join(""));
  const first = f.stage();
  fs.appendFileSync(f.source, line(f.compacted) + line(f.after));
  const next = f.stage();
  assert.equal(f.read(next.files)[0].payload.guardian_history[0].source_uuid, f.read(first.files)[0].uuid);
  assert.equal(next.cursor.generation, first.cursor.generation);
});

test("excluded prior history cannot become a reference target", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, f.before.map(line).join(""));
  queue.observeConsent(f.queueRoot, f.source, scope, salt, true, "synthetic-stamp");
  fs.appendFileSync(f.source, line(f.compacted) + line(f.after));
  const consent = queue.observeConsent(f.queueRoot, f.source, scope, salt, true, "synthetic-stamp");
  assert.throws(() => f.stage({ consent }), /oversized-single-record/);
  assert.equal(fs.existsSync(path.join(queue.queueDirectories(f.queueRoot)[0], "cursor.json")), false);
});

test("unmatched oversized compaction and authored records remain recoverable in the untouched source", t => {
  const f = fixture(t);
  for (const record of [f.compacted, { type: "response_item", payload: { type: "function_call_output", call_id: "synthetic-call", output: crypto.randomBytes(6000).toString("base64") } }]) {
    fs.writeFileSync(f.source, line(record));
    assert.throws(() => f.stage(), /oversized-single-record/);
    assert.equal(fs.readFileSync(f.source, "utf8"), line(record));
    assert.equal(fs.existsSync(path.join(queue.queueDirectories(f.queueRoot)[0], "cursor.json")), false);
  }
});

test("already deliverable compaction stays inline, including opaque tool input", t => {
  const f = fixture(t);
  const tool = { type: "custom_tool_call", input: crypto.randomBytes(8000).toString("base64") };
  fs.writeFileSync(f.source, line({ type: "response_item", payload: tool }) + line({ type: "compacted", payload: { guardian_history: [tool] } }));
  const records = f.read(f.stage().files);
  assert.equal(records[1]._codex_compaction_projection, undefined);
  assert.equal(records[1].payload.guardian_history[0].type, "custom_tool_call");
  assert.ok(records[1].payload.guardian_history[0].input.length < 100);
});

test("projection retains entries whose sanitized form is smaller than a reference", t => {
  const f = fixture(t);
  const tool = { type: "custom_tool_call", input: crypto.randomBytes(8000).toString("base64") };
  const before = [{ type: "response_item", payload: tool }, ...f.before];
  const compacted = { ...f.compacted, payload: { ...f.compacted.payload, guardian_history: [tool, ...f.compacted.payload.guardian_history] } };
  fs.writeFileSync(f.source, before.map(line).join("") + line(compacted));
  const records = f.read(f.stage().files), last = records.at(-1);
  assert.equal(last._codex_compaction_projection.fields.guardian_history.referenced_entries, 8);
  assert.equal(last.payload.guardian_history[0].type, "custom_tool_call");
  assert.ok(last.payload.guardian_history[0].input.length < 100);
});

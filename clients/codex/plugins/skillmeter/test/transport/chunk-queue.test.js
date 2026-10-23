"use strict";
// The durable chunk queue: cursors, resets, wire budget, locking, session
// identity in later chunks, and recovery after a killed process.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { chunkQueue, transcriptLine: line, tempDir } = require("../../test-support/plugin.cjs");
const queue = require("../../scripts/lib/transcript-delta");
const modulePath = require.resolve("../../scripts/lib/transcript-delta");

const scope = { deviceId: "SYNTHETIC", owner: "fixture-owner", cwd: "/synthetic", org: "synthetic" };
const fixture = t => chunkQueue(t, { scope });

test("append cursor retains identical raw records, partial tails and redaction collisions", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("repeat") + line("repeat") + '{"type":');
  const first = f.stage();
  assert.equal(first.cursor.offset, Buffer.byteLength(line("repeat")) * 2);
  const initial = f.records(first.files);
  assert.equal(initial.length, 2);
  assert.notEqual(initial[0].uuid, initial[1].uuid);
  assert.equal(f.stage().status, "unchanged");
  fs.appendFileSync(f.source, '"event_msg","payload":{"type":"token_count"}}\n');
  const next = f.stage();
  assert.equal(next.cursor.seq, 2);
  assert.equal(next.cursor.baseline, 1);
  assert.equal(f.records(next.files).length, 1);
  fs.appendFileSync(f.source, line("alice@example.com") + line("bob@example.com"));
  const redacted = f.records(f.stage().files);
  assert.deepEqual(redacted[0].payload, redacted[1].payload);
  assert.notEqual(redacted[0].uuid, redacted[1].uuid);
});

test("rewrites and replacement reset monotonically; later normal chunks carry the reset generation", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("old"));
  const one = f.stage();
  fs.writeFileSync(f.source, line("new"));
  const reset = f.stage();
  assert.equal(reset.cursor.baseline, 2);
  assert.equal(reset.cursor.generation, 2);
  fs.appendFileSync(f.source, line("continued"));
  const next = f.stage();
  assert.equal(queue.metadata(next.files[0]).reset, 2);
  assert.equal(next.cursor.seq, 3);
  fs.renameSync(f.source, f.source + ".old");
  fs.writeFileSync(f.source, line("replacement"));
  assert.equal(f.stage().cursor.baseline, 4);
  assert.equal(f.records(one.files)[0].payload.content, "old", "staging never overwrites pending bodies");
});

test("a lost response retries a byte-identical body, sequence and reset before later chunks", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("one"));
  f.stage();
  fs.appendFileSync(f.source, line("two"));
  f.stage();
  const dir = queue.queueDirectories(f.root)[0], attempts = [];
  await queue.drainDirectory(dir, async (meta, body) => { attempts.push({ meta, body }); return "retry"; });
  assert.equal(attempts.length, 1);
  assert.equal(queue.pendingFiles(dir).length, 2);
  await queue.drainDirectory(dir, async (meta, body) => { attempts.push({ meta, body }); return "sent"; });
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts.map(a => a.meta.seq), [1, 1, 2]);
  assert.equal(queue.pendingFiles(dir).length, 0);
  fs.appendFileSync(f.source, line("three"));
  assert.equal(f.stage().cursor.seq, 3);
});

test("one effective drain sequence prevents staging and a second sender while a request is open", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("one"));
  const first = f.stage();
  let resolve; const response = new Promise(r => { resolve = r; });
  let opened; const requestOpened = new Promise(r => { opened = r; });
  const dir = queue.queueDirectories(f.root)[0];
  const drain = queue.drainDirectory(dir, async () => { opened(); await response; return "sent"; });
  await requestOpened;
  fs.appendFileSync(f.source, line("two"));
  assert.equal(f.stage().status, "busy");
  assert.equal(await queue.drainDirectory(dir, () => assert.fail("second sender")), 0);
  resolve();
  await drain;
  assert.equal(f.stage().cursor.seq, 2);
  assert.equal(fs.existsSync(first.files[0]), false);
});

test("a dead staging owner recovers on restart; an old live lock is never stolen", t => {
  const f = fixture(t), lock = path.join(f.dir, "lock");
  const child = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(modulePath)}).acquireLock(process.argv[1]);`, lock]);
  assert.equal(child.status, 0);
  const release = queue.acquireLock(lock);
  assert.equal(typeof release, "function");
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal(queue.acquireLock(lock), null);
  release();
});

test("a lock released between the exclusive-link failure and inspection is retried", t => {
  const f = fixture(t);
  const lock = path.join(f.dir, "lock");
  const release = queue.acquireLock(lock);
  const link = fs.linkSync;
  let raced = false;
  fs.linkSync = function (source, destination) {
    if (destination === lock && !raced) {
      raced = true;
      release();
      throw Object.assign(new Error("synthetic concurrent release"), { code: "EEXIST" });
    }
    return link.call(this, source, destination);
  };
  try {
    const acquired = queue.acquireLock(lock);
    assert.equal(typeof acquired, "function");
    acquired();
  } finally {
    fs.linkSync = link;
  }
});

test("the real gzip/base64 wire budget splits records and rejects an oversized single record without a cursor", t => {
  const f = fixture(t), limit = queue.ENVELOPE_RESERVE + 1200;
  const records = Array.from({ length: 8 }, () => line(crypto.randomBytes(500).toString("base64")));
  fs.writeFileSync(f.source, records.join(""));
  const result = f.stage({ maxEnvelope: limit });
  assert.ok(result.files.length > 1);
  for (const file of result.files) assert.ok(4 * Math.ceil(fs.statSync(file).size / 3) + queue.ENVELOPE_RESERVE <= limit);
  assert.equal(f.records(result.files).length, 8);
  const before = result.cursor.seq;
  fs.appendFileSync(f.source, line(crypto.randomBytes(3000).toString("base64")));
  assert.throws(() => f.stage({ maxEnvelope: limit }), /oversized-single-record/);
  const dir = queue.queueDirectories(f.root)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cursor.json"))).seq, before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "diagnostic.json"))).code, "oversized-single-record");
});

test("malformed complete lines retain the cursor; unsupported envelope bytes stay available to the parser", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("one"));
  const first = f.stage();
  fs.appendFileSync(f.source, "malformed synthetic line\n");
  assert.throws(() => f.stage(), /malformed-complete-record/);
  const dir = queue.queueDirectories(f.root)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cursor.json"))).offset, first.cursor.offset);
  fs.writeFileSync(f.source, line("one") + '{"type":"future-envelope"}\n');
  assert.equal(f.records(f.stage().files)[0].type, "future-envelope");
});

test("bounded capture resumes from the last complete raw position", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, Array.from({ length: 10000 }, (_, i) => line(String(i))).join(""));
  const all = [];
  for (let i = 0; i < 100; i++) {
    const result = f.stage({ stageBytes: 1000 });
    if (!result.files.length) break;
    all.push(...f.records(result.files));
  }
  assert.equal(all.length, 10000);
  assert.equal(new Set(all.map(r => r.uuid)).size, 10000);
});

test("queued tool pairs preserve linkage and sanitize JSON arguments before gzip", t => {
  const f = fixture(t);
  const input = [
    { type: "response_item", uuid: "synthetic-source-call", payload: { type: "function_call", name: "read_file", call_id: "synthetic-call",
      arguments: JSON.stringify({ file_path: "/private/undisclosed/src/customer.ts", password: "synthetic-password", note: "用户@example.com" }) },
      _sanitization: { policyVersion: "3.1.0", secrets: 0 } },
    { type: "response_item", uuid: "synthetic-source-result", payload: { type: "function_call_output", call_id: "synthetic-call", output: "contact 用户@example.com" } },
  ];
  fs.writeFileSync(f.source, input.map(JSON.stringify).join("\n") + "\n");
  const records = f.records(f.stage().files);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r._codex_source_uuid), input.map(r => r.uuid));
  assert.equal(records[0].payload.call_id, records[1].payload.call_id);
  const args = JSON.parse(records[0].payload.arguments);
  assert.match(args.file_path, /^\/[a-f0-9]{12}\/[a-f0-9]{12}\/src\/[a-f0-9]{12}\.ts$/);
  assert.equal(args.password, "[REDACTED_SECRET]");
  assert.equal(args.note, "[EMAIL]");
  assert.equal(records[1].payload.output, "contact [EMAIL]");
  assert.equal(records[0]._sanitization.secrets, 1);
  assert.equal(records[0]._sanitization.counts.path, 3);
  assert.equal(records[0]._sanitization.counts.email, 1);
  assert.equal(JSON.stringify(records).includes("synthetic-password"), false);
  assert.equal(f.stage().status, "unchanged");
});

// Session identity: every wire chunk after the first opens with a continuation record.
const consentScope = { ...scope, consentStamp: "synthetic-consent" };
const meta = JSON.stringify({ type: "session_meta", timestamp: "2026-09-01T00:00:00.000Z", payload: {
  id: "thread-1", cwd: "/synthetic", originator: "codex_cli_rs", instructions: "private startup context", cli_version: "0.1.0" } }) + "\n";
function session(t) {
  const f = chunkQueue(t, { scope: consentScope });
  const consent = () => f.observe(true, "synthetic-consent");
  return {
    ...f,
    stage: opts => f.stage({ consent: consent(), preserveSessionMetadata: true, ...opts }),
    // The startup record is written before opt-in, as in a live session.
    start: first => { fs.writeFileSync(f.source, first); consent(); },
  };
}
function noisyLine(day) {
  const content = Array.from({ length: 50 }, (_, i) => crypto.createHash("sha256").update(`synthetic-${day}-${i}`).digest("hex")).join(" ");
  return JSON.stringify({ type: "response_item", timestamp: `2026-09-${day}T00:00:00Z`, payload: { type: "message", role: "user", content } }) + "\n";
}

test("continuation identity survives a startup record spanning multiple read buffers", t => {
  const f = session(t);
  const header = JSON.parse(meta);
  header.payload.instructions = "private startup context ".repeat(10000);
  header.payload.parent_thread_id = "parent-at-end";
  f.start(JSON.stringify(header) + "\n");
  fs.appendFileSync(f.source, line("first"));
  const first = f.records(f.stage().files)[0];
  fs.appendFileSync(f.source, line("second"));
  const later = f.records(f.stage().files);
  assert.deepEqual(later.map(r => r.type), ["session_continuation", "response_item"]);
  assert.deepEqual(later[0].payload, first.payload);
  assert.equal(later[0].payload.parent_thread_id, "parent-at-end");
  assert.equal(later[1].payload.content, "second");
  assert.ok(!JSON.stringify(later).includes("private startup context"));
});

test("batches staged past the file start open with the session's routing identity", t => {
  const f = session(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  const first = f.records(f.stage().files);
  assert.deepEqual(first.map(r => r.type), ["session_meta", "response_item"]);
  fs.appendFileSync(f.source, line("second"));
  const second = f.records(f.stage().files);
  assert.deepEqual(second.map(r => r.type), ["session_continuation", "response_item"]);
  const [header] = first, [continuation] = second;
  assert.deepEqual(Object.keys(continuation.payload).sort(), ["cwd", "id", "originator"]);
  assert.equal(continuation.payload.id, header.payload.id);
  assert.equal(continuation.payload.cwd, header.payload.cwd);
  assert.equal(continuation.timestamp, undefined);
  assert.ok(!JSON.stringify(second).includes("private startup context"));
  fs.appendFileSync(f.source, line("third"));
  const third = f.records(f.stage().files);
  assert.equal(third[0].type, "session_continuation");
  assert.equal(third[0].uuid, continuation.uuid);
  assert.notEqual(third[0].uuid, header.uuid);
});

test("identity never ships alone, only when session metadata is preserved, and only after a session_meta record", t => {
  const f = session(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  f.stage();
  assert.equal(f.stage().status, "unchanged");
  fs.appendFileSync(f.source, line("second"));
  assert.deepEqual(f.records(f.stage({ preserveSessionMetadata: false }).files).map(r => r.type), ["response_item"]);
  const g = session(t);
  g.start(line("before opt-in"));
  fs.appendFileSync(g.source, line("first"));
  g.stage();
  fs.appendFileSync(g.source, line("second"));
  assert.deepEqual(g.records(g.stage().files).map(r => r.payload.content), ["second"], "content-only without session_meta");
});

test("a reset restarts from the first record; later batches carry the new generation's identity", async t => {
  const f = session(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  f.stage();
  fs.appendFileSync(f.source, line("second"));
  const previous = f.records(f.stage().files)[0];
  await queue.drainDirectory(queue.queueDirectories(f.root)[0], async () => "reset-required");
  assert.deepEqual(f.records(f.stage().files).map(r => r.type), ["session_meta", "response_item", "response_item"]);
  fs.appendFileSync(f.source, line("third"));
  const next = f.records(f.stage().files)[0];
  assert.equal(next.type, "session_continuation");
  assert.notEqual(next.uuid, previous.uuid);
});

test("the continuation is authorized like the first record", t => {
  const f = session(t);
  f.start(meta);
  fs.appendFileSync(f.source, line("first"));
  f.stage();
  fs.appendFileSync(f.source, line("second"));
  assert.throws(() => f.stage({ authorizeRecord: r => r.type !== "session_continuation" }), /source-scope-changed/);
});

for (const laterBatch of [false, true]) {
  test(`a split ${laterBatch ? "continuation" : "initial"} batch repeats identity in every wire chunk`, t => {
    const f = session(t);
    f.start(meta);
    if (laterBatch) { fs.appendFileSync(f.source, line("first")); f.stage(); }
    fs.appendFileSync(f.source, noisyLine("03") + noisyLine("07"));
    const result = f.stage({ maxEnvelope: queue.ENVELOPE_RESERVE + 3000 });
    const chunks = result.files.map(file => f.records([file]));
    assert.equal(chunks.length, 2);
    for (const [i, rows] of chunks.entries()) {
      assert.equal(rows[0].type, !laterBatch && i === 0 ? "session_meta" : "session_continuation");
      assert.equal(rows.length, 2, "header stays with its content; no header-only chunk");
      assert.equal(rows[1].type, "response_item");
      assert.equal(rows[0].payload.id, "thread-1");
      if (rows[0].type === "session_continuation") assert.equal(rows[0].timestamp, undefined);
      const bytes = fs.readFileSync(result.files[i]);
      assert.ok(4 * Math.ceil(bytes.length / 3) + queue.ENVELOPE_RESERVE <= queue.ENVELOPE_RESERVE + 3000);
    }
    if (laterBatch) assert.equal(chunks[0][0].uuid, chunks[1][0].uuid);
  });
}

test("a wire budget that cannot fit identity plus one record does not advance capture", t => {
  const f = session(t);
  f.start(meta);
  fs.appendFileSync(f.source, noisyLine("03"));
  assert.throws(() => f.stage({ maxEnvelope: queue.ENVELOPE_RESERVE + 2300 }), /oversized-single-record/);
  assert.deepEqual(f.records(f.stage({ maxEnvelope: queue.ENVELOPE_RESERVE + 3000 }).files).map(r => r.type), ["session_meta", "response_item"]);
});

// Crash durability with real killed processes.
const raw = '{"type":"response_item","payload":{"type":"message","role":"user","content":"survive termination"}}\n';
const killScope = { deviceId: "SYNTHETIC", owner: "synthetic-owner" };
function killable(t) {
  const root = tempDir("codex-kill");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, raw);
  return { root: path.join(root, "queue"), source };
}

for (const point of ["before-publish", "after-publish", "after-cursor"]) {
  test(`SIGKILL at ${point} recovers durable data without finally cleanup`, async t => {
    const f = killable(t);
    const child = spawnSync(process.execPath, ["-e", `
      const queue = require(process.argv[1]);
      queue.stage(process.argv[2], process.argv[3], JSON.parse(process.argv[4]), "salt", {
        fault(point) { if (point === process.argv[5]) process.kill(process.pid, "SIGKILL"); }
      });
    `, modulePath, f.root, f.source, JSON.stringify(killScope), point]);
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    const dir = queue.queueDirectories(f.root)[0];
    assert.ok(fs.existsSync(path.join(dir, "lock")), "the killed process leaves its lock");
    if (point === "before-publish") assert.equal(fs.readdirSync(dir).filter(name => name.startsWith(".stage-")).length, 1);
    queue.stage(f.root, f.source, killScope, "salt");
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith(".stage-")), [], "unpublished crash artifacts are reaped");
    const sent = [];
    await queue.drainDirectory(dir, async (meta, body) => {
      sent.push({ meta, records: zlib.gunzipSync(body).toString().trim().split("\n").map(JSON.parse) });
      return "sent";
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].meta.seq, 1);
    assert.equal(sent[0].records.length, 1);
    assert.deepEqual(sent[0].records[0].payload, JSON.parse(raw).payload);
    assert.equal(queue.pendingFiles(dir).length, 0);
  });
}

test("SIGKILL after remote acceptance replays identical bytes and metadata", async t => {
  const f = killable(t);
  queue.stage(f.root, f.source, killScope, "salt");
  const dir = queue.queueDirectories(f.root)[0];
  const accepted = path.join(path.dirname(f.source), "accepted.json");
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs"), queue = require(process.argv[1]);
    queue.drainDirectory(process.argv[2], async (meta, body) => {
      fs.writeFileSync(process.argv[3], JSON.stringify({meta, body: body.toString("base64")}));
      process.kill(process.pid, "SIGKILL");
    });
  `, modulePath, dir, accepted]);
  assert.equal(child.signal, "SIGKILL", child.stderr.toString());
  const previous = JSON.parse(fs.readFileSync(accepted));
  let attempts = 0;
  await queue.drainDirectory(dir, async (meta, body) => {
    attempts++;
    assert.deepEqual({ meta, body: body.toString("base64") }, previous);
    return "sent";
  });
  assert.equal(attempts, 1);
  assert.equal(queue.pendingFiles(dir).length, 0);
});

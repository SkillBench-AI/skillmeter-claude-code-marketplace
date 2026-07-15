// Run: node --test skillmeter/test/transcript-delta.test.js
//
// Pure-core coverage for the uuid-cursor delta upload, plus a few real-tmpdir
// round-trips for the transfer.js chunk/cursor persistence. Follows the repo's
// no-mock convention: pure functions on plain objects + throwaway temp dirs.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

// transfer.js reads its dirs from CLAUDE_PLUGIN_DATA at require time, so point
// it at a throwaway dir BEFORE requiring it.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skm-delta-"));
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR;

const d = require("../scripts/lib/transcript-delta");
const transfer = require("../scripts/lib/transfer");

const SALT = "deadbeefcafe";

// ---- helpers ---------------------------------------------------------------
function content(uuid, parentUuid = null, text = "hi") {
  return { type: "assistant", uuid, parentUuid, message: { content: text } };
}
function meta(type = "mode") {
  return { type }; // metadata lines have no uuid
}
function toJsonl(objs) {
  return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

// ---- parseJsonl ------------------------------------------------------------
test("parseJsonl: parses valid lines, skips blanks", () => {
  const raw = toJsonl([content("a"), content("b")]);
  const { objs, malformed } = d.parseJsonl(raw);
  assert.equal(objs.length, 2);
  assert.equal(malformed, 0);
  assert.equal(objs[0].uuid, "a");
});

test("parseJsonl: trailing partial line counts as malformed, earlier lines intact", () => {
  const raw = JSON.stringify(content("a")) + "\n" + '{"type":"assistant","uuid":"b"'; // truncated
  const { objs, malformed } = d.parseJsonl(raw);
  assert.equal(objs.length, 1);
  assert.equal(objs[0].uuid, "a");
  assert.equal(malformed, 1);
});

test("parseJsonl: mid-file malformed line is skipped, not fatal", () => {
  const raw = JSON.stringify(content("a")) + "\n" + "{bad json}\n" + JSON.stringify(content("c")) + "\n";
  const { objs, malformed } = d.parseJsonl(raw);
  assert.deepEqual(objs.map((o) => o.uuid), ["a", "c"]);
  assert.equal(malformed, 1);
});

// ---- lastContentUuid -------------------------------------------------------
test("lastContentUuid: returns newest uuid", () => {
  assert.equal(d.lastContentUuid([content("a"), content("b"), content("c")]), "c");
});

test("lastContentUuid: skips trailing metadata lines", () => {
  assert.equal(d.lastContentUuid([content("a"), meta("mode"), meta("permission-mode")]), "a");
});

test("lastContentUuid: null when no content line", () => {
  assert.equal(d.lastContentUuid([meta("mode"), meta("last-prompt")]), null);
});

// ---- computeDelta ----------------------------------------------------------
test("computeDelta: no cursor -> full, no reset", () => {
  assert.deepEqual(d.computeDelta([content("a")], null), { startIndex: 0, reset: false });
});

test("computeDelta: known cursor uuid -> slice after it", () => {
  const objs = [content("a"), content("b"), content("c")];
  assert.deepEqual(d.computeDelta(objs, { lastUuid: "b" }), { startIndex: 2, reset: false });
});

test("computeDelta: unknown cursor uuid -> reset from 0", () => {
  const objs = [content("a"), content("b")];
  assert.deepEqual(d.computeDelta(objs, { lastUuid: "gone" }), { startIndex: 0, reset: true });
});

// ---- splitLinesByBudget ----------------------------------------------------
test("splitLinesByBudget: groups within budget, no line loss", () => {
  const lines = ["aaaa", "bbbb", "cccc"]; // 5 bytes each incl newline
  const groups = d.splitLinesByBudget(lines, 10); // 2 lines per group
  assert.equal(groups.flat().length, 3);
  assert.ok(groups.every((g) => g.join("\n").length <= 12));
  assert.deepEqual(groups.flat(), lines);
});

test("splitLinesByBudget: a single over-budget line is its own group (never dropped)", () => {
  const big = "x".repeat(100);
  const groups = d.splitLinesByBudget(["aa", big, "bb"], 10);
  assert.deepEqual(groups.flat(), ["aa", big, "bb"]);
  assert.ok(groups.some((g) => g.length === 1 && g[0] === big));
});

// ---- buildChunkPlan --------------------------------------------------------
test("buildChunkPlan: fresh (no cursor) -> one chunk, all lines, anchor=last uuid", () => {
  const objs = [content("a"), content("b")];
  const plan = d.buildChunkPlan(objs, null, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].lines.length, 2);
  assert.equal(plan.chunks[0].seq, 1);
  assert.equal(plan.chunks[0].reset, false);
  assert.deepEqual(plan.newCursor, { lastUuid: "b", seq: 1 });
});

test("buildChunkPlan: continuation sends only new lines with continued seq", () => {
  const objs = [content("a"), content("b"), content("c")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "a", seq: 1 }, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].lines.length, 2); // b, c
  assert.equal(plan.chunks[0].seq, 2);
  assert.deepEqual(plan.newCursor, { lastUuid: "c", seq: 2 });
});

test("buildChunkPlan: empty delta -> no chunks, null cursor (no-op)", () => {
  const objs = [content("a"), content("b")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "b", seq: 3 }, SALT);
  assert.deepEqual(plan.chunks, []);
  assert.equal(plan.newCursor, null);
});

test("buildChunkPlan: reset (cursor uuid gone) -> full resend with reset+baseline", () => {
  const objs = [content("a"), content("b")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "gone", seq: 5 }, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].reset, true);
  assert.equal(plan.chunks[0].resetBaselineSeq, 6); // seqStart(5)+1
  assert.equal(plan.chunks[0].seq, 6);
});

test("buildChunkPlan: metadata-only tail keeps the previous content anchor", () => {
  const objs = [content("a"), meta("mode")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "a", seq: 1 }, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].lines.length, 1); // the metadata line
  assert.equal(plan.newCursor.lastUuid, "a"); // anchor unchanged
  assert.equal(plan.newCursor.seq, 2);
});

test("buildChunkPlan: sanitization is applied per line (email redacted)", () => {
  const objs = [content("a", null, "mail me@x.com please")];
  const plan = d.buildChunkPlan(objs, null, SALT);
  const line = plan.chunks[0].lines[0];
  assert.ok(!line.includes("me@x.com"), "raw email must be gone");
  assert.ok(line.includes("[EMAIL]"), "redaction placeholder present");
});

test("buildChunkPlan: split produces consecutive seqs sharing reset baseline", () => {
  const objs = [content("a"), content("b"), content("c")];
  // tiny budget -> one line per chunk
  const plan = d.buildChunkPlan(objs, { lastUuid: "gone", seq: 0 }, SALT, { maxUncompressedBytes: 5 });
  assert.equal(plan.chunks.length, 3);
  assert.deepEqual(plan.chunks.map((c) => c.seq), [1, 2, 3]);
  assert.ok(plan.chunks.every((c) => c.reset === true && c.resetBaselineSeq === 1));
  assert.equal(plan.newCursor.seq, 3);
});

// ---- transfer.buildChunkHeaders (pure) -------------------------------------
test("buildChunkHeaders: reset carries baseline; non-reset sends 0", () => {
  const reset = transfer.buildChunkHeaders(
    { transcriptId: "s.jsonl", seq: 6, reset: true, resetBaselineSeq: 6, promptId: "p1" },
    "dev1",
    "tok"
  );
  assert.equal(reset["X-Chunk-Reset"], "6");
  assert.equal(reset["X-Chunk-Seq"], "6");
  assert.equal(reset["X-Prompt-ID"], "p1");
  assert.equal(reset["Authorization"], "Bearer tok");

  const plain = transfer.buildChunkHeaders(
    { transcriptId: "s.jsonl", seq: 2, reset: false, resetBaselineSeq: null },
    "dev1",
    "tok"
  );
  assert.equal(plain["X-Chunk-Reset"], "0");
  assert.equal(plain["X-Prompt-ID"], undefined, "prompt id omitted when absent");
});

// ---- transfer cursor + chunk fs round-trips --------------------------------
test("writeCursor/readCursor round-trip", () => {
  const c = { transcriptId: "round.jsonl", lastUuid: "u9", seq: 4, updatedAt: 123 };
  transfer.writeCursor(c);
  assert.deepEqual(transfer.readCursor("round.jsonl"), c);
  assert.equal(transfer.readCursor("missing.jsonl"), null);
});

test("sealDeltaChunk writes body+meta and listDeltaChunks finds it", () => {
  const before = transfer.listDeltaChunks().length;
  const body = transfer.sealDeltaChunk("seal.jsonl", ['{"uuid":"a"}'], {
    seq: 1,
    reset: false,
    resetBaselineSeq: null,
    promptId: "p",
  });
  assert.ok(body && fs.existsSync(body), "body written");
  assert.ok(fs.existsSync(body.replace(/\.jsonl$/, ".meta.json")), "meta sidecar written");
  assert.equal(transfer.listDeltaChunks().length, before + 1);
});

test("listDeltaChunks excludes a body without a meta sidecar", () => {
  const dir = path.join(DATA_DIR, "logs", "transcripts", "chunks");
  fs.mkdirSync(dir, { recursive: true });
  const orphan = path.join(dir, "9999999999-1.jsonl");
  fs.writeFileSync(orphan, "{}\n"); // no sibling .meta.json
  assert.ok(!transfer.listDeltaChunks().includes(orphan), "orphan body not listed");
});

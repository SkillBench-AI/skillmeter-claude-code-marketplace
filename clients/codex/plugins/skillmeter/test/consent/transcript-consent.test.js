"use strict";
// Consent byte ranges in the chunk queue: what was written before opt-in or
// while paused never stages, and a consent change aborts publication.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { chunkQueue, transcriptLine: line, tempDir, gunzipRecords } = require("../../test-support/plugin.cjs");
const queue = require("../../scripts/lib/transcript-delta");

const scope = { deviceId: "SYNTHETIC", owner: "fixture-owner", consentStamp: "synthetic-consent", cwd: "/synthetic", org: "synthetic" };
const fixture = t => chunkQueue(t, { scope });
const contents = (f, files) => f.records(files).map(r => r.payload.content);

test("consent byte ranges exclude pre-opt-in and paused content even in full-baseline recovery", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("before opt-in"));
  f.observe(true, "synthetic-consent");
  fs.appendFileSync(f.source, line("authorized first"));
  assert.deepEqual(contents(f, f.stage({ consent: f.observe(true, "synthetic-consent") }).files), ["authorized first"]);
  const dir = queue.queueDirectories(f.root)[0];
  await queue.drainDirectory(dir, async () => "sent");
  f.observe(false, "synthetic-consent");
  fs.appendFileSync(f.source, line("while paused"));
  f.observe(false, "synthetic-consent");
  f.observe(true, "synthetic-consent");
  fs.appendFileSync(f.source, line("authorized second"));
  f.stage({ consent: f.observe(true, "synthetic-consent") });
  await queue.drainDirectory(dir, async () => "reset-required");
  const reset = f.stage({ consent: f.observe(true, "synthetic-consent") });
  assert.deepEqual(contents(f, reset.files), ["authorized first", "authorized second"]);
});

test("a partial line crossing the initial consent boundary is excluded whole", t => {
  const f = fixture(t), record = line("partly before opt-in");
  fs.writeFileSync(f.source, record.slice(0, 30));
  f.observe(true);
  fs.appendFileSync(f.source, record.slice(30) + line("authorized"));
  assert.deepEqual(contents(f, f.stage({ consent: f.observe(true) }).files), ["authorized"]);
});

test("a source rewrite cannot reuse consent byte offsets during a server reset", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "");
  f.observe(true);
  fs.appendFileSync(f.source, line("authorized"));
  const consent = f.observe(true);
  f.stage({ consent });
  await queue.drainDirectory(queue.queueDirectories(f.root)[0], async () => "reset-required");
  fs.writeFileSync(f.source, line("replacement history has no authorization"));
  assert.throws(() => f.stage({ consent }), /consent-source-rewritten/);
});

test("corrupt consent offsets cannot stage or silently re-authorize history", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("historical"));
  f.observe(true);
  const file = path.join(queue.queueDirectories(f.root)[0], "consent.json");
  const state = JSON.parse(fs.readFileSync(file));
  state.excluded = [[-1, state.observed]];
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => f.observe(true), /invalid-consent-journal/);
  assert.throws(() => f.stage({ consent: state }), /invalid-consent-journal/);
  assert.deepEqual(queue.pendingFiles(f.root), []);
});

for (const point of ["at commit", "before publication"]) {
  test(`a consent change ${point} cannot publish a cursor or payload`, t => {
    const f = fixture(t);
    fs.writeFileSync(f.source, line("synthetic"));
    let allowed = point === "before publication";
    assert.throws(() => f.stage({
      authorizeCommit: () => allowed,
      fault: at => { if (at === "before-publish") allowed = false; },
    }), /consent-changed-during-stage/);
    const dir = queue.queueDirectories(f.root)[0];
    assert.equal(fs.existsSync(path.join(dir, "cursor.json")), false);
    assert.equal(fs.readdirSync(dir).some(name => name.startsWith("batch-")), false);
    assert.deepEqual(queue.pendingFiles(dir), []);
  });
}

test("a stale or disabled consent snapshot cannot publish new chunks", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "");
  const consent = f.observe(true);
  fs.appendFileSync(f.source, line("late record"));
  const disabled = f.observe(false);
  assert.throws(() => f.stage({ consent }), /consent-changed-during-stage/);
  assert.throws(() => f.stage({ consent: disabled }), /consent-changed-during-stage/);
  assert.deepEqual(queue.pendingFiles(queue.queueDirectories(f.root)[0]), []);
});

test("bytes appended after the authorization observation wait for another observation", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "");
  f.observe(true);
  fs.appendFileSync(f.source, line("authorized"));
  const consent = f.observe(true);
  fs.appendFileSync(f.source, line("not yet observed"));
  assert.deepEqual(contents(f, f.stage({ consent }).files), ["authorized"]);
});

test("excluded history longer than a stage budget does not strand authorized data", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, line("old " + "x".repeat(1000)));
  f.observe(true);
  fs.appendFileSync(f.source, line("authorized"));
  const consent = f.observe(true);
  assert.deepEqual(contents(f, f.stage({ consent, stageBytes: 100 }).files), ["authorized"]);
});

test("Work identity and opaque outer tool pairs survive isolated staging and a process restart", t => {
  const lines = fs.readFileSync(path.join(__dirname, "..", "fixtures", "work", "session.jsonl"), "utf8").trim().split("\n");
  const workScope = { owner: "synthetic-owner", deviceId: "SYNTHETIC", cwd: "/synthetic/agenda" };
  const root = tempDir("work-capture-fixture");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.jsonl"), chunks = path.join(root, "isolated-chunks");
  fs.writeFileSync(source, lines.slice(0, 5).join("\n") + "\n");
  assert.equal(queue.stage(chunks, source, workScope, "synthetic-salt").status, "staged");
  fs.appendFileSync(source, lines.slice(5).join("\n") + "\n");
  const resumed = spawnSync(process.execPath, ["-e", `
    const queue = require(process.argv[1]);
    queue.stage(process.argv[2], process.argv[3], JSON.parse(process.argv[4]), "synthetic-salt");
  `, require.resolve("../../scripts/lib/transcript-delta"), chunks, source, JSON.stringify(workScope)], { encoding: "utf8" });
  assert.equal(resumed.status, 0, resumed.stderr);
  const [dir] = queue.queueDirectories(chunks);
  const files = queue.pendingFiles(dir);
  assert.deepEqual(files.map(file => queue.metadata(file).seq), [1, 2]);
  const records = gunzipRecords(files);
  assert.equal(records.length, 9);
  assert.equal(new Set(records.map(record => record.uuid)).size, 9);
  assert.equal(records[0].payload.id, "synthetic-work");
  assert.equal(records[0].payload.originator, "codex_work_desktop");
  assert.equal(records[0].payload.source, "vscode");
  assert.equal(records[0].payload.contact, "[EMAIL]");
  assert.deepEqual(records.filter(record => record.payload.type === "message").map(record => record.payload.content), [
    "Add the 10, 20 and 30 minute agenda items.", "The total is 60 minutes.",
    "Remove the 30 minute item.", "The revised total is 30 minutes.",
  ]);
  assert.ok(!JSON.stringify(records).includes("alice@example.com"));
  const calls = records.filter(record => record.payload.type === "custom_tool_call");
  const results = records.filter(record => record.payload.type === "custom_tool_call_output");
  assert.deepEqual(calls.map(record => [record.payload.name, record.payload.call_id]), [["exec", "outer-1"], ["exec", "outer-2"]]);
  assert.deepEqual(results.map(record => [record.payload.call_id, record.payload.output]), [["outer-1", "60 minutes"], ["outer-2", "30 minutes"]]);
  for (const call of calls) assert.ok(!call.payload.input.includes("return"), "opaque code stays opaque");
  assert.equal(queue.stage(chunks, source, workScope, "synthetic-salt").status, "unchanged");
  assert.equal(fs.readFileSync(source, "utf8"), lines.join("\n") + "\n");
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { receiptFromStreams, compareReceipts } = require("../integration/transcript_integrity.cjs");
const record = (uuid, payload) => ({ uuid, type: "response_item", payload });
const records = [record("synthetic-call", { type: "function_call", call_id: "pair", arguments: '{"command":"synthetic"}' }), record("synthetic-result", { type: "function_call_output", call_id: "pair", output: "synthetic result" })];
const lines = rows => rows.map(r => JSON.stringify(r) + "\n").join("");
const receipt = (...sources) => receiptFromStreams(sources.map(s => Readable.from([Buffer.from(s)])));

test("cross-object overlap deduplicates exact records without inflating counts", async () => {
  const expected = await receipt(lines(records));
  const observed = await receipt(lines(records.slice(0, 1)), lines(records));
  assert.equal(observed.recordCount, 3);
  assert.equal(observed.exactDuplicates, 1);
  const result = compareReceipts(expected, observed);
  assert.equal(result.status, "pass"); assert.equal(result.observedRecords, 2);
  assert.equal(JSON.stringify(observed).includes("synthetic result"), false);
  assert.equal(JSON.stringify(observed).includes("synthetic-call"), false);
});

test("missing result, changed tool linkage and unrelated identity are blocked", async () => {
  const expected = await receipt(lines(records));
  const cases = [
    [records.slice(0, 1), "missing-record"],
    [[records[0], { ...records[1], payload: { ...records[1].payload, call_id: "wrong-pair" } }], "changed-record"],
    [[...records, record("other-session", {})], "unexpected-record"],
  ];
  for (const [rows, reason] of cases) {
    const result = compareReceipts(expected, await receipt(lines(rows)));
    assert.equal(result.status, "blocked"); assert.ok(result.issues.some(i => i.reason === reason));
  }
});

test("an identity conflict cannot disappear behind a matching copy", async () => {
  const expected = await receipt(lines(records));
  const observed = await receipt(lines([...records, { ...records[0], payload: { overwritten: true } }]));
  const result = compareReceipts(expected, observed);
  assert.equal(result.status, "blocked"); assert.ok(result.issues.some(i => i.reason === "conflicting-identity"));
});

test("empty sets, malformed input, absent UUID, invalid UTF-8 and partial tails never pass", async () => {
  const expected = await receipt(lines(records));
  for (const source of ["", "not-json\n", '{}\n', JSON.stringify(records[0])]) {
    assert.equal(compareReceipts(expected, await receipt(source)).status, "blocked");
  }
  assert.equal(compareReceipts(await receipt(""), await receipt("")).status, "blocked");
  const invalid = await receiptFromStreams([Readable.from([Buffer.from([123,34,120,34,58,34,255,34,125,10])])]);
  assert.equal(invalid.errors.malformed, 1);
});

test("stream boundaries and JSON key order do not change record identity", async () => {
  const expected = await receipt(lines(records));
  const bytes = Buffer.from(lines(records.map(r => ({ payload: r.payload, type: r.type, uuid: r.uuid }))));
  const observed = await receiptFromStreams([Readable.from(Array.from(bytes, b => Buffer.from([b])))]);
  assert.equal(compareReceipts(expected, observed).status, "pass");
});

test("blank lines and whitespace identities cannot hide malformed records", async () => {
  const expected = await receipt(lines(records));
  for (const extra of ["\n", "  \n", '{"uuid":"  "}\n']) {
    assert.equal(compareReceipts(expected, await receipt(lines(records) + extra)).status, "blocked");
  }
});

test("numeric rounding and overflow cannot produce matching fingerprints", async () => {
  const valid = await receipt('{"uuid":"number","value":null}\n');
  for (const number of ["9007199254740992", "9007199254740993", "1e400", "1e-400", "0.10000000000000000001", "1.0", "-0"]) {
    const actual = await receipt(`{"uuid":"number","value":${number}}\n`);
    assert.equal(actual.errors.malformed, 1, number);
    assert.equal(compareReceipts(valid, actual).status, "blocked");
  }
  const quoted = await receipt('{"uuid":"number","value":"9007199254740993 and \\"1e400\\"","fraction":0.125,"integer":9007199254740991}\n');
  assert.equal(quoted.errors.malformed, 0);
  assert.equal(compareReceipts(quoted, quoted).status, "pass");
});

test("wrong-shaped or duplicate-ID receipts are rejected instead of accepted as empty evidence", async () => {
  const valid = await receipt(lines(records));
  for (const bad of [{}, { ...valid, version: 2 }, { ...valid, errors: {} }, { ...valid, inputs: [] }, { ...valid, recordCount: 0 }, { ...valid, conflictingIds: ["a".repeat(64)] }, { ...valid, records: [...valid.records, valid.records[0]] }]) {
    assert.throws(() => compareReceipts(bad, valid), /invalid-receipt/);
  }
});

test("oversized lines block acceptance while the following valid record is retained", async () => {
  const observed = await receiptFromStreams([Readable.from([
    Buffer.alloc(32 * 1024 * 1024, 120), Buffer.from("x\n" + lines(records)),
  ])]);
  assert.equal(observed.errors.oversized, 1);
  assert.equal(observed.errors.incompleteTail, 0);
  assert.equal(observed.records.length, 2);
  assert.equal(compareReceipts(await receipt(lines(records)), observed).status, "blocked");
});

test("CLI produces private receipts and returns distinct record and input errors", () => {
  const script = path.join(__dirname, "../integration/transcript_integrity.cjs");
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
  const good = run(["receipt", "-"], lines(records));
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).records.length, 2);
  assert.equal(good.stdout.includes("synthetic result"), false);
  const malformed = run(["receipt", "-"], "private-synthetic-text\n");
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout.includes("private-synthetic-text"), false);
  const unreadable = run(["receipt", "-", path.join(__dirname, "absent-private-input.jsonl")], lines(records));
  assert.equal(unreadable.status, 2);
  assert.equal(unreadable.stdout, "");
  assert.equal(unreadable.stderr, "transcript-integrity: invalid input or unreadable evidence\n");
});

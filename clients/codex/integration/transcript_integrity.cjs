#!/usr/bin/env node
"use strict";
// Offline record-set check. Does not load credentials or emit transcript text.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const MAX_LINE = 32 * 1024 * 1024;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function receiptFromStreams(streams) {
  const records = new Map(), inputs = [], conflicts = new Set();
  const errors = { malformed: 0, missingIdentity: 0, oversized: 0, incompleteTail: 0 };
  let recordCount = 0, exactDuplicates = 0;
  for (const stream of streams) {
    const hash = crypto.createHash("sha256");
    let pending = [], length = 0, skipping = false, bytes = 0;
    function consume(raw) {
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        const record = JSON.parse(source);
        // JSON.parse rounds large/precise numbers and accepts overflowing
        // exponents. Restrict numeric tokens to exact serializer round-trips.
        for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
          if (match[1] === undefined) continue;
          const number = Number(match[1]);
          if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)) || JSON.stringify(number) !== match[1]) throw Error("unsupported-number");
        }
        if (!record || typeof record !== "object" || Array.isArray(record)) { errors.malformed++; return; }
        if (typeof record.uuid !== "string" || !record.uuid.trim()) { errors.missingIdentity++; return; }
        const id = sha(record.uuid), digest = sha(canonical(record));
        recordCount++;
        if (!records.has(id)) records.set(id, digest);
        else if (records.get(id) === digest) exactDuplicates++;
        else conflicts.add(id);
      } catch { errors.malformed++; }
    }
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer); bytes += buffer.length;
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start), end = newline < 0 ? buffer.length : newline + 1;
        const part = buffer.subarray(start, end);
        length += part.length;
        if (!skipping && length <= MAX_LINE) pending.push(part);
        else if (!skipping) { skipping = true; pending = []; errors.oversized++; }
        if (newline >= 0) {
          if (!skipping) consume(Buffer.concat(pending, length));
          pending = []; length = 0; skipping = false;
        }
        start = end;
      }
    }
    if (length) errors.incompleteTail++;
    inputs.push({ bytes, sha256: hash.digest("hex") });
  }
  return { version: 1, kind: "transcript-record-receipt", inputs, recordCount, exactDuplicates,
    conflictingIds: [...conflicts].sort(), errors,
    records: [...records].sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => ({ id, digest })) };
}
function validate(receipt) {
  const digest = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
  const count = x => Number.isSafeInteger(x) && x >= 0;
  if (!receipt || receipt.version !== 1 || receipt.kind !== "transcript-record-receipt" ||
      !Array.isArray(receipt.inputs) || !receipt.inputs.length || !receipt.inputs.every(i => i && count(i.bytes) && digest(i.sha256)) ||
      !count(receipt.recordCount) || !count(receipt.exactDuplicates) ||
      !Array.isArray(receipt.conflictingIds) || !receipt.conflictingIds.every(digest) ||
      !receipt.errors || Object.keys(receipt.errors).length !== 4 || !["malformed", "missingIdentity", "oversized", "incompleteTail"].every(k => count(receipt.errors[k])) ||
      !Array.isArray(receipt.records) || !receipt.records.every(r => r && digest(r.id) && digest(r.digest)) ||
      new Set(receipt.records.map(r => r.id)).size !== receipt.records.length ||
      new Set(receipt.conflictingIds).size !== receipt.conflictingIds.length ||
      !receipt.conflictingIds.every(id => receipt.records.some(r => r.id === id)) ||
      (!receipt.conflictingIds.length && receipt.recordCount !== receipt.records.length + receipt.exactDuplicates) ||
      receipt.recordCount < receipt.records.length + receipt.exactDuplicates + receipt.conflictingIds.length) throw Error("invalid-receipt");
}
function compareReceipts(expected, observed) {
  validate(expected); validate(observed);
  const wanted = new Map(expected.records.map(r => [r.id, r.digest]));
  const actual = new Map(observed.records.map(r => [r.id, r.digest]));
  const issues = [];
  for (const [side, receipt] of [["expected", expected], ["observed", observed]]) {
    for (const [reason, count] of Object.entries(receipt.errors)) if (count) issues.push({ side, reason, count });
    if (receipt.conflictingIds.length) issues.push({ side, reason: "conflicting-identity", count: receipt.conflictingIds.length });
    if (!receipt.records.length) issues.push({ side, reason: "empty-record-set", count: 1 });
  }
  const missing = [...wanted.keys()].filter(id => !actual.has(id));
  const unexpected = [...actual.keys()].filter(id => !wanted.has(id));
  const changed = [...wanted.keys()].filter(id => actual.has(id) && actual.get(id) !== wanted.get(id));
  if (missing.length) issues.push({ side: "observed", reason: "missing-record", count: missing.length });
  if (unexpected.length) issues.push({ side: "observed", reason: "unexpected-record", count: unexpected.length });
  if (changed.length) issues.push({ side: "observed", reason: "changed-record", count: changed.length });
  return { version: 1, gate: "selected-transcript-record-integrity", status: issues.length ? "blocked" : "pass",
    expectedRecords: wanted.size, observedRecords: actual.size, issues, missing, unexpected, changed,
    expectedReceiptSha256: sha(canonical(expected)), observedReceiptSha256: sha(canonical(observed)),
    limits: ["Selected record sets only; source discovery and consent eligibility are not verified.",
      "Record order across objects is not verified; composition needs a separate check.",
      "No assertion about normalization, model validity, reporting week or dashboard delivery.",
      "Receipts must come from trusted capture/storage adapters; this offline tool does not authenticate them."] };
}
async function main(args) {
  if (args[0] === "receipt" && args.length > 1 && args.slice(1).filter(p => p === "-").length <= 1) {
    function* streams() { for (const p of args.slice(1)) yield p === "-" ? process.stdin : fs.createReadStream(p); }
    const result = await receiptFromStreams(streams());
    console.log(JSON.stringify(result));
    if (result.conflictingIds.length || Object.values(result.errors).some(Boolean)) process.exitCode = 1;
  } else if (args[0] === "compare" && args.length === 3) {
    const result = compareReceipts(...args.slice(1).map(p => JSON.parse(fs.readFileSync(p, "utf8"))));
    console.log(JSON.stringify(result)); process.exitCode = result.status === "pass" ? 0 : 1;
  } else throw Error("usage");
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error("transcript-integrity: invalid input or unreadable evidence"); process.exitCode = 2; });
module.exports = { receiptFromStreams, compareReceipts };

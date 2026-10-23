"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { sanitizeLine } = require("../sanitizer");

// References are confined to earlier eligible records in this source and reset
// generation. A missing match retains the full entry. This is context deduplication,
// never a reason to discard an authored message or tool result.
const HISTORY_FIELDS = ["replacement_history", "guardian_history"];
const MAX_ENTRIES = 50000;
const mac = (salt, value) => crypto.createHmac("sha256", salt).update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

function createProjection(fd, { salt, id, generation, consent, maxRecord }) {
  const entries = new Map();
  let scanned = 0;
  function remember(value, uuid, pointer) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const key = mac(salt, canonical(value));
    if (entries.has(key)) return;
    if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
    entries.set(key, { uuid, pointer });
  }
  function index(raw, offset) {
    // Never decode excluded history, including history before initial consent.
    if (consent?.excluded.some(([a, b]) => offset < b && offset + raw.length > a)) return;
    if (raw.length > maxRecord) return;
    let record;
    try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return; }
    const uuid = mac(salt, `${id}\0${generation}\0${offset}\0${mac(salt, raw)}`);
    if (record?.type === "response_item") remember(record.payload, uuid, "/payload");
    if (record?.type === "compacted") {
      for (const field of HISTORY_FIELDS) {
        if (!Array.isArray(record.payload?.[field])) continue;
        record.payload[field].forEach((entry, i) => remember(entry, uuid, `/payload/${field}/${i}`));
      }
    }
  }
  function scanThrough(end) {
    const buffer = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0), position = scanned;
    while (position < end) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
      if (!n) throw new Error("source-truncated-during-read");
      position += n;
      pending = Buffer.concat([pending, buffer.subarray(0, n)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const raw = pending.subarray(0, newline + 1);
        index(raw, scanned); scanned += raw.length;
        pending = pending.subarray(newline + 1);
      }
      // Prior successfully staged records cannot exceed this bound.
      if (pending.length > maxRecord) throw new Error("oversized-single-record");
    }
    if (pending.length) throw new Error("malformed-complete-record");
  }
  return (record, offset, sanitized = null) => {
    if (record.type !== "compacted" || !record.payload || typeof record.payload !== "object") return record;
    scanThrough(offset);
    sanitized ||= sanitizeLine(record, salt);
    const payload = { ...record.payload }, fields = {};
    for (const field of HISTORY_FIELDS) {
      if (!Array.isArray(payload[field])) continue;
      let omittedEntries = 0, omittedBytes = 0;
      payload[field] = payload[field].map((entry, i) => {
        const match = entries.get(mac(salt, canonical(entry)));
        if (!match) return entry;
        const reference = { type: "skillmeter_compaction_reference", source_uuid: match.uuid, pointer: match.pointer };
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        // Replacing small entries would increase transport cost.
        if (Buffer.byteLength(JSON.stringify(sanitized.payload[field][i])) <= Buffer.byteLength(JSON.stringify(reference))) return entry;
        omittedEntries++; omittedBytes += bytes;
        return reference;
      });
      fields[field] = { entries: payload[field].length, referenced_entries: omittedEntries, referenced_json_bytes: omittedBytes };
    }
    if (!Object.values(fields).some(f => f.referenced_entries)) return record;
    return { ...record, payload, _codex_compaction_projection: { version: 1, fields } };
  };
}

module.exports = { createProjection };

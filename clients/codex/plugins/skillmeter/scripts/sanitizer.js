"use strict";
// Codex envelope adapter over the pinned Claude policy. Keep the shared engine,
// rules and path vocabulary unchanged; document the pin in docs/sanitizer-parity.md.
const fs = require("node:fs");
const shared = require("./lib/sanitize");
const { SECRET_PLACEHOLDER, KINDS } = require("./lib/rules");

// Same tally the shared engine stamps on its own records (sanitize.js keeps it
// private since policy 3.1.2). Codex adds its opaque-input redactions first.
function summarizeRedactions(redactions) {
  const counts = {};
  for (const k of KINDS) counts[k] = 0;
  let secrets = 0, pii = 0;
  for (const r of redactions) {
    if (r.category === "secret") secrets++;
    else if (r.category === "pii") pii++;
    const kind = r.kind || r.category;
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const ids = [...new Set(redactions.filter(r => r.category !== "path").map(r => r.id))].sort();
  return { policyVersion: shared.POLICY_VERSION, secrets, pii, counts, ids };
}

const OPAQUE_KEYS = new Set(["command", "cmd", "patch"]);
// A compaction reference names an already-sanitized queued record by its
// 64-hex identifier. The identifier is not content and must survive the
// content rules: a random hex string can look like a card number.
const REFERENCE_TYPE = "skillmeter_compaction_reference";
const REFERENCE_ID = /^[a-f0-9]{64}$/;

// `references` collects { path, id } for every identifier replaced in this
// pass; only those exact paths are restored, so a supplied value that looks
// like a placeholder is never turned into a reference.
function prepare(value, salt, opaque, references, trail = []) {
  if (Array.isArray(value)) return value.map((item, i) => prepare(item, salt, opaque, references, [...trail, i]));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "_sanitization") continue; // raw input cannot supply provenance
    if (typeof item === "string" && (OPAQUE_KEYS.has(key) ||
        (key === "input" && value.type === "custom_tool_call"))) {
      out[key] = shared.hashHmac(item, salt);
      if (item && salt) opaque.push({ id: "codex-opaque-tool", category: "path", kind: "path", action: "hashed" });
    } else if (key === "source_uuid" && value.type === REFERENCE_TYPE && typeof item === "string" && REFERENCE_ID.test(item)) {
      out[key] = `skillmeter:reference:${references.length}`;
      references.push({ path: [...trail, key], id: item });
    } else {
      Object.defineProperty(out, key, {value: prepare(item, salt, opaque, references, [...trail, key]), enumerable: true, configurable: true, writable: true});
    }
  }
  return out;
}

function restoreReferences(value, references) {
  references.forEach(({ path, id }, index) => {
    let node = value;
    for (const key of path.slice(0, -1)) node = node?.[key];
    const last = path[path.length - 1];
    if (node && typeof node === "object" && node[last] === `skillmeter:reference:${index}`) node[last] = id;
  });
}

function sanitizeRecord(record, salt) {
  const opaque = [];
  const references = [];
  // Codex encodes function arguments as a JSON string. Parse only this known
  // protocol field so labelled secrets and path rules see its structure.
  let input = record;
  let argumentsWereJson = false;
  if (record?.type === "response_item" && record.payload?.type === "function_call" &&
      typeof record.payload.arguments === "string") {
    try {
      const args = JSON.parse(record.payload.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("unsupported-arguments");
      input = { ...record, payload: { ...record.payload, arguments: args } };
      argumentsWereJson = true;
    } catch {
      // Invalid structured input has no safe field-level interpretation.
      // Keep the tool/call identity and report an opaque input instead.
      if (record.payload.arguments && salt) opaque.push({ id: "codex-opaque-tool", category: "path", kind: "path", action: "hashed" });
      input = { ...record, payload: { ...record.payload,
        arguments: shared.hashHmac(record.payload.arguments, salt),
        _codex_arguments_format:"unsupported-json-opaque" } };
    }
  }
  const result = shared.sanitizeEventData(prepare(input, salt, opaque, references), salt);
  if (references.length) restoreReferences(result.value, references);
  result.redactions.push(...opaque);
  result.meta = summarizeRedactions(result.redactions);
  if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
    result.value._sanitization = result.meta;
  }
  if (argumentsWereJson) result.value.payload.arguments = JSON.stringify(result.value.payload.arguments);
  return result;
}

function sanitizeLine(record, salt) {
  return sanitizeRecord(record, salt).value;
}

// Retained API for local export callers; the durable uploader uses complete
// byte records and rejects malformed lines in transcript-delta instead.
function sanitizeTranscript(file, salt) {
  const output = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    output.push(JSON.stringify(sanitizeLine(JSON.parse(line), salt)));
  }
  return Buffer.from(output.join("\n") + "\n");
}
// Compatibility helper for callers predating per-record metadata.
function redactDeep(value, redactions = [], salt) {
  const result = sanitizeRecord(value, salt);
  redactions.push(...result.redactions);
  if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
    delete result.value._sanitization;
  }
  return result.value;
}
module.exports = {
  POLICY_VERSION: shared.POLICY_VERSION,
  SECRET_PLACEHOLDER,
  EMAIL_PLACEHOLDER: "[EMAIL]",
  redactString: shared.redactString,
  containsTier1: shared.containsSecret,
  hashHmac: shared.hashHmac,
  sanitizeEventData: sanitizeRecord,
  sanitizeLine,
  sanitizeTranscript,
  redactDeep,
};

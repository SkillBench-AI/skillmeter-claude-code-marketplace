"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STAGE_CODES = new Set(["oversized-single-record", "malformed-complete-record", "invalid-wire-budget", "source-changed-during-stage", "source-truncated-during-read", "invalid-cursor", "incomplete-transaction", "source-scope-changed", "source-owner-changed", "consent-source-rewritten", "consent-changed-during-stage", "invalid-session-metadata", "unsupported-session-source", "unsupported-session-originator", "stage-failed"]);
function read(file) {
  try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : { unreadable: true }; }
  catch (error) { if (error.code === "ENOENT") return null; return { unreadable: true }; }
}
function phaseOf(diagnostic) {
  if (diagnostic?.phase === "capture" || diagnostic?.phase === "delivery") return diagnostic.phase;
  if (STAGE_CODES.has(diagnostic?.code)) return "capture";
  if (/^http-\d{3}$/.test(diagnostic?.code) || diagnostic?.code === "queue-unavailable") return "delivery";
  return "unknown";
}
function readStatus(dir, phase) {
  const value = read(path.join(dir, `${phase}-status.json`));
  if (!value || value.unreadable) return value;
  const date = v => typeof v === "string" && Number.isFinite(Date.parse(v));
  const failure = v => v && typeof v === "object" && /^[a-z0-9-]{1,80}$/.test(v.code) && date(v.at);
  if (value.version !== 1 || value.phase !== phase || !date(value.lastAttemptAt) ||
      !(value.activeFailure === null || failure(value.activeFailure)) ||
      (value.activeFailure === null && !date(value.lastSuccessAt)) ||
      ["lastProgressAt", "lastSuccessAt"].some(k => value[k] !== undefined && !date(value[k])) ||
      ["capturedBytes", "observedBytes", "acknowledgedSeq", "acknowledgedBaseline"].some(k => value[k] !== undefined && (!Number.isSafeInteger(value[k]) || value[k] < 0))) return { unreadable: true };
  return value;
}
function update(dir, phase, code, progress, write) {
  if (!["capture", "delivery"].includes(phase)) throw new Error("invalid-health-phase");
  const file = path.join(dir, `${phase}-status.json`), previous = readStatus(dir, phase) || {}, at = new Date().toISOString();
  const failure = code ? { code: /^[a-z0-9-]{1,80}$/.test(code) ? code : "unknown", at } : null;
  const next = { ...previous, version: 1, phase, attemptId: randomUUID(), lastAttemptAt: at, activeFailure: failure,
    ...Object.fromEntries(Object.entries(progress).filter(([, value]) => value !== undefined)) };
  delete next.unreadable;
  if (failure) next.lastFailure = failure;
  else {
    next.lastSuccessAt = at;
    if ((phase === "capture" && progress.capturedBytes > (previous.capturedBytes || 0)) ||
        (phase === "delivery" && progress.acknowledgedSeq !== previous.acknowledgedSeq)) next.lastProgressAt = at;
  }
  write(file, JSON.stringify(next));
  const legacyFile = path.join(dir, "diagnostic.json"), legacy = read(legacyFile);
  // An upgrade may have only the old shared diagnostic. Preserve its other
  // phase until that phase succeeds. The new failure is in its own phase file.
  if (failure && legacy && !legacy.resolvedAt && phaseOf(legacy) !== phase) return;
  if (failure) write(legacyFile, JSON.stringify({ ...failure, phase, ...(progress.seq !== undefined ? { seq: progress.seq } : {}) }));
  else if (legacy && !legacy.unreadable && phaseOf(legacy) === phase && !legacy.resolvedAt) {
    write(legacyFile, JSON.stringify({ ...legacy, phase, resolvedAt: at }));
  }
}

function inspect(dir) {
  const capture = readStatus(dir, "capture");
  const delivery = readStatus(dir, "delivery");
  const legacy = read(path.join(dir, "diagnostic.json"));
  const failures = [];
  for (const [phase, status] of [["capture", capture], ["delivery", delivery]]) {
    if (status?.unreadable) failures.push({ phase, code: "status-unreadable" });
    else if (status?.activeFailure) failures.push({ phase, ...status.activeFailure });
  }
  if (legacy && !legacy.resolvedAt) {
    const phase = phaseOf(legacy), current = phase === "capture" ? capture : phase === "delivery" ? delivery : null;
    // A legacy writer can still report a newer failure. Never infer health from
    // an empty queue or a status file written before that failure.
    if (!current || !legacy.at || legacy.at > current.lastAttemptAt) failures.push({ phase, code: legacy.unreadable ? "status-unreadable" : legacy.code, at: legacy.at });
  }
  return { capture, delivery, failures };
}
module.exports = { update, inspect, STAGE_CODES };

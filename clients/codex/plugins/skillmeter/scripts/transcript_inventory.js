#!/usr/bin/env node
"use strict";
// Read-only, content-free recovery inventory. Does not load credstore/logger,
// read transcript bodies, replay queues, or mutate anything.
const fs = require("node:fs"), path = require("node:path");
const health = require("./lib/transcript-health");
function countFiles(dir, accept = () => true) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isFile() && accept(e.name)).length;
}
function inventory(dataDir) {
  const logs = path.join(dataDir, "logs"), chunks = path.join(logs, "transcripts/chunks-v1");
  const reasons = {}, sessions = [];
  if (fs.existsSync(chunks)) for (const name of fs.readdirSync(chunks).filter(n => /^[a-f0-9]{64}$/.test(n))) {
    const state = health.inspect(path.join(chunks, name));
    for (const d of state.failures) {
      const code = /^[a-z0-9-]+$/.test(d.code) ? d.code : "unknown";
      reasons[code] = (reasons[code] || 0) + 1;
    }
    sessions.push({ sourceId: name, ...state });
  }
  return { dryRun: true, legacyPending: countFiles(path.join(logs, "transcripts/pending"), n => !n.startsWith(".")),
    legacyPoisonUnknownReason: countFiles(path.join(logs, "poison"), n => !n.startsWith("events.jsonl.")),
    chunkDiagnostics: reasons, sessions, downstream: "unknown" };
}
if (require.main === module) {
  const data = process.env.PLUGIN_DATA;
  if (!data) { console.error("Set PLUGIN_DATA to the queue to inventory; no default home scan."); process.exitCode = 1; }
  else console.log(JSON.stringify(inventory(data), null, 2));
}
module.exports = { inventory };

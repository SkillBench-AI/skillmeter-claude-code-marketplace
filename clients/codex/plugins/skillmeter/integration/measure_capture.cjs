"use strict";
// Synthetic local measurement. No network, credentials, or real sessions.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const queue = require("../scripts/lib/transcript-delta");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-capture-cost-"));
const source = path.join(root, "synthetic.jsonl");
const scope = { deviceId: "SYNTHETIC", owner: "synthetic-owner" };
const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "synthetic text ".repeat(280) } }) + "\n";
try {
  const fd = fs.openSync(source, "w");
  for (let bytes = 0; bytes < 64 * 1024 * 1024; bytes += Buffer.byteLength(line)) fs.writeSync(fd, line);
  fs.closeSync(fd);
  const stage = () => queue.stage(path.join(root, "queue"), source, scope, "synthetic-salt");
  while (stage().status === "staged") { /* establish a fully consumed cursor */ }
  const evidence = { sourceBytes: fs.statSync(source).size, measurements: [] };
  for (const kind of ["unchanged", "append"]) {
    if (kind === "append") fs.appendFileSync(source, line);
    const read = fs.readSync;
    let readBytes = 0;
    fs.readSync = function (...args) {
      const n = read.apply(this, args);
      readBytes += n;
      return n;
    };
    const start = performance.now();
    let result;
    try { result = stage(); } finally { fs.readSync = read; }
    evidence.measurements.push({ kind, status: result.status, readBytes, milliseconds: performance.now() - start });
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

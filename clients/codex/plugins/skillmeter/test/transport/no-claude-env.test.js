"use strict";
// Codex state must never resolve through Claude's plugin variables. A shell
// inside Claude Code inherits CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA, so any
// fallback to them would put Codex queues in Claude's plugin directory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");

function runtimeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return runtimeFiles(file);
    return entry.name.endsWith(".js") || dir.endsWith("bin") ? [file] : [];
  });
}

test("runtime code does not read CLAUDE_PLUGIN_* variables", () => {
  const offenders = ["scripts", "bin"]
    .flatMap(dir => runtimeFiles(path.join(PLUGIN_ROOT, dir)))
    .filter(file => /process\.env\.CLAUDE_PLUGIN_/.test(fs.readFileSync(file, "utf8")))
    .map(file => path.relative(PLUGIN_ROOT, file));
  assert.deepEqual(offenders, []);
});

test("transcript inventory ignores an inherited CLAUDE_PLUGIN_DATA", () => {
  const claudeData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-data-"));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: claudeData };
  delete env.PLUGIN_DATA;
  const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "transcript_inventory.js")], {
    env, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set PLUGIN_DATA/);
});

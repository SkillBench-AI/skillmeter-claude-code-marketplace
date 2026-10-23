"use strict";
// Durable queues stay in the host's plugin data directory across versioned
// install replacement, and never inside an installation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const plugin = path.resolve(__dirname, "..", "..");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "plugins/data/skillmeter-fixture");
  const install = version => path.join(root, "plugins/cache/fixture/skillmeter", version);
  return { root, data, install };
}
function readRoot(f, install, extra = {}) {
  const program = `const logger = require(${JSON.stringify(path.join(plugin, "scripts/logger"))}); console.log(JSON.stringify({data:logger.PLUGIN_DATA,childData:process.env.PLUGIN_DATA}));`;
  return spawnSync(process.execPath, ["-e", program], { encoding: "utf8", env: {
    PATH: process.env.PATH, HOME: f.root, PLUGIN_ROOT: install, SKILLMETER_STATE_DIR: path.join(f.root, "identity"), ...extra,
  } });
}

test("logger keeps one persistent data root across versioned install replacement", t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.data), { recursive: true });
  const old = f.install("old"), next = f.install("new");
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(next, { recursive: true });
  const first = readRoot(f, old); assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { data: f.data, childData: f.data });
  fs.mkdirSync(f.data, { recursive: true });
  fs.writeFileSync(path.join(f.data, "queue-marker"), "synthetic queue");
  fs.rmSync(old, { recursive: true });
  const second = readRoot(f, next); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { data: f.data, childData: f.data });
  assert.equal(fs.readFileSync(path.join(f.data, "queue-marker"), "utf8"), "synthetic queue");
  assert.equal(fs.existsSync(path.join(next, "logs")), false);
});

test("skill commands use the data directory a hook was given for the same install", t => {
  const f = fixture(t), install = f.install("new"), hookData = path.join(f.root, "host-chosen-data");
  fs.mkdirSync(install, { recursive: true }); fs.mkdirSync(hookData);
  const hook = readRoot(f, install, { PLUGIN_DATA: hookData });
  assert.equal(hook.status, 0, hook.stderr);
  const skill = readRoot(f, install);
  assert.equal(skill.status, 0, skill.stderr);
  assert.deepEqual(JSON.parse(skill.stdout), { data: hookData, childData: hookData });
  assert.equal(fs.existsSync(f.data), false, "no inferred directory when a hook recorded one");
});

test("a recorded directory from another install is ignored", t => {
  const f = fixture(t), hookData = path.join(f.root, "internal-data");
  const other = path.join(f.root, "plugins/cache/fixture-internal/skillmeter/new");
  fs.mkdirSync(other, { recursive: true }); fs.mkdirSync(hookData);
  assert.equal(readRoot(f, other, { PLUGIN_DATA: hookData }).status, 0);
  const install = f.install("new"); fs.mkdirSync(install, { recursive: true });
  const skill = readRoot(f, install);
  assert.equal(skill.status, 0, skill.stderr);
  assert.deepEqual(JSON.parse(skill.stdout), { data: f.data, childData: f.data });
});

test("a clean install without plugins/data creates its private data directory", t => {
  const f = fixture(t), install = f.install("new");
  fs.mkdirSync(install, { recursive: true });
  assert.equal(fs.existsSync(path.dirname(f.data)), false);
  const result = readRoot(f, install);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { data: f.data, childData: f.data });
  assert.equal(fs.statSync(f.data).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(install, "logs")), false);
});

test("a cache-shaped path outside a plugins directory is not treated as an installation", t => {
  const f = fixture(t), install = path.join(f.root, "elsewhere/cache/fixture/skillmeter/new");
  fs.mkdirSync(install, { recursive: true });
  const result = readRoot(f, install);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /persistent-plugin-data-unavailable: set PLUGIN_DATA/);
  assert.equal(fs.existsSync(path.join(f.root, "elsewhere/data")), false);
});

test("unresolved source checkout or unsubstituted data cannot write inside installation", t => {
  const f = fixture(t);
  const source = readRoot(f, f.root, { PLUGIN_DATA: "${PLUGIN_DATA}" });
  assert.notEqual(source.status, 0);
  assert.match(source.stderr, /persistent-plugin-data-unavailable/);
  assert.equal(fs.existsSync(path.join(f.root, "logs")), false);
  // An unsubstituted variable in an installation falls back to the host layout.
  const install = f.install("new");
  fs.mkdirSync(install, { recursive: true });
  const inferred = readRoot(f, install, { PLUGIN_DATA: "${PLUGIN_DATA}" });
  assert.equal(inferred.status, 0, inferred.stderr);
  assert.deepEqual(JSON.parse(inferred.stdout), { data: f.data, childData: f.data });
  assert.equal(fs.existsSync(path.join(install, "logs")), false);
});

test("host-supplied data is propagated to detached children", t => {
  const f = fixture(t), selected = path.join(f.root, "explicit-data");
  const result = readRoot(f, f.install("new"), { PLUGIN_DATA: selected });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { data: selected, childData: selected });
});

test("an inherited CLAUDE_PLUGIN_DATA is never used as Codex data", t => {
  const f = fixture(t), claude = path.join(f.root, "claude-data");
  fs.mkdirSync(path.dirname(f.data), { recursive: true });
  fs.mkdirSync(f.install("new"), { recursive: true });
  const inferred = readRoot(f, f.install("new"), { CLAUDE_PLUGIN_DATA: claude });
  assert.equal(inferred.status, 0, inferred.stderr);
  assert.deepEqual(JSON.parse(inferred.stdout), { data: f.data, childData: f.data });
  const source = readRoot(f, f.root, { CLAUDE_PLUGIN_DATA: claude });
  assert.notEqual(source.status, 0);
  assert.match(source.stderr, /persistent-plugin-data-unavailable/);
  assert.equal(fs.existsSync(claude), false);
});

test("queued data in an older cached install holds inference instead of stranding it", t => {
  const f = fixture(t), oldLogs = path.join(f.install("old"), "logs");
  fs.mkdirSync(path.dirname(f.data), { recursive: true });
  fs.mkdirSync(oldLogs, { recursive: true });
  const source = path.join(oldLogs, "events.jsonl");
  fs.writeFileSync(source, "synthetic retained event\n");
  const result = readRoot(f, f.install("new"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy-install-data-recovery-required/);
  assert.equal(fs.readFileSync(source, "utf8"), "synthetic retained event\n");
  assert.equal(fs.existsSync(f.data), false);
});

test("a marker left in an installation by a skill command does not hold inference", t => {
  const f = fixture(t), oldLogs = path.join(f.install("old"), "logs");
  fs.mkdirSync(path.dirname(f.data), { recursive: true });
  fs.mkdirSync(path.join(oldLogs, "repository-routing"), { recursive: true });
  fs.writeFileSync(path.join(oldLogs, "consent-policy-observed"), "1\n");
  const result = readRoot(f, f.install("new"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { data: f.data, childData: f.data });
});

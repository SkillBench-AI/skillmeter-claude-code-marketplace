"use strict";

// ADR 003 decision 7: the display module (hooks/status.tsx) runs inside
// Claude Code, not under node, so these checks hold it to the plugin it
// displays. Every state the resolver can produce has a footer label, the
// states that need the user have a band, and the module is wired the way
// Claude Code loads it. `claude plugin validate` (CI) checks the module itself.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The plugin's lib modules resolve the data and state directories when they
// load; outside a plugin installation they need throwaway ones.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "skm-status-module-"));
process.env.CLAUDE_PLUGIN_DATA = path.join(SCRATCH, "data");
process.env.SKILLMETER_STATE_DIR = path.join(SCRATCH, "state");

const PLUGIN = path.resolve(__dirname, "../skillmeter");
const MODULE = fs.readFileSync(path.join(PLUGIN, "hooks/status.tsx"), "utf8");
const { STATES, GROUPS, stateGroup } = require("../skillmeter/scripts/lib/collection-state");

// The keys of `const NAME: Record<string, string> = { ... }` in the module.
function tableKeys(name) {
  const body = MODULE.match(new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(body, `${name} table not found in hooks/status.tsx`);
  return [...body[1].matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]).sort();
}

test("every collection state has a footer label", () => {
  assert.deepEqual(tableKeys("LABEL"), Object.values(STATES).sort());
});

test("exactly the states that need the user have a band above the prompt", () => {
  const needsUser = Object.values(STATES)
    .filter((s) => s !== STATES.NEVER_SIGNED_IN)
    .filter((s) => stateGroup(s) !== GROUPS.HEALTHY)
    .sort();
  assert.deepEqual(tableKeys("BAND"), needsUser);
});

test("the module is loaded from hooks.json and typed by the manifest", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks/hooks.json"), "utf8"));
  assert.deepEqual(hooks.modules, ["./status.tsx"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.types, "./types/index.d.ts");
  assert.ok(fs.existsSync(path.join(PLUGIN, "types/index.d.ts")));
});

test("the module reads the directory the writer writes", () => {
  const { SESSION_STATUS_DIR } = require("../skillmeter/scripts/lib/session-status");
  assert.equal(path.basename(SESSION_STATUS_DIR), "session-status");
  assert.match(MODULE, /session-status\$\{sep\}\$\{id\}\.json/);
});

test("the module only reads: no process, network or file writes", () => {
  for (const call of ["$.process.", "$.http.", "$.fs.write", "$.fs.remove"]) {
    assert.equal(MODULE.includes(call), false, call);
  }
});

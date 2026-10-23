"use strict";
// The hook surface: which Codex events are wired, and the JSON protocol the
// Stop hooks keep even when routing or consent blocks capture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PLUGIN_ROOT, sandbox, grantConsent } = require("../../test-support/plugin.cjs");

const CODEX_HOOK_EVENTS = [
  "SessionStart", "SessionEnd", "Interrupt", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop",
];
const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks;

test("hooks.json wires exactly the Codex hook catalog, with the three-second shutdown maximum", () => {
  assert.deepEqual(Object.keys(hooks).sort(), [...CODEX_HOOK_EVENTS].sort());
  for (const event of ["SessionEnd", "Interrupt"]) assert.equal(hooks[event][0].hooks[0].timeout, 3, event);
});

test("every wired hook is a command that points at an existing handler script", () => {
  for (const [event, groups] of Object.entries(hooks)) {
    for (const hook of groups.flatMap(group => group.hooks)) {
      assert.equal(hook.type, "command", event);
      const match = hook.command.match(/scripts\/([A-Za-z0-9_]+\.js)/);
      assert.ok(match, `${event}: command must invoke a scripts/*.js handler`);
      assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "scripts", match[1])), `${event}: ${match[1]} is missing`);
    }
  }
});

const EVENT = { session_id: "synthetic-session", tool_name: "synthetic", tool_input: { message: "synthetic event" } };
// Acknowledged organization and repository ON in Codex's consent record.
const enable = box => grantConsent(box.state, "github.com/acme/widgets");
const hashed = (box, value) => crypto.createHmac("sha256", box.credentials.hash_salt).update(value).digest("hex").slice(0, 12);

test("Stop hooks keep their JSON protocol while consent blocks capture", t => {
  const box = sandbox(t, { prefix: "codex-hooks" });
  for (const script of ["stop.js", "subagent_stop.js"]) {
    const result = box.script(script, { input: { ...EVENT, cwd: box.repo } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  assert.equal(box.spawned(), false);
  assert.deepEqual(box.events(), []);
});

for (const spelling of ["relative", "trailing slash"]) {
  test(`hook cwd normalization matches the routing keys: ${spelling}`, t => {
    const box = sandbox(t, { prefix: "codex-hooks" });
    enable(box);
    const cwd = spelling === "relative" ? "." : `${box.repo}/`;
    const result = box.script("pre_tool_use.js", { input: { ...EVENT, cwd } });
    assert.equal(result.status, 0, result.stderr);
    const [event] = box.events();
    const resolved = spelling === "relative" ? fs.realpathSync(box.repo) : box.repo;
    assert.equal(event.data.cwd, hashed(box, resolved));
    const routing = path.join(box.data, "logs/repository-routing");
    const states = fs.readdirSync(routing).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(routing, name))));
    assert.ok(states.some(state => state.directories?.[event.data.cwd] === resolved));
  });
}

for (const script of ["stop.js", "subagent_stop.js"]) {
  for (const failure of ["busy", "missing-checkout"]) {
    test(`${script} defers transcript capture when routing fails after the event is sealed: ${failure}`, t => {
      const box = sandbox(t, { prefix: "codex-hooks" });
      enable(box);
      // Injected at the final flush, after registration and the guarded capture request succeeded.
      fs.appendFileSync(box.preload, `
const fs = require("node:fs"), path = require("node:path");
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.call(this, from, to);
  if (from === path.join(process.env.PLUGIN_DATA, "logs/events.jsonl")) {
    ${failure === "busy" ? `
    const id = require("node:crypto").createHmac("sha256", ${JSON.stringify(box.credentials.hash_salt)}).update(fs.realpathSync(process.cwd())).digest("hex").slice(0, 12);
    fs.writeFileSync(path.join(process.env.PLUGIN_DATA, "logs/repository-routing", id + ".json.lock"), JSON.stringify({pid:process.pid}));
    ` : `
    const realpath = fs.realpathSync;
    fs.realpathSync = function(file, ...args) {
      if (file === ${JSON.stringify(box.repo)}) throw Object.assign(new Error("synthetic missing checkout"), {code:"ENOENT"});
      return realpath.call(this, file, ...args);
    };
    `}
  }
  return result;
};
`);
      const result = box.script(script, { input: { ...EVENT, cwd: box.repo } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {});
      assert.match(result.stderr, /routing unavailable.*capture deferred/);
      const captures = path.join(box.data, "logs/transcripts/captures-v1");
      assert.equal(fs.existsSync(captures), true);
      assert.deepEqual(fs.readdirSync(captures), []);
      assert.equal(fs.readdirSync(path.join(box.data, "logs")).filter(n => /^events\.jsonl\.\d+$/.test(n)).length, 1);
    });
  }
}

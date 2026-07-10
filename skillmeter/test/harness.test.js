"use strict";

/**
 * Unit tests for Level 1 harness detection — SBEE-166 (Phase 1) implementation
 * of the flat harness-metadata contract, updated for the v2.0 raw-identifier
 * schema (SBEE-170).
 * Run with:  node --test skillmeter/test/harness.test.js
 *
 * detectHarness is pure filesystem inspection, so each test builds a throwaway
 * project tree (and a fake $HOME) and asserts on the emitted metadata shape.
 * The contract under test (spec/harness-metadata-contract.v1.json, v2.0):
 *   - flat field set under data.harness; presence/shape metadata + RAW
 *     identifiers (skill/subagent/command/MCP/plugin names) and permission
 *     rules; never raw file CONTENT, hook command strings, or MCP env;
 *   - Level 2 (external_orchestration / multi_agent) is always "unknown";
 *   - detection never throws and degrades to safe defaults;
 *   - identifiers are emitted RAW (no HMAC hashing); a name embedding a
 *     secret is still DROPPED fail-closed and tallied in `redactions`;
 *   - the emitted block survives the sanitizeEventData boundary.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  detectHarness,
  findRepoRoot,
  sizeBucket,
  HARNESS_SCHEMA_VERSION,
} = require("../scripts/harness");
const sanitizer = require("../scripts/lib/sanitize");

const SALT = "deadbeefcafe";

// --- helpers ---------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, contents = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

// Build a fake project that looks like a git repo so findRepoRoot anchors here.
function makeProject() {
  const root = tmpDir("sk-harness-proj-");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function makeHome() {
  return tmpDir("sk-harness-home-");
}

function addSkill(root, namespaceOrName, maybeName) {
  const rel = maybeName
    ? path.join(".claude", "skills", namespaceOrName, maybeName, "SKILL.md")
    : path.join(".claude", "skills", namespaceOrName, "SKILL.md");
  write(path.join(root, rel), "# skill\n");
}

// ---------------------------------------------------------------------------

test("bare project: flat defaults, Level 2 unknown, no raw content", () => {
  const root = makeProject();
  const home = makeHome();

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.harness_schema_version, "2.1");
  assert.equal(h.agent_type, "claude-code");
  assert.equal(h.agent_version, "");
  // instructions
  assert.equal(h.has_claude_md, false);
  assert.equal(h.has_claude_local_md, false);
  assert.equal(h.has_user_claude_md, false);
  assert.equal(h.has_agents_md, false);
  assert.equal(h.claude_md_count, 0);
  assert.equal(h.claude_md_size_bucket, "none");
  assert.equal(h.claude_md_import_count, 0);
  // skills / subagents / commands / mcp
  assert.equal(h.skills_present, false);
  assert.equal(h.skills_count, 0);
  assert.deepEqual(h.skill_source_counts, { project: 0, user: 0, plugin: 0 });
  assert.deepEqual(h.skill_names, []);
  assert.deepEqual(h.skill_contents, []);
  assert.equal(h.subagents_present, false);
  assert.equal(h.subagents_count, 0);
  assert.deepEqual(h.subagent_names, []);
  assert.equal(h.subagent_used, false);
  assert.equal(h.commands_present, false);
  assert.deepEqual(h.command_names, []);
  assert.equal(h.has_mcp_config, false);
  assert.equal(h.mcp_servers_count, 0);
  assert.deepEqual(h.mcp_server_names, []);
  // permissions / sandbox
  assert.equal(h.permission_default_mode, "");
  assert.deepEqual(h.permission_allow, []);
  assert.deepEqual(h.permission_deny, []);
  assert.deepEqual(h.permission_ask, []);
  assert.equal(h.permission_additional_directories_count, 0);
  // hooks
  assert.deepEqual(h.hooks_enabled, []);
  assert.equal(h.hooks_count, 0);
  assert.deepEqual(h.hooks_source_counts, { user: 0, project: 0, local: 0, plugin: 0 });
  // plugins
  assert.equal(h.plugins_count, 0);
  assert.equal(h.marketplaces_count, 0);
  assert.deepEqual(h.plugins, []);
  // level 2
  assert.equal(h.external_orchestration, "unknown");
  assert.equal(h.multi_agent, "unknown");
  // sanitization bookkeeping
  assert.equal(h.policy_version, sanitizer.POLICY_VERSION);
  assert.deepEqual(h.redactions, { hashed_count: 0, dropped_count: 0, by_type: {} });
  // no legacy hashed fields
  assert.equal(h.skill_names_hashed, undefined);
});

test("harness_schema_version matches the exported contract version", () => {
  const root = makeProject();
  const h = detectHarness(root, { homeDir: makeHome(), repoRoot: root, hashSalt: SALT });
  assert.equal(h.harness_schema_version, HARNESS_SCHEMA_VERSION);
  assert.equal(h.harness_schema_version, "2.1");
});

test("carries runtime fields (agent_type, agent_version, model, session_source, plugin_version)", () => {
  const root = makeProject();
  const h = detectHarness(root, {
    homeDir: makeHome(),
    repoRoot: root,
    hashSalt: SALT,
    agentType: "claude-code-1.0",
    agentVersion: "2.3.4",
    model: "claude-sonnet-4",
    sessionSource: "startup",
    pluginVersion: "0.16.2",
  });
  assert.equal(h.agent_type, "claude-code-1.0");
  assert.equal(h.agent_version, "2.3.4");
  assert.equal(h.model, "claude-sonnet-4");
  assert.equal(h.session_source, "startup");
  assert.equal(h.plugin_version, "0.16.2");
});

test("instruction files: project CLAUDE.md/AGENTS.md/CLAUDE.local.md presence", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, "CLAUDE.md"), "# claude\n@./docs/a.md\n@./docs/b.md\n");
  write(path.join(root, "CLAUDE.local.md"), "# local\n");
  write(path.join(root, "AGENTS.md"), "# agents\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.has_claude_md, true);
  assert.equal(h.has_claude_local_md, true);
  assert.equal(h.has_agents_md, true);
  assert.equal(h.has_user_claude_md, false);
  assert.equal(h.claude_md_count, 1);
  assert.equal(h.claude_md_size_bucket, "xs");
  assert.equal(h.claude_md_import_count, 2);
});

test("detects user-level CLAUDE.md (~/.claude/CLAUDE.md)", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(home, ".claude", "CLAUDE.md"), "# global\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.has_claude_md, false);
  assert.equal(h.has_user_claude_md, true);
});

test("counts nested CLAUDE.md across the project tree, skipping node_modules", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, "CLAUDE.md"), "# root\n");
  write(path.join(root, "packages", "a", "CLAUDE.md"), "# a\n");
  write(path.join(root, "packages", "b", "CLAUDE.md"), "# b\n");
  write(path.join(root, "node_modules", "dep", "CLAUDE.md"), "# vendored, must be ignored\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });
  assert.equal(h.claude_md_count, 3);
});

test("size bucket helper boundaries", () => {
  assert.equal(sizeBucket(0), "none");
  assert.equal(sizeBucket(500), "xs");
  assert.equal(sizeBucket(2000), "s");
  assert.equal(sizeBucket(10000), "m");
  assert.equal(sizeBucket(40000), "l");
  assert.equal(sizeBucket(200000), "xl");
});

test("skills: count, per-source counts, RAW names; skips hidden .system", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  addSkill(root, "team", "review-pr"); // nested namespace
  addSkill(home, "signin"); // user-level (~/.claude/skills)
  write(path.join(home, ".claude", "skills", ".system", "imagegen", "SKILL.md"), "x");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.skills_present, true);
  assert.equal(h.skills_count, 3);
  assert.deepEqual(h.skill_source_counts, { project: 2, user: 1, plugin: 0 });
  // v2.0: names emitted raw, sorted, nothing hashed or dropped.
  assert.deepEqual(h.skill_names, ["deploy", "review-pr", "signin"]);
  assert.equal(h.redactions.hashed_count, 0);
  assert.equal(h.redactions.dropped_count, 0);
  assert.deepEqual(h.redactions.by_type, {});
});

test("skill names are emitted raw (v2.0), even without a hash salt", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "internal-workflow");
  // No salt passed: identifiers no longer depend on a salt.
  const h = detectHarness(root, { homeDir: home, repoRoot: root });
  assert.equal(h.skills_count, 1);
  assert.deepEqual(h.skill_names, ["internal-workflow"]);
  assert.equal(h.redactions.dropped_count, 0);
});

test("fail-closed: a skill name embedding a secret is dropped, not emitted", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  addSkill(root, "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.skills_count, 2); // true on-disk total
  assert.deepEqual(h.skill_names, ["deploy"]); // secret-bearing name excluded
  assert.equal(h.redactions.hashed_count, 0);
  assert.equal(h.redactions.dropped_count, 1);
  assert.deepEqual(h.redactions.by_type, { skill_name: 1 });
  // A skill dropped for a secret in its NAME must not have its body read either.
  assert.deepEqual(h.skill_contents.map((c) => c.name), ["deploy"]);
  // The secret must not appear anywhere in the payload.
  assert.ok(!JSON.stringify(h).includes("AKIAIOSFODNN7EXAMPLE"));
});

test("skill_contents: custom (project/user) skill body collected; plugin skills name-only", () => {
  const root = makeProject();
  const home = makeHome();
  write(
    path.join(root, ".claude", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Ship the app\n---\n1. run tests\n2. deploy\n"
  );
  const pluginsDir = path.join(home, ".claude", "plugins");
  write(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "toolkit@skillbench": [
          { scope: "user", version: "1.0.0", installPath: path.join(pluginsDir, "installed", "toolkit") },
        ],
      },
    })
  );
  write(
    path.join(pluginsDir, "installed", "toolkit", "skills", "bundled", "SKILL.md"),
    "---\ndescription: nope\n---\nplugin skill body\n"
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.deepEqual([...h.skill_names].sort(), ["bundled", "deploy"]);
  assert.equal(h.skill_contents.length, 1);
  const c = h.skill_contents[0];
  assert.equal(c.name, "deploy");
  assert.equal(c.description, "Ship the app");
  assert.match(c.body, /run tests/);
  assert.equal(c.truncated, false);
  assert.ok(!JSON.stringify(h.skill_contents).includes("plugin skill body"));
});

test("skill_contents: oversized body is truncated, original byte size preserved", () => {
  const root = makeProject();
  const home = makeHome();
  const big = "x".repeat(6000);
  write(path.join(root, ".claude", "skills", "big", "SKILL.md"), `---\ndescription: d\n---\n${big}`);

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });
  const c = h.skill_contents.find((s) => s.name === "big");
  assert.ok(c, "custom skill body present");
  assert.equal(c.truncated, true);
  assert.ok(c.body.length <= 4096, "body capped");
  assert.ok(c.bytes > 4096, "original size preserved");
});

test("subagents: .claude/agents/*.md detected, counted, raw names", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, ".claude", "agents", "reviewer.md"), "# reviewer\n");
  write(path.join(root, ".claude", "agents", "planner.md"), "# planner\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.subagents_present, true);
  assert.equal(h.subagents_count, 2);
  assert.deepEqual(h.subagent_names, ["planner", "reviewer"]);
  assert.equal(h.subagent_used, false);
});

test("slash commands: .claude/commands/**/*.md detected with namespacing, raw names", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, ".claude", "commands", "deploy.md"), "# deploy\n");
  write(path.join(root, ".claude", "commands", "git", "sync.md"), "# sync\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.commands_present, true);
  assert.equal(h.commands_count, 2);
  assert.deepEqual(h.command_names, ["deploy", "git:sync"]);
});

test("hooks: allow-listed event names, total entry count, and per-source counts", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginRoot = tmpDir("sk-harness-plugin-");
  write(
    path.join(pluginRoot, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{}, {}] }],
        Stop: [{}],
        SomethingCustom: [{}], // not allow-listed → filtered out
      },
    })
  );
  write(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{}] }] } })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, pluginRoot, hashSalt: SALT });

  assert.deepEqual(h.hooks_enabled, ["PreToolUse", "Stop", "UserPromptSubmit"]);
  // plugin: 2 (PreToolUse inner) + 1 (Stop) = 3; project: 1
  assert.equal(h.hooks_count, 4);
  assert.equal(h.hooks_source_counts.plugin, 3);
  assert.equal(h.hooks_source_counts.project, 1);
  assert.equal(h.hooks_source_counts.user, 0);
});

test("permissions: defaultMode + raw allow/deny/ask rules, additionalDirectories counted", () => {
  const root = makeProject();
  const home = makeHome();
  // User-level default mode; project rules override / add.
  write(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "default", allow: ["Read(src/**)"] } })
  );
  write(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        defaultMode: "acceptEdits",
        allow: ["Bash(npm run test:*)"],
        deny: ["Bash(rm:*)"],
        ask: ["WebFetch"],
        additionalDirectories: ["../shared", "/tmp/scratch"],
      },
    })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  // local > project > user precedence: project's acceptEdits wins over user default.
  assert.equal(h.permission_default_mode, "acceptEdits");
  assert.deepEqual([...h.permission_allow].sort(), ["Bash(npm run test:*)", "Read(src/**)"]);
  assert.deepEqual(h.permission_deny, ["Bash(rm:*)"]);
  assert.deepEqual(h.permission_ask, ["WebFetch"]);
  assert.equal(h.permission_additional_directories_count, 2);
});

test("MCP: .mcp.json servers detected with RAW names; command/env never read", () => {
  const root = makeProject();
  const home = makeHome();
  write(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "server"], env: { TOKEN: "ghp_secret" } },
        sentry: { command: "uvx", args: ["sentry"] },
      },
    })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.has_mcp_config, true);
  assert.equal(h.mcp_servers_count, 2);
  assert.deepEqual(h.mcp_server_names, ["github", "sentry"]); // raw
  // Server config (command / args / env) must NOT leak.
  const blob = JSON.stringify(h);
  assert.ok(!blob.includes("ghp_secret"));
  assert.ok(!blob.includes("npx"));
});

test("plugins/marketplaces: names raw, marketplace + public flag retained", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginsDir = path.join(home, ".claude", "plugins");
  write(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "skillmeter@skillbench": [{ scope: "user", version: "0.16.2", installPath: "/x" }],
        "inhouse-tool@acme-private": [{ scope: "user", version: "1.0.0", installPath: "/y" }],
      },
    })
  );
  write(
    path.join(pluginsDir, "known_marketplaces.json"),
    JSON.stringify({ skillbench: {}, "claude-plugins-official": {} })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.plugins_count, 2);
  assert.equal(h.marketplaces_count, 2);

  const pub = h.plugins.find((p) => p.name === "skillmeter");
  assert.ok(pub, "public-marketplace plugin name kept raw");
  assert.equal(pub.version, "0.16.2");
  assert.equal(pub.marketplace, "skillbench");
  assert.equal(pub.public, true);

  const priv = h.plugins.find((p) => p.name === "inhouse-tool");
  assert.ok(priv, "private plugin name also raw (v2.0)");
  assert.equal(priv.version, "1.0.0");
  assert.equal(priv.marketplace, "acme-private");
  assert.equal(priv.public, false);
  // No legacy name_hashed field.
  assert.ok(h.plugins.every((p) => p.name_hashed === undefined));
});

test("fail-closed: a plugin name embedding a secret is dropped", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginsDir = path.join(home, ".claude", "plugins");
  write(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "ok-tool@skillbench": [{ scope: "user", version: "1.0.0", installPath: "/x" }],
        "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE@acme": [
          { scope: "user", version: "1.0.0", installPath: "/y" },
        ],
      },
    })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.plugins_count, 2); // true on-disk total
  assert.equal(h.plugins.length, 1); // secret-bearing entry dropped
  assert.equal(h.plugins[0].name, "ok-tool");
  assert.equal(h.redactions.by_type.plugin_name, 1);
  assert.ok(!JSON.stringify(h).includes("AKIAIOSFODNN7EXAMPLE"));
});

test("never throws on a bogus cwd; returns safe defaults", () => {
  const h = detectHarness("/nonexistent/path/ bad", {
    homeDir: "/also/nonexistent",
    repoRoot: "",
    hashSalt: SALT,
  });
  assert.equal(h.harness_schema_version, "2.1");
  assert.equal(h.skills_count, 0);
  assert.deepEqual(h.hooks_enabled, []);
  assert.equal(h.multi_agent, "unknown");
});

test("malformed settings.json is ignored, not fatal", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginRoot = tmpDir("sk-harness-plugin-");
  write(path.join(pluginRoot, "hooks", "hooks.json"), "{ not valid json");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, pluginRoot, hashSalt: SALT });
  assert.deepEqual(h.hooks_enabled, []);
  assert.equal(h.hooks_count, 0);
});

test("emitted harness object survives the sanitizeEventData boundary", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, "CLAUDE.md"), "# claude\n");
  addSkill(root, "deploy");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });
  const { value, meta } = sanitizer.sanitizeEventData({ harness: h });

  assert.equal(meta.secrets, 0);
  assert.equal(value.harness.has_claude_md, true);
  assert.equal(value.harness.skills_count, 1);
  assert.deepEqual(value.harness.skill_names, ["deploy"]);
});

test("findRepoRoot walks up to the .git marker", () => {
  const root = makeProject();
  const nested = path.join(root, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepoRoot(nested), path.resolve(root));
});

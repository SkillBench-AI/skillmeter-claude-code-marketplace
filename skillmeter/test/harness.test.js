"use strict";

/**
 * Unit tests for Level 1 harness detection — SBEE-166 (Phase 1) implementation
 * of the flat SBEE-164 harness-metadata contract, with the SBEE-165
 * sanitization integration.
 * Run with:  node --test skillmeter/test/harness.test.js
 *
 * detectHarness is pure filesystem inspection, so each test builds a throwaway
 * project tree (and a fake $HOME) and asserts on the emitted metadata shape.
 * The contract under test (spec/harness-metadata-contract.v1.json):
 *   - flat field set under data.harness; presence/shape metadata only, never
 *     raw file contents, hook command strings, or MCP env;
 *   - Level 2 (external_orchestration / multi_agent) is always "unknown";
 *   - detection never throws and degrades to safe defaults;
 *   - tier2_business names (skill/subagent/command/MCP/private plugin) are
 *     HMAC-hashed; public-marketplace plugin names stay raw;
 *   - Tier 1 fail-closed name scanning + redaction bookkeeping;
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

const HASH12 = /^[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------

test("bare project: flat defaults, Level 2 unknown, no raw content", () => {
  const root = makeProject();
  const home = makeHome();

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.harness_schema_version, "1.0");
  assert.equal(h.agent_type, "claude-code");
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
  assert.deepEqual(h.skill_names_hashed, []);
  assert.equal(h.subagents_present, false);
  assert.equal(h.subagents_count, 0);
  assert.equal(h.subagent_used, false);
  assert.equal(h.commands_present, false);
  assert.equal(h.has_mcp_config, false);
  assert.equal(h.mcp_servers_count, 0);
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
});

test("harness_schema_version matches the exported contract version", () => {
  const root = makeProject();
  const h = detectHarness(root, { homeDir: makeHome(), repoRoot: root, hashSalt: SALT });
  assert.equal(h.harness_schema_version, HARNESS_SCHEMA_VERSION);
  assert.equal(h.harness_schema_version, "1.0");
});

test("carries runtime fields (agent_type, model, session_source, plugin_version)", () => {
  const root = makeProject();
  const h = detectHarness(root, {
    homeDir: makeHome(),
    repoRoot: root,
    hashSalt: SALT,
    agentType: "claude-code-1.0",
    model: "claude-sonnet-4",
    sessionSource: "startup",
    pluginVersion: "0.16.2",
  });
  assert.equal(h.agent_type, "claude-code-1.0");
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

test("skills: count, per-source counts, hashed names; skips hidden .system", () => {
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
  assert.equal(h.skill_names_hashed.length, 3);
  for (const t of h.skill_names_hashed) assert.match(t, HASH12);
  assert.equal(h.redactions.hashed_count, 3);
  assert.deepEqual(h.redactions.by_type, { skill_name: 3 });
});

test("skill names are never emitted in plaintext", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "secret-internal-workflow");
  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });
  assert.equal(h.skill_names, undefined);
  assert.equal(h.skill_names_hashed.length, 1);
  assert.notEqual(h.skill_names_hashed[0], "secret-internal-workflow");
});

test("without a hash salt, tier2 names are dropped, not leaked", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  const h = detectHarness(root, { homeDir: home, repoRoot: root }); // no salt
  assert.equal(h.skills_count, 1); // count is still exact
  assert.deepEqual(h.skill_names_hashed, []);
  assert.equal(h.redactions.dropped_count, 1);
});

test("Tier 1 fail-closed: a skill name embedding a secret is dropped, not hashed", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  addSkill(root, "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.skills_count, 2); // true on-disk total
  assert.equal(h.skill_names_hashed.length, 1); // secret-bearing name excluded
  assert.equal(h.redactions.dropped_count, 1);
  assert.equal(h.redactions.hashed_count, 1);
  assert.deepEqual(h.redactions.by_type, { skill_name: 2 });
});

test("subagents: .claude/agents/*.md detected, counted, hashed", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, ".claude", "agents", "reviewer.md"), "# reviewer\n");
  write(path.join(root, ".claude", "agents", "planner.md"), "# planner\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.subagents_present, true);
  assert.equal(h.subagents_count, 2);
  assert.equal(h.subagent_names_hashed.length, 2);
  for (const t of h.subagent_names_hashed) assert.match(t, HASH12);
  assert.equal(h.subagent_used, false);
  assert.equal(h.redactions.by_type.subagent_name, 2);
});

test("slash commands: .claude/commands/**/*.md detected with namespacing", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, ".claude", "commands", "deploy.md"), "# deploy\n");
  write(path.join(root, ".claude", "commands", "git", "sync.md"), "# sync\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.commands_present, true);
  assert.equal(h.commands_count, 2);
  assert.equal(h.command_names_hashed.length, 2);
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

test("MCP: .mcp.json servers detected and hashed; values never read", () => {
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
  assert.equal(h.mcp_server_names_hashed.length, 2);
  for (const t of h.mcp_server_names_hashed) assert.match(t, HASH12);
  // The hashed tokens must not be the raw names, and no command/env leaks.
  const blob = JSON.stringify(h);
  assert.ok(!blob.includes("ghp_secret"));
  assert.ok(!blob.includes("npx"));
});

test("plugins/marketplaces: public names raw, private names hashed", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginsDir = path.join(home, ".claude", "plugins");
  write(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "skillmeter@skillbench": [{ scope: "user", version: "0.16.2", installPath: "/x" }],
        "secret-tool@acme-private": [{ scope: "user", version: "1.0.0", installPath: "/y" }],
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
  const skillmeter = h.plugins.find((p) => p.name === "skillmeter");
  assert.ok(skillmeter, "public-marketplace plugin name kept raw");
  assert.equal(skillmeter.version, "0.16.2");
  const priv = h.plugins.find((p) => p.name_hashed);
  assert.ok(priv, "private plugin name hashed");
  assert.match(priv.name_hashed, HASH12);
  assert.equal(priv.version, "1.0.0");
  const blob = JSON.stringify(h.plugins);
  assert.ok(!blob.includes("secret-tool"));
});

test("never throws on a bogus cwd; returns safe defaults", () => {
  const h = detectHarness("/nonexistent/path/ bad", {
    homeDir: "/also/nonexistent",
    repoRoot: "",
    hashSalt: SALT,
  });
  assert.equal(h.harness_schema_version, "1.0");
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

  assert.equal(meta.tier1, 0);
  assert.equal(value.harness.has_claude_md, true);
  assert.equal(value.harness.skills_count, 1);
  assert.equal(value.harness.skill_names_hashed.length, 1);
});

test("findRepoRoot walks up to the .git marker", () => {
  const root = makeProject();
  const nested = path.join(root, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepoRoot(nested), path.resolve(root));
});

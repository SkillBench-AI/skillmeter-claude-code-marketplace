"use strict";
// Harness detection from synthetic projects and homes: raw identifiers,
// bounded skill bodies, no config secrets, and safe defaults.
const os = require("os");
const fs = require("fs");
const path = require("path");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  detectHarness,
  findRepoRoot,
  parseCodexConfig,
  sizeBucket,
  HARNESS_SCHEMA_VERSION,
} = require("../../scripts/harness");
const sanitizer = require("../../scripts/sanitizer");

const SALT = "deadbeefcafe";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, contents = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

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
    ? path.join(".codex", "skills", namespaceOrName, maybeName, "SKILL.md")
    : path.join(".codex", "skills", namespaceOrName, "SKILL.md");
  write(path.join(root, rel), "# skill\n");
}

test("bare project: flat defaults, Level 2 unknown, no raw content", () => {
  const root = makeProject();
  const home = makeHome();

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.harness_schema_version, HARNESS_SCHEMA_VERSION);
  assert.equal(HARNESS_SCHEMA_VERSION, "2.1", "consumers depend on this version");
  assert.equal(h.agent_type, "codex");
  assert.equal(h.agent_version, "");
  assert.equal(h.has_agents_md, false);
  assert.equal(h.has_claude_md, false);
  assert.equal(h.has_user_claude_md, false);
  assert.equal(h.claude_md_count, 0);
  assert.equal(h.claude_md_size_bucket, "none");
  assert.equal(h.skills_present, false);
  assert.equal(h.skills_count, 0);
  assert.deepEqual(h.skill_source_counts, { project: 0, user: 0, plugin: 0 });
  assert.deepEqual(h.skill_names, []);
  assert.deepEqual(h.skill_contents, []);
  assert.equal(h.subagents_count, 0);
  assert.deepEqual(h.subagent_names, []);
  assert.equal(h.subagent_used, false);
  assert.equal(h.commands_count, 0);
  assert.deepEqual(h.command_names, []);
  assert.equal(h.has_mcp_config, false);
  assert.deepEqual(h.mcp_server_names, []);
  assert.equal(h.permission_default_mode, "");
  assert.deepEqual(h.permission_allow, []);
  assert.deepEqual(h.permission_deny, []);
  assert.deepEqual(h.permission_ask, []);
  assert.equal(h.permission_additional_directories_count, 0);
  assert.deepEqual(h.hooks_enabled, []);
  assert.equal(h.hooks_count, 0);
  assert.deepEqual(h.hooks_source_counts, { user: 0, project: 0, local: 0, plugin: 0 });
  assert.equal(h.plugins_count, 0);
  assert.equal(h.marketplaces_count, 0);
  assert.deepEqual(h.plugins, []);
  assert.equal(h.external_orchestration, "unknown");
  assert.equal(h.multi_agent, "unknown");
  assert.equal(h.policy_version, sanitizer.POLICY_VERSION);
  assert.deepEqual(h.redactions, { hashed_count: 0, dropped_count: 0, by_type: {} });
  assert.equal(h.skill_names_hashed, undefined);
});

test("carries runtime fields (agent_type, agent_version, model, session_source, plugin_version)", () => {
  const root = makeProject();
  const h = detectHarness(root, {
    homeDir: makeHome(),
    repoRoot: root,
    hashSalt: SALT,
    agentType: "codex",
    agentVersion: "0.9.0",
    model: "gpt-5.5",
    sessionSource: "startup",
    pluginVersion: "0.2.1",
  });
  assert.equal(h.agent_type, "codex");
  assert.equal(h.agent_version, "0.9.0");
  assert.equal(h.model, "gpt-5.5");
  assert.equal(h.session_source, "startup");
  assert.equal(h.plugin_version, "0.2.1");
});

test("instruction files: project AGENTS.md + CLAUDE.md presence and metrics", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, "AGENTS.md"), "# agents\n");
  write(path.join(root, "CLAUDE.md"), "# claude\n@./a.md\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.has_agents_md, true);
  assert.equal(h.has_claude_md, true);
  assert.equal(h.has_user_claude_md, false);
  assert.equal(h.claude_md_count, 1);
  assert.equal(h.claude_md_size_bucket, "xs");
  assert.equal(h.claude_md_import_count, 1);
});

test("detects user-level CLAUDE.md (~/.claude/CLAUDE.md)", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(home, ".claude", "CLAUDE.md"), "# global\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });
  assert.equal(h.has_user_claude_md, true);
});

test("skills: count, per-source counts, RAW names; skips hidden .system", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  addSkill(root, "team", "review-pr");
  addSkill(home, "signin"); // user-level (~/.codex/skills)
  write(path.join(home, ".codex", "skills", ".system", "imagegen", "SKILL.md"), "x");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.skills_present, true);
  assert.equal(h.skills_count, 3);
  assert.deepEqual(h.skill_source_counts, { project: 2, user: 1, plugin: 0 });
  assert.deepEqual(h.skill_names, ["deploy", "review-pr", "signin"]);
  assert.equal(h.redactions.hashed_count, 0);
  assert.equal(h.redactions.dropped_count, 0);
});

test("skill names are emitted raw (v2.0), even without a hash salt", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "internal-workflow");
  const h = detectHarness(root, { homeDir: home, repoRoot: root });
  assert.deepEqual(h.skill_names, ["internal-workflow"]);
});

test("Tier 1 fail-closed: a skill name embedding a secret is dropped, not emitted", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  addSkill(root, "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.skills_count, 2);
  assert.deepEqual(h.skill_names, ["deploy"]);
  assert.equal(h.redactions.dropped_count, 1);
  assert.equal(h.redactions.hashed_count, 0);
  assert.deepEqual(h.redactions.by_type, { skill_name: 1 });
  // A skill dropped for a secret in its NAME must not have its body read either.
  assert.deepEqual(h.skill_contents.map((c) => c.name), ["deploy"]);
  assert.ok(!JSON.stringify(h).includes("AKIAIOSFODNN7EXAMPLE"));
});

test("skill_contents: custom project/user skill body collected with frontmatter", () => {
  const root = makeProject();
  const home = makeHome();
  write(
    path.join(root, ".codex", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Ship the app\n---\n1. run tests\n2. deploy\n"
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.deepEqual(h.skill_names, ["deploy"]);
  assert.equal(h.skill_contents.length, 1);
  const c = h.skill_contents[0];
  assert.equal(c.name, "deploy");
  assert.equal(c.description, "Ship the app");
  assert.match(c.body, /run tests/);
  assert.equal(c.truncated, false);
});

test("subagents: .codex/agents/*.md detected, counted, raw names", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, ".codex", "agents", "reviewer.md"), "# reviewer\n");
  write(path.join(root, ".codex", "agents", "planner.md"), "# planner\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.subagents_present, true);
  assert.equal(h.subagents_count, 2);
  assert.deepEqual(h.subagent_names, ["planner", "reviewer"]);
  assert.equal(h.subagent_used, false);
});

test("slash commands: .codex/commands + ~/.codex/prompts detected, raw names", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, ".codex", "commands", "deploy.md"), "# deploy\n");
  write(path.join(home, ".codex", "prompts", "summarize.md"), "# summarize\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.commands_present, true);
  assert.equal(h.commands_count, 2);
  assert.deepEqual([...h.command_names].sort(), ["deploy", "summarize"]);
});

test("hooks: allow-listed event names, entry count, and per-source counts", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginRoot = tmpDir("sk-harness-plugin-");
  write(
    path.join(pluginRoot, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{}, {}] }],
        Stop: [{}],
        SomethingCustom: [{}],
      },
    })
  );
  write(
    path.join(root, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{}] } })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, pluginRoot, hashSalt: SALT });

  assert.deepEqual(h.hooks_enabled, ["PreToolUse", "Stop", "UserPromptSubmit"]);
  assert.equal(h.hooks_count, 4); // plugin: 2+1, project: 1
  assert.equal(h.hooks_source_counts.plugin, 3);
  assert.equal(h.hooks_source_counts.project, 1);
});

test("sandbox: permission_default_mode from config.toml sandbox_mode", () => {
  const root = makeProject();
  const home = makeHome();
  write(
    path.join(home, ".codex", "config.toml"),
    [
      'model = "gpt-5.5"',
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      "",
      "[mcp_servers.github]",
      'command = "npx"',
    ].join("\n")
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });
  // sandbox_mode preferred over approval_policy.
  assert.equal(h.permission_default_mode, "workspace-write");
  // Codex has no allow/deny/ask rule arrays.
  assert.deepEqual(h.permission_allow, []);
});

test("MCP / plugins / marketplaces parsed from ~/.codex/config.toml, raw names", () => {
  const root = makeProject();
  const home = makeHome();
  write(
    path.join(home, ".codex", "config.toml"),
    [
      'model = "gpt-5.5"',
      "",
      "[marketplaces.openai-bundled]",
      'source_type = "local"',
      "",
      "[marketplaces.skillbench]",
      'source = "/x"',
      "",
      '[plugins."computer-use@openai-bundled"]',
      "enabled = true",
      "",
      '[plugins."inhouse-tool@acme-private"]',
      "enabled = true",
      "",
      "[mcp_servers.github]",
      'command = "npx"',
      'env = { GITHUB_TOKEN = "ghp_secretvalue" }',
      "",
      "[mcp_servers.sentry]",
      'command = "uvx"',
    ].join("\n")
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });

  assert.equal(h.marketplaces_count, 2);
  assert.equal(h.plugins_count, 2);

  const pub = h.plugins.find((p) => p.name === "computer-use");
  assert.ok(pub, "public-marketplace plugin kept raw");
  assert.equal(pub.public, true);
  assert.equal(pub.marketplace, "openai-bundled");
  assert.equal(pub.version, undefined); // Codex config carries no version

  const priv = h.plugins.find((p) => p.name === "inhouse-tool");
  assert.ok(priv, "private plugin name also raw (v2.0)");
  assert.equal(priv.public, false);
  assert.ok(h.plugins.every((p) => p.name_hashed === undefined));

  assert.equal(h.has_mcp_config, true);
  assert.equal(h.mcp_servers_count, 2);
  assert.deepEqual(h.mcp_server_names, ["github", "sentry"]);

  // No MCP env / command leaks into the payload.
  const blob = JSON.stringify(h);
  assert.ok(!blob.includes("ghp_secretvalue"));
  assert.ok(!blob.includes("npx"));
});

test("parseCodexConfig: honours quoted keys, sandbox scalars, ignores subtables/values", () => {
  const home = makeHome();
  const toml = path.join(home, "config.toml");
  write(
    toml,
    [
      'sandbox_mode = "read-only"',
      'approval_policy = "never"',
      "[marketplaces.skillbench]",
      "[marketplaces.skillbench.extra]", // subtable: still same top-level name
      '[plugins."a@b"]',
      "[mcp_servers.svc]",
      'sandbox_mode = "not-top-level"', // under a table — must be ignored
      "[hooks.state.foo]", // unrelated table — ignored
      "not a table line",
    ].join("\n")
  );
  const cfg = parseCodexConfig(toml);
  assert.deepEqual([...cfg.marketplaces].sort(), ["skillbench"]);
  assert.deepEqual([...cfg.pluginKeys], ["a@b"]);
  assert.deepEqual([...cfg.mcpServers], ["svc"]);
  assert.equal(cfg.sandboxMode, "read-only");
  assert.equal(cfg.approvalPolicy, "never");
});

test("a bogus cwd and home never throw and yield the same defaults", () => {
  const bogus = detectHarness("/nonexistent/path/ bad", { homeDir: "/also/nonexistent", repoRoot: "", hashSalt: SALT });
  const root = makeProject();
  const bare = detectHarness(root, { homeDir: makeHome(), repoRoot: root, hashSalt: SALT });
  assert.deepEqual(bogus, bare);
});

test("malformed hooks.json is ignored, not fatal", () => {
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
  write(path.join(root, "AGENTS.md"), "# agents\n");
  addSkill(root, "deploy");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, hashSalt: SALT });
  const { value, meta } = sanitizer.sanitizeEventData({ harness: h });

  assert.equal(meta.secrets, 0);
  assert.equal(value.harness.has_agents_md, true);
  assert.equal(value.harness.skills_count, 1);
  assert.deepEqual(value.harness.skill_names, ["deploy"]);
});

test("sizeBucket boundaries", () => {
  assert.equal(sizeBucket(0), "none");
  assert.equal(sizeBucket(500), "xs");
  assert.equal(sizeBucket(2000), "s");
  assert.equal(sizeBucket(10000), "m");
  assert.equal(sizeBucket(40000), "l");
  assert.equal(sizeBucket(200000), "xl");
});

test("findRepoRoot walks up to the .git marker", () => {
  const root = makeProject();
  const nested = path.join(root, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepoRoot(nested), path.resolve(root));
});

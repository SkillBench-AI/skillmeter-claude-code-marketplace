"use strict";

/**
 * Unit tests for Level 1 harness detection (SBEE-163, Phase 1) and its Phase 2
 * sanitization integration (SBEE-165).
 * Run with:  node --test skillmeter/test/harness.test.js
 *
 * detectHarness is pure filesystem inspection, so each test builds a throwaway
 * project tree (and a fake $HOME) and asserts on the emitted metadata shape.
 * The contract under test:
 *   - presence/shape metadata only, never raw file contents;
 *   - Level 2 (orchestration / multi-agent) is always "unknown";
 *   - detection never throws and degrades to safe defaults;
 *   - skill names can be hashed instead of emitted in plaintext;
 *   - Phase 2: policy_version + redaction bookkeeping, Tier 1 fail-closed name
 *     scanning, and survival of the sanitizeEventData boundary.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { detectHarness, findRepoRoot, HARNESS_SCHEMA_VERSION } = require("../scripts/harness");
const sanitizer = require("../scripts/lib/sanitize");

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
  // addSkill(root, "name") or addSkill(root, "namespace", "name")
  const rel = maybeName
    ? path.join(".claude", "skills", namespaceOrName, maybeName, "SKILL.md")
    : path.join(".claude", "skills", namespaceOrName, "SKILL.md");
  write(path.join(root, rel), "# skill\n");
}

// ---------------------------------------------------------------------------

test("bare project: empty defaults, Level 2 unknown, no raw content", () => {
  const root = makeProject();
  const home = makeHome();

  const h = detectHarness(root, { homeDir: home, repoRoot: root });

  assert.equal(h.schema_version, 2);
  assert.equal(h.agent_type, "claude-code");
  assert.equal(h.instructions.has_claude_md, false);
  assert.equal(h.instructions.has_agents_md, false);
  assert.deepEqual(h.instructions.scopes, []);
  assert.equal(h.skills.count, 0);
  assert.deepEqual(h.skills.names, []);
  assert.deepEqual(h.hooks.enabled, []);
  assert.equal(h.orchestration.external_orchestration, "unknown");
  assert.equal(h.orchestration.multi_agent, "unknown");
  // Phase 2 (SBEE-165): policy versioning + redaction bookkeeping defaults.
  assert.equal(h.policy_version, sanitizer.POLICY_VERSION);
  assert.deepEqual(h.redactions, { hashed_count: 0, dropped_count: 0, by_type: {} });
});

test("schema_version reflects the bumped Phase 2 payload shape", () => {
  const root = makeProject();
  const home = makeHome();
  const h = detectHarness(root, { homeDir: home, repoRoot: root });
  assert.equal(h.schema_version, HARNESS_SCHEMA_VERSION);
  assert.equal(h.schema_version, 2);
});

test("respects the agent_type override", () => {
  const root = makeProject();
  const home = makeHome();
  const h = detectHarness(root, { homeDir: home, repoRoot: root, agentType: "claude-code-1.0" });
  assert.equal(h.agent_type, "claude-code-1.0");
});

test("detects project CLAUDE.md and AGENTS.md presence (project scope)", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, "CLAUDE.md"), "# claude\n");
  write(path.join(root, "AGENTS.md"), "# agents\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root });

  assert.equal(h.instructions.has_claude_md, true);
  assert.equal(h.instructions.has_agents_md, true);
  assert.equal(h.instructions.has_claude_md_global, false);
  assert.deepEqual(h.instructions.scopes, ["project"]);
});

test("detects global instruction files (~/.claude/CLAUDE.md, ~/.claude/AGENTS.md)", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(home, ".claude", "CLAUDE.md"), "# global claude\n");
  write(path.join(home, ".claude", "AGENTS.md"), "# global agents\n");

  const h = detectHarness(root, { homeDir: home, repoRoot: root });

  assert.equal(h.instructions.has_claude_md, false);
  assert.equal(h.instructions.has_claude_md_global, true);
  assert.equal(h.instructions.has_agents_md_global, true);
  assert.deepEqual(h.instructions.scopes, ["global"]);
});

test("counts skills (project + global), skips hidden .system namespace", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  addSkill(root, "team", "review-pr"); // nested namespace
  addSkill(home, "signin"); // global
  // Hidden runtime namespace must be ignored.
  write(path.join(home, ".claude", "skills", ".system", "imagegen", "SKILL.md"), "x");

  const h = detectHarness(root, { homeDir: home, repoRoot: root });

  assert.equal(h.skills.count, 3);
  assert.deepEqual(h.skills.names, ["deploy", "review-pr", "signin"]);
  assert.deepEqual(h.skills.scopes, ["global", "project"]);
});

test("hashes skill names when requested, omitting plaintext", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "secret-internal-workflow");

  const h = detectHarness(root, {
    homeDir: home,
    repoRoot: root,
    hashSalt: "deadbeef",
    hashSkillNames: true,
  });

  assert.equal(h.skills.count, 1);
  assert.equal(h.skills.names, undefined);
  assert.equal(h.skills.names_hashed.length, 1);
  assert.notEqual(h.skills.names_hashed[0], "secret-internal-workflow");
  assert.match(h.skills.names_hashed[0], /^[0-9a-f]{12}$/);
  // Each hashed name is accounted for in the Phase 2 redaction bookkeeping.
  assert.equal(h.redactions.hashed_count, 1);
  assert.equal(h.redactions.dropped_count, 0);
  assert.deepEqual(h.redactions.by_type, { skill_name: 1 });
});

test("Tier 1 fail-closed: a skill name embedding a secret is dropped, not hashed", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "deploy");
  addSkill(root, "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");

  const h = detectHarness(root, { homeDir: home, repoRoot: root });

  // count still reflects the true on-disk total (a non-sensitive integer)...
  assert.equal(h.skills.count, 2);
  // ...but the secret-bearing name never makes it into the emitted list.
  assert.deepEqual(h.skills.names, ["deploy"]);
  assert.equal(h.redactions.dropped_count, 1);
  assert.equal(h.redactions.hashed_count, 0);
  assert.deepEqual(h.redactions.by_type, { skill_name: 1 });
});

test("Tier 1 dropped names are excluded even when hashing is enabled", () => {
  const root = makeProject();
  const home = makeHome();
  addSkill(root, "review-pr");
  addSkill(root, "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

  const h = detectHarness(root, {
    homeDir: home,
    repoRoot: root,
    hashSalt: "deadbeef",
    hashSkillNames: true,
  });

  assert.equal(h.skills.count, 2);
  assert.equal(h.skills.names, undefined);
  assert.equal(h.skills.names_hashed.length, 1);
  assert.equal(h.redactions.hashed_count, 1);
  assert.equal(h.redactions.dropped_count, 1);
  assert.deepEqual(h.redactions.by_type, { skill_name: 2 });
});

test("reports hook events from the plugin hooks.json, allow-listed only", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginRoot = tmpDir("sk-harness-plugin-");
  write(
    path.join(pluginRoot, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{}],
        PostToolUse: [{}],
        Stop: [{}],
        // Not a known event — must be filtered out so arbitrary strings can't
        // ride along in the metadata.
        SomethingCustom: [{}],
      },
    })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, pluginRoot });

  assert.deepEqual(h.hooks.enabled, ["PostToolUse", "PreToolUse", "Stop"]);
  assert.deepEqual(h.hooks.scopes, ["plugin"]);
});

test("unions hook events across plugin hooks.json + project settings.json", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginRoot = tmpDir("sk-harness-plugin-");
  write(
    path.join(pluginRoot, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{}] } })
  );
  // Claude project hooks live under .claude/settings.json with the same shape.
  write(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{}] }] } })
  );

  const h = detectHarness(root, { homeDir: home, repoRoot: root, pluginRoot });

  assert.deepEqual(h.hooks.enabled, ["SessionStart", "UserPromptSubmit"]);
  assert.deepEqual(h.hooks.scopes, ["plugin", "project"]);
});

test("includes plugin name/version when provided", () => {
  const root = makeProject();
  const home = makeHome();

  const h = detectHarness(root, {
    homeDir: home,
    repoRoot: root,
    pluginVersion: "1.2.3",
  });

  assert.deepEqual(h.plugin, { name: "skillmeter", version: "1.2.3" });
});

test("never throws on a bogus cwd; returns safe defaults", () => {
  const h = detectHarness("/nonexistent/path/\u0000bad", {
    homeDir: "/also/nonexistent",
    repoRoot: "",
  });
  assert.equal(h.schema_version, 2);
  assert.equal(h.skills.count, 0);
  assert.deepEqual(h.hooks.enabled, []);
  assert.equal(h.orchestration.multi_agent, "unknown");
});

test("malformed settings.json is ignored, not fatal", () => {
  const root = makeProject();
  const home = makeHome();
  const pluginRoot = tmpDir("sk-harness-plugin-");
  write(path.join(pluginRoot, "hooks", "hooks.json"), "{ not valid json");

  const h = detectHarness(root, { homeDir: home, repoRoot: root, pluginRoot });
  assert.deepEqual(h.hooks.enabled, []);
});

test("emitted harness object survives the sanitizeEventData boundary", () => {
  const root = makeProject();
  const home = makeHome();
  write(path.join(root, "CLAUDE.md"), "# claude\n");
  addSkill(root, "deploy");

  const h = detectHarness(root, { homeDir: home, repoRoot: root });
  const { value, meta } = sanitizer.sanitizeEventData({ harness: h });

  // No secrets in the metadata, so nothing is redacted and structure is intact.
  assert.equal(meta.tier1, 0);
  assert.equal(value.harness.instructions.has_claude_md, true);
  assert.deepEqual(value.harness.skills.names, ["deploy"]);
});

test("findRepoRoot walks up to the .git marker", () => {
  const root = makeProject();
  const nested = path.join(root, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepoRoot(nested), path.resolve(root));
});

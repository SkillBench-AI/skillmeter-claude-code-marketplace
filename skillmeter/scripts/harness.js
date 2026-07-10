"use strict";

/**
 * Harness detection — SBEE-166 (Phase 1) implementation of the locked SBEE-164
 * harness-metadata contract (`spec/harness-metadata-contract.v1.json`), with the
 * SBEE-165 sanitization integration baked in.
 *
 * "Harness" = the scaffolding a developer wraps around their coding agent:
 * instruction files (CLAUDE.md / AGENTS.md), skills, subagents, slash commands,
 * lifecycle hooks, MCP servers, plugins/marketplaces, and higher-level
 * orchestration. Analysis needs to know whether a session was run bare or with a
 * sophisticated harness so it can judge the work fairly.
 *
 * This module emits the contract's **flat** `data.harness` field set. As of
 * schema v2.0 (SBEE-170, analysis-side request) it carries harness identifiers
 * — skill / subagent / command / MCP server / plugin names — as **raw** values
 * so the analysis pipeline can do semantic work (e.g. join public skill names to
 * the catalog) that opaque hashes made impossible. As of schema v2.1 (SBEE-169)
 * it also emits the SKILL.md body of CUSTOM (project/user) skills — which have no
 * public catalog to join against — size-capped and secret-scrubbed. It still
 * never emits CLAUDE.md/AGENTS.md bodies, hook command strings, or MCP
 * command/args/env (those carry literal secrets; see below). It is
 * deterministic, filesystem-only, and must never throw: detection
 * runs inside the SessionStart hook and a failure here must not break the
 * session, so every probe is wrapped and falls back to a safe default.
 *
 * Detection levels (contract `detectionLevels`):
 *   - Level 1 (filesystem-detectable): everything collected here.
 *   - Level 2 (architecture-level, NOT detectable): external orchestration /
 *     multi-agent topology. Emitted as "unknown" (SBEE-168) — `multi_agent` may
 *     be upgraded to "present" downstream once a subagent is observed running.
 *
 * Privacy (SANITIZATION_EPIC.md 3-tier policy, contract `tiers`/`actions`):
 *   - tier3_safe values (presence/counts/buckets/enums/versions) are collected
 *     raw.
 *   - Harness identifiers (skill / subagent / command / MCP / plugin names) are
 *     collected raw in v2.0. Names/permission rules that embed a secret
 *     are STILL dropped fail-closed — "raw names" never means "leak a
 *     credential" (epic Guiding Principle #1). Every string in the block is also
 *     routed through the central `sanitizeEventData` secret/PII boundary by
 *     the caller as a catch-all before egress.
 *   - Secret material (hook commands, MCP command/args/env) is never
 *     collected: those fields hold API keys/tokens directly, so they stay out
 *     regardless of the identifier policy.
 * Every fail-closed drop is tallied in the `redactions` bookkeeping (counts/
 * types only, never original values).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { containsSecret, POLICY_VERSION } = require("./lib/sanitize");
const { safeReadJson, findGitRoot } = require("./lib/io");

// Version of the emitted harness metadata contract this payload conforms to.
// String to match the contract's `harness_schema_version` field (the machine
// spec is at spec/harness-metadata-contract.v1.json). 2.0: identifier fields
// switched from `*_names_hashed` (HMAC tokens) to raw `*_names`. 2.1 (additive):
// added `skill_contents` — the body of custom (project/user) skills.
const HARNESS_SCHEMA_VERSION = "2.1";

// Standard lifecycle hook event names. We only ever report event names from
// this allow-list (contract `hooks_enabled` action: enum) so an arbitrary
// user-authored settings.json / hooks.json can't inject free-form strings
// (which could carry project context) into the metadata.
const KNOWN_HOOK_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "Notification",
  "InstructionsLoaded",
  "ConfigChange",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "WorktreeCreate",
  "WorktreeRemove",
]);

// Marketplaces recognised as public/known. As of schema v2.0 all plugin names
// are emitted raw, so this set is no longer a raw-vs-hash gate; it is retained
// (and exported) so downstream can still tell public-catalog plugins from
// private ones without re-deriving the list.
const PUBLIC_MARKETPLACES = new Set([
  "skillbench",
  "claude-plugins-official",
  "anthropics",
  "anthropic",
]);

// Depth-bounded so a pathological tree can't make SessionStart slow.
const SKILL_SCAN_MAX_DEPTH = 4;
const COMMAND_SCAN_MAX_DEPTH = 4;
const AGENT_SCAN_MAX_DEPTH = 2;
// Bounded walk for counting nested CLAUDE.md files across a (possibly large)
// monorepo without stat-storming the whole tree.
const CLAUDE_MD_WALK_MAX_DEPTH = 6;
const CLAUDE_MD_WALK_MAX_DIRS = 4000;
// Directories never worth descending for harness detection.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  ".next",
  "coverage",
]);
// Cap the number of names we enumerate per surface; counts stay exact, but the
// name lists are bounded so a huge library can't bloat the event.
const NAMES_LIMIT = 64;
// Custom-skill CONTENT collection (SBEE-169): for developer-authored skills
// (project/user scope) with no public catalog to join against, we emit the
// SKILL.md body so the analysis side can do semantic work on custom skills.
// Public/plugin-marketplace skills are name-only (catalog join). The body is
// size-capped (defence-in-depth privacy + payload bound) and, like every string
// in the block, still passes the central secret/PII sanitizer before egress.
const MAX_SKILL_BODY_BYTES = 4096;
const MAX_SKILL_CONTENTS = 50;

// Coarse size buckets for the project CLAUDE.md (contract `claude_md_size_bucket`
// enum). Raw byte counts are bucketed to avoid fingerprinting a specific file.
function sizeBucket(bytes) {
  if (!bytes || bytes <= 0) return "none";
  if (bytes < 1024) return "xs";
  if (bytes < 4096) return "s";
  if (bytes < 16384) return "m";
  if (bytes < 65536) return "l";
  return "xl";
}

// Record a single sanitization action against the harness redaction bookkeeping
// (contract `redactions`). `kind` is "hashed" (an HMAC token replaced a raw
// name) or "dropped" (a secret fail-closed removal). Only counts and a
// coarse field `type` are tracked — never the original name/value — so the
// bookkeeping is itself tier3_safe.
function recordRedaction(redactions, kind, type) {
  if (kind === "hashed") redactions.hashed_count += 1;
  else if (kind === "dropped") redactions.dropped_count += 1;
  redactions.by_type[type] = (redactions.by_type[type] || 0) + 1;
}

function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Git-root discovery is shared via the leaf lib/io module (fs/path only, so
// harness stays self-contained and unit-testable). Kept under the local name
// `findRepoRoot` for the exported/test surface.
const findRepoRoot = findGitRoot;

/**
 * Collect harness identifier names for emission. As of schema v2.0 names are
 * emitted RAW (the analysis side joins them to the catalog / reads them
 * semantically). Fail-closed remains: a name embedding a secret is
 * dropped outright and tallied in `redactions` — the raw-name policy never
 * permits leaking a credential that happens to be baked into a name.
 */
function collectNames(names, type, redactions) {
  const out = [];
  for (const name of names.slice(0, NAMES_LIMIT)) {
    if (containsSecret(name)) {
      recordRedaction(redactions, "dropped", type);
      continue;
    }
    out.push(name);
  }
  return out;
}

// Read the `permissions` block from a settings.json file (contract
// `permission_*`). Returns the allow/deny/ask rule arrays, defaultMode, and the
// additionalDirectories list, or null when the file has no permissions object.
// Rule strings are emitted raw (they describe the user's trust boundary) but,
// like names, still pass through the central secret/PII boundary before
// egress so a stray secret in a rule can't leak.
function readPermissions(settingsFilePath) {
  const parsed = safeReadJson(settingsFilePath);
  const p = parsed && parsed.permissions;
  if (!p || typeof p !== "object") return null;
  const asArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return {
    allow: asArray(p.allow),
    deny: asArray(p.deny),
    ask: asArray(p.ask),
    defaultMode: typeof p.defaultMode === "string" ? p.defaultMode : "",
    additionalDirectories: asArray(p.additionalDirectories),
  };
}

// Collect skill directory names (the parent dir of each SKILL.md) under `root`,
// recursing up to SKILL_SCAN_MAX_DEPTH. Hidden namespaces (any path segment
// starting with ".", e.g. runtime-provided ".system" skills) are skipped so the
// count reflects the developer's own harness rather than built-ins.
function collectSkillNames(root, depth, acc, paths) {
  if (depth > SKILL_SCAN_MAX_DEPTH) return;
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const md = path.join(dir, "SKILL.md");
    if (safeIsFile(md)) {
      acc.add(entry.name);
      // Record the SKILL.md path for custom (project/user) skills so their body
      // can be collected. First occurrence wins (project before user).
      if (paths && !paths.has(entry.name)) paths.set(entry.name, md);
    }
    collectSkillNames(dir, depth + 1, acc, paths);
  }
}

// Read a custom skill's SKILL.md into the emittable content shape (SBEE-169):
// `description` (from YAML frontmatter when present) + `body` (the rest,
// size-capped). Never throws. The strings are emitted raw here and scrubbed for
// secrets / PII by the central sanitizer before egress.
function readSkillContent(name, mdPath) {
  let text;
  try {
    text = fs.readFileSync(mdPath, "utf8");
  } catch {
    return null;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  let description = "";
  let body = text;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim().replace(/^["']|["']$/g, "");
  }
  body = body.trim();
  const truncated = body.length > MAX_SKILL_BODY_BYTES;
  if (truncated) body = body.slice(0, MAX_SKILL_BODY_BYTES);
  return { name, description, body, bytes, truncated };
}

// Collect markdown command/agent names under `root`. Each `*.md` file is one
// entry; nested directories become a `namespace:` prefix (Claude's command
// namespacing). Hidden dirs are skipped.
function collectMarkdownNames(root, depth, maxDepth, prefix, acc) {
  if (depth > maxDepth) return;
  for (const entry of safeReadDir(root)) {
    if (entry.isFile()) {
      if (entry.name.endsWith(".md")) acc.add(prefix + entry.name.slice(0, -3));
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      collectMarkdownNames(
        path.join(root, entry.name),
        depth + 1,
        maxDepth,
        `${prefix}${entry.name}:`,
        acc
      );
    }
  }
}

// Count CLAUDE.md files across a project tree (contract `claude_md_count` —
// "nested/imported"). Bounded in depth and total directories visited so a giant
// monorepo can't slow SessionStart.
function countNestedClaudeMd(root) {
  let count = 0;
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > CLAUDE_MD_WALK_MAX_DEPTH || visited > CLAUDE_MD_WALK_MAX_DIRS) return;
    visited += 1;
    for (const entry of safeReadDir(dir)) {
      if (entry.isFile()) {
        if (entry.name === "CLAUDE.md") count += 1;
      } else if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  if (root) walk(root, 0);
  return count;
}

// Count `@path` imports referenced from a CLAUDE.md (contract
// `claude_md_import_count`). Only the COUNT is collected — the referenced paths
// themselves are never read or emitted. Email-like `@` (preceded by a word
// char) is excluded by requiring a leading boundary.
function countImports(claudeMdPath) {
  try {
    const text = fs.readFileSync(claudeMdPath, "utf8");
    const matches = text.match(/(?:^|\s)@[^\s@]+/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

// Read the hook config from a settings.json / hooks.json file. Both Claude
// shapes expose a top-level `hooks` object keyed by event name. Returns the
// allow-listed event names present and the number of configured hook ENTRIES
// (matcher groups / inner commands) — never any command string.
function readHooks(hooksFilePath) {
  const parsed = safeReadJson(hooksFilePath);
  const hooks = parsed && parsed.hooks;
  if (!hooks || typeof hooks !== "object") return { events: [], entries: 0 };
  const events = [];
  let entries = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!KNOWN_HOOK_EVENTS.has(event)) continue;
    events.push(event);
    if (Array.isArray(groups)) {
      for (const group of groups) {
        // Each matcher group may hold an inner `hooks` array of commands; count
        // those when present, otherwise count the group itself as one entry.
        const inner = group && Array.isArray(group.hooks) ? group.hooks.length : 0;
        entries += inner > 0 ? inner : 1;
      }
    }
  }
  return { events, entries };
}

/**
 * Detect Level 1 harness metadata for a session running in `cwd` and emit the
 * flat SBEE-164 contract field set.
 *
 * @param {string} cwd - session working directory (only used to probe the
 *   filesystem — never emitted).
 * @param {object} [options]
 * @param {string} [options.repoRoot] - precomputed git root (avoids a re-walk).
 * @param {string} [options.homeDir] - overrides os.homedir() (test seam).
 * @param {string} [options.pluginRoot] - this plugin's root, for its hooks.json.
 * @param {string} [options.pluginVersion] - this collector plugin's version.
 * @param {string} [options.agentType] - agent surface (defaults "claude-code").
 * @param {string} [options.model] - model id from SessionStart input.model.
 * @param {string} [options.sessionSource] - SessionStart input.source.
 * @param {string} [options.agentVersion] - agent CLI version, when the runtime
 *   exposes it (Claude Code does not surface this to hooks today, so it is
 *   typically ""; wired for parity + future availability).
 * @param {string} [options.hashSalt] - accepted for backward compatibility;
 *   no longer used by harness detection (identifiers are emitted raw in v2.0).
 * @returns {object} flat, plain-JSON harness metadata (safe to route through the
 *   sanitizer and upload).
 */
function detectHarness(cwd, options = {}) {
  const harness = {
    // ---- Contract & runtime ----
    harness_schema_version: HARNESS_SCHEMA_VERSION,
    // Sanitization policy version this metadata was produced under, sourced from
    // the single sanitizer constant so the harness block and the central
    // sanitizeEventData metadata always agree on the policy in force.
    policy_version: POLICY_VERSION,
    agent_type: options.agentType || "claude-code",
    agent_version: options.agentVersion || "",
    model: options.model || "",
    session_source: options.sessionSource || "",
    plugin_version: options.pluginVersion || "",

    // ---- Memory / instruction files ----
    has_claude_md: false,
    has_claude_local_md: false,
    has_user_claude_md: false,
    has_agents_md: false,
    claude_md_count: 0,
    claude_md_size_bucket: "none",
    claude_md_import_count: 0,

    // ---- Skills ----
    skills_present: false,
    skills_count: 0,
    skill_source_counts: { project: 0, user: 0, plugin: 0 },
    skill_names: [],
    // Custom (project/user) skill bodies for semantic analysis (SBEE-169).
    // Public/plugin skills are name-only (catalog join); see skill_names.
    skill_contents: [],

    // ---- Subagents ----
    subagents_present: false,
    subagents_count: 0,
    subagent_names: [],
    // Derived downstream from SubagentStart/SubagentStop; false at session start.
    subagent_used: false,

    // ---- Hooks ----
    hooks_enabled: [],
    hooks_count: 0,
    hooks_source_counts: { user: 0, project: 0, local: 0, plugin: 0 },

    // ---- Slash commands ----
    commands_present: false,
    commands_count: 0,
    command_names: [],

    // ---- MCP servers ----
    has_mcp_config: false,
    mcp_servers_count: 0,
    mcp_server_names: [],

    // ---- Permissions / sandbox (the developer's AI trust boundary) ----
    permission_default_mode: "",
    permission_allow: [],
    permission_deny: [],
    permission_ask: [],
    permission_additional_directories_count: 0,

    // ---- Plugins / marketplaces ----
    plugins_count: 0,
    marketplaces_count: 0,
    plugins: [],

    // ---- Level 2 (architecture) — not detectable; explicit "unknown" ----
    external_orchestration: "unknown",
    multi_agent: "unknown",

    // ---- Sanitization bookkeeping (counts/types only, never values) ----
    redactions: { hashed_count: 0, dropped_count: 0, by_type: {} },
  };

  try {
    const homeDir = options.homeDir || os.homedir();
    const repoRoot =
      options.repoRoot !== undefined ? options.repoRoot : findRepoRoot(cwd);
    const projectDirs = [cwd, repoRoot].filter(Boolean);
    const userClaudeDir = homeDir ? path.join(homeDir, ".claude") : "";

    const hasProjectFile = (name) =>
      projectDirs.some((dir) => safeIsFile(path.join(dir, name)));

    // ---- Memory / instruction files ----
    harness.has_claude_md = hasProjectFile("CLAUDE.md");
    harness.has_claude_local_md = hasProjectFile("CLAUDE.local.md");
    harness.has_agents_md = hasProjectFile("AGENTS.md");
    harness.has_user_claude_md =
      !!userClaudeDir && safeIsFile(path.join(userClaudeDir, "CLAUDE.md"));

    const claudeMdPath = projectDirs
      .map((dir) => path.join(dir, "CLAUDE.md"))
      .find(safeIsFile);
    if (claudeMdPath) {
      try {
        harness.claude_md_size_bucket = sizeBucket(fs.statSync(claudeMdPath).size);
      } catch {
        /* leave "none" */
      }
      harness.claude_md_import_count = countImports(claudeMdPath);
    }
    // Count across the repo tree when we have a root; otherwise just cwd.
    harness.claude_md_count = countNestedClaudeMd(repoRoot || cwd);

    // ---- Skills (project / user / plugin) ----
    const skillRoots = [];
    if (repoRoot) skillRoots.push({ scope: "project", dir: path.join(repoRoot, ".claude", "skills") });
    if (cwd && cwd !== repoRoot) skillRoots.push({ scope: "project", dir: path.join(cwd, ".claude", "skills") });
    if (userClaudeDir) skillRoots.push({ scope: "user", dir: path.join(userClaudeDir, "skills") });

    const skillNames = new Set();
    const seenSkillScopes = { project: new Set(), user: new Set(), plugin: new Set() };
    // name -> SKILL.md path, for CUSTOM (project/user) skills only. Plugin skills
    // are name-only (resolved from the public catalog), so their paths aren't
    // tracked and their bodies are never read.
    const customSkillPaths = new Map();
    for (const { scope, dir } of skillRoots) {
      if (!safeIsDir(dir)) continue;
      const names = new Set();
      collectSkillNames(dir, 1, names, customSkillPaths);
      for (const n of names) {
        skillNames.add(n);
        seenSkillScopes[scope].add(n);
      }
    }
    // Plugin-provided skills: scan each installed plugin's bundled skills dir.
    // (No path map -> no body collected; catalog join covers these.)
    const pluginInfo = detectPlugins(userClaudeDir, harness.redactions);
    for (const installPath of pluginInfo.installPaths) {
      const dir = path.join(installPath, "skills");
      if (!safeIsDir(dir)) continue;
      const names = new Set();
      collectSkillNames(dir, 1, names);
      for (const n of names) {
        skillNames.add(n);
        seenSkillScopes.plugin.add(n);
      }
    }
    harness.skills_count = skillNames.size;
    harness.skills_present = skillNames.size > 0;
    harness.skill_source_counts = {
      project: seenSkillScopes.project.size,
      user: seenSkillScopes.user.size,
      plugin: seenSkillScopes.plugin.size,
    };
    harness.skill_names = collectNames(
      [...skillNames].sort(),
      "skill_name",
      harness.redactions
    );
    // Custom-skill CONTENT (SBEE-169): body of each project/user skill that
    // survived the name secret-check (a skill dropped for a secret in its NAME
    // is not read at all). Emitted raw; secret-scrubbed by the central sanitizer.
    // Bounded by MAX_SKILL_CONTENTS + per-body MAX_SKILL_BODY_BYTES.
    const emittedSkillNames = new Set(harness.skill_names);
    for (const name of [...customSkillPaths.keys()].sort()) {
      if (harness.skill_contents.length >= MAX_SKILL_CONTENTS) break;
      if (!emittedSkillNames.has(name)) continue; // dropped by the name check
      const content = readSkillContent(name, customSkillPaths.get(name));
      if (content) harness.skill_contents.push(content);
    }

    // ---- Subagents (.claude/agents/*.md) ----
    const agentRoots = [];
    if (repoRoot) agentRoots.push(path.join(repoRoot, ".claude", "agents"));
    if (cwd && cwd !== repoRoot) agentRoots.push(path.join(cwd, ".claude", "agents"));
    if (userClaudeDir) agentRoots.push(path.join(userClaudeDir, "agents"));
    const subagentNames = new Set();
    for (const dir of agentRoots) {
      if (!safeIsDir(dir)) continue;
      collectMarkdownNames(dir, 1, AGENT_SCAN_MAX_DEPTH, "", subagentNames);
    }
    harness.subagents_count = subagentNames.size;
    harness.subagents_present = subagentNames.size > 0;
    harness.subagent_names = collectNames(
      [...subagentNames].sort(),
      "subagent_name",
      harness.redactions
    );

    // ---- Slash commands (.claude/commands/**/*.md) ----
    const commandRoots = [];
    if (repoRoot) commandRoots.push(path.join(repoRoot, ".claude", "commands"));
    if (cwd && cwd !== repoRoot) commandRoots.push(path.join(cwd, ".claude", "commands"));
    if (userClaudeDir) commandRoots.push(path.join(userClaudeDir, "commands"));
    const commandNames = new Set();
    for (const dir of commandRoots) {
      if (!safeIsDir(dir)) continue;
      collectMarkdownNames(dir, 1, COMMAND_SCAN_MAX_DEPTH, "", commandNames);
    }
    harness.commands_count = commandNames.size;
    harness.commands_present = commandNames.size > 0;
    harness.command_names = collectNames(
      [...commandNames].sort(),
      "command_name",
      harness.redactions
    );

    // ---- Hooks ----
    // Claude hooks live in the plugin's hooks.json and in settings.json files
    // (user / project / local), all exposing a top-level `hooks` object keyed by
    // event name. Only allow-listed event names and entry COUNTS are emitted.
    const hookSources = [];
    if (options.pluginRoot) {
      hookSources.push({ scope: "plugin", file: path.join(options.pluginRoot, "hooks", "hooks.json") });
    }
    if (userClaudeDir) hookSources.push({ scope: "user", file: path.join(userClaudeDir, "settings.json") });
    if (repoRoot) {
      hookSources.push({ scope: "project", file: path.join(repoRoot, ".claude", "settings.json") });
      hookSources.push({ scope: "local", file: path.join(repoRoot, ".claude", "settings.local.json") });
    }
    if (cwd && cwd !== repoRoot) {
      hookSources.push({ scope: "project", file: path.join(cwd, ".claude", "settings.json") });
      hookSources.push({ scope: "local", file: path.join(cwd, ".claude", "settings.local.json") });
    }
    const enabledEvents = new Set();
    for (const { scope, file } of hookSources) {
      if (!safeIsFile(file)) continue;
      const { events, entries } = readHooks(file);
      for (const e of events) enabledEvents.add(e);
      harness.hooks_count += entries;
      harness.hooks_source_counts[scope] =
        (harness.hooks_source_counts[scope] || 0) + entries;
    }
    harness.hooks_enabled = [...enabledEvents].sort();

    // ---- Permissions / sandbox (AI trust boundary) ----
    // Read the `permissions` block from the same settings.json files (user /
    // project / local) — never the plugin hooks.json. Rule arrays are merged
    // (deduped) across sources; defaultMode follows Claude's own precedence
    // (user < project < local), so a more specific file overrides.
    const allowRules = new Set();
    const denyRules = new Set();
    const askRules = new Set();
    const additionalDirs = new Set();
    for (const { scope, file } of hookSources) {
      if (scope === "plugin") continue;
      if (!safeIsFile(file)) continue;
      const perms = readPermissions(file);
      if (!perms) continue;
      for (const r of perms.allow) allowRules.add(r);
      for (const r of perms.deny) denyRules.add(r);
      for (const r of perms.ask) askRules.add(r);
      for (const d of perms.additionalDirectories) additionalDirs.add(d);
      if (perms.defaultMode) harness.permission_default_mode = perms.defaultMode;
    }
    harness.permission_allow = collectNames([...allowRules], "permission_rule", harness.redactions);
    harness.permission_deny = collectNames([...denyRules], "permission_rule", harness.redactions);
    harness.permission_ask = collectNames([...askRules], "permission_rule", harness.redactions);
    harness.permission_additional_directories_count = additionalDirs.size;

    // ---- MCP servers ----
    const mcpFiles = [];
    for (const dir of projectDirs) mcpFiles.push(path.join(dir, ".mcp.json"));
    if (homeDir) mcpFiles.push(path.join(homeDir, ".claude.json"));
    const mcpNames = new Set();
    for (const file of mcpFiles) {
      if (!safeIsFile(file)) continue;
      const parsed = safeReadJson(file);
      const servers = parsed && parsed.mcpServers;
      if (servers && typeof servers === "object") {
        harness.has_mcp_config = true;
        for (const name of Object.keys(servers)) mcpNames.add(name);
      }
    }
    harness.mcp_servers_count = mcpNames.size;
    // Server NAMES are emitted raw (v2.0). The server *config* (command / args /
    // env / url) is deliberately NOT collected: env holds literal API keys and
    // args/urls can embed tokens, so it stays secret-out regardless of the
    // identifier policy.
    harness.mcp_server_names = collectNames(
      [...mcpNames].sort(),
      "mcp_name",
      harness.redactions
    );

    // ---- Plugins / marketplaces (computed above for plugin-skill scanning) ----
    harness.plugins_count = pluginInfo.plugins_count;
    harness.marketplaces_count = pluginInfo.marketplaces_count;
    harness.plugins = pluginInfo.plugins;
  } catch {
    // Any unexpected failure leaves the safe defaults in place — never throw out
    // of the SessionStart hook.
  }

  return harness;
}

/**
 * Read installed plugin + marketplace metadata from ~/.claude/plugins.
 * As of schema v2.0 all plugin names are emitted raw (with the source
 * marketplace, so downstream can still tell public from private); names that
 * embed a secret are dropped fail-closed. Returns counts, the emittable
 * `plugins` array, and the install paths (used by the caller to scan
 * plugin-bundled skills).
 */
function detectPlugins(userClaudeDir, redactions) {
  const result = { plugins_count: 0, marketplaces_count: 0, plugins: [], installPaths: [] };
  if (!userClaudeDir) return result;
  const pluginsDir = path.join(userClaudeDir, "plugins");

  const installed = safeReadJson(path.join(pluginsDir, "installed_plugins.json"));
  const plugins = installed && installed.plugins;
  if (plugins && typeof plugins === "object") {
    const keys = Object.keys(plugins);
    result.plugins_count = keys.length;
    for (const key of keys.slice(0, NAMES_LIMIT)) {
      const at = key.lastIndexOf("@");
      const name = at >= 0 ? key.slice(0, at) : key;
      const marketplace = at >= 0 ? key.slice(at + 1) : "";
      const entry = Array.isArray(plugins[key]) ? plugins[key][0] : plugins[key];
      const version =
        entry && typeof entry.version === "string" ? entry.version : undefined;
      if (entry && typeof entry.installPath === "string") {
        result.installPaths.push(entry.installPath);
      }

      if (containsSecret(name)) {
        recordRedaction(redactions, "dropped", "plugin_name");
        continue;
      }
      // v2.0: plugin names are raw. `marketplace` is retained so downstream can
      // still distinguish public-catalog plugins from private ones.
      const rec = { name };
      if (marketplace) rec.marketplace = marketplace;
      rec.public = PUBLIC_MARKETPLACES.has(marketplace);
      if (version) rec.version = version;
      result.plugins.push(rec);
    }
  }

  const marketplaces = safeReadJson(path.join(pluginsDir, "known_marketplaces.json"));
  if (marketplaces && typeof marketplaces === "object") {
    result.marketplaces_count = Object.keys(marketplaces).length;
  }

  return result;
}

module.exports = {
  HARNESS_SCHEMA_VERSION,
  KNOWN_HOOK_EVENTS,
  PUBLIC_MARKETPLACES,
  detectHarness,
  findRepoRoot,
  sizeBucket,
};

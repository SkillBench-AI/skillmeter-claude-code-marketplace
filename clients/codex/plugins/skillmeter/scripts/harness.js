"use strict";

/**
 * Collect filesystem-detectable Codex configuration in the shared harness schema.
 * Names and bounded custom skill bodies are collected; instruction-file bodies,
 * hook commands and MCP command/args/env are excluded. Secret-bearing names are
 * dropped, and callers sanitize the resulting event.
 *
 * External orchestration and multi-agent topology remain unknown. Detection runs
 * at SessionStart and returns defaults on failure.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { containsTier1, POLICY_VERSION } = require("./sanitizer");

// Version of the emitted harness metadata contract this payload conforms to.
// 2.0: identifier fields switched from `*_names_hashed` to raw `*_names`.
// 2.1 (additive): added `skill_contents` — the body of custom (project/user)
// skills that have no public catalog to join against.
const HARNESS_SCHEMA_VERSION = "2.1";

// Standard lifecycle hook event names. Only names on this allow-list are ever
// reported (contract `hooks_enabled` action: enum) so an arbitrary user-authored
// hooks.json can't inject free-form strings into the metadata.
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
// (and exported) so downstream can still tell public-catalog plugins apart.
const PUBLIC_MARKETPLACES = new Set([
  "skillbench",
  "openai-bundled",
  "openai",
  "claude-plugins-official",
  "anthropics",
  "anthropic",
]);

// Depth-bounded so a pathological tree can't make SessionStart slow.
const SKILL_SCAN_MAX_DEPTH = 4;
const COMMAND_SCAN_MAX_DEPTH = 4;
const AGENT_SCAN_MAX_DEPTH = 2;
const CLAUDE_MD_WALK_MAX_DEPTH = 6;
const CLAUDE_MD_WALK_MAX_DIRS = 4000;
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
const NAMES_LIMIT = 64;
// Custom skill content: body of developer-authored
// (project/user) skills with no public catalog to join against. Public/plugin
// skills stay name-only. Size-capped defence-in-depth; the body still passes the
// central Tier-1/Tier-2 sanitizer before egress.
const MAX_SKILL_BODY_BYTES = 4096;
const MAX_SKILL_CONTENTS = 50;

// Coarse size buckets for the project CLAUDE.md (contract enum). Raw byte counts
// are bucketed to avoid fingerprinting a specific file.
function sizeBucket(bytes) {
  if (!bytes || bytes <= 0) return "none";
  if (bytes < 1024) return "xs";
  if (bytes < 4096) return "s";
  if (bytes < 16384) return "m";
  if (bytes < 65536) return "l";
  return "xl";
}

// Record a sanitization action against the harness redaction bookkeeping. Only
// counts and a coarse field `type` are tracked — never the original value.
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

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Walk up from `startPath` looking for a `.git` marker. Returns "" when not in a
// git repo.
function findRepoRoot(startPath) {
  if (!startPath || typeof startPath !== "string") return "";
  let current;
  try {
    current = fs.statSync(startPath).isDirectory()
      ? path.resolve(startPath)
      : path.dirname(path.resolve(startPath));
  } catch {
    return "";
  }
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

/**
 * Keep harness names readable; drop secret-bearing names and count the drops.
 */
function collectNames(names, type, redactions) {
  const out = [];
  for (const name of names.slice(0, NAMES_LIMIT)) {
    if (containsTier1(name)) {
      recordRedaction(redactions, "dropped", type);
      continue;
    }
    out.push(name);
  }
  return out;
}

function collectSkillNames(root, depth, acc, paths) {
  if (depth > SKILL_SCAN_MAX_DEPTH) return;
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const md = path.join(dir, "SKILL.md");
    if (safeIsFile(md)) {
      acc.add(entry.name);
      if (paths && !paths.has(entry.name)) paths.set(entry.name, md);
    }
    collectSkillNames(dir, depth + 1, acc, paths);
  }
}

// Read a custom skill's SKILL.md into the upload shape:
// `description` (from YAML frontmatter when present) + `body` (the rest,
// size-capped). Never throws; strings are secret-scrubbed by the central
// sanitizer before egress.
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

// Count `@path` imports referenced from a markdown instruction file. Only the
// COUNT is collected — the referenced paths are never read or emitted.
function countImports(mdPath) {
  try {
    const text = fs.readFileSync(mdPath, "utf8");
    const matches = text.match(/(?:^|\s)@[^\s@]+/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

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
        const inner = group && Array.isArray(group.hooks) ? group.hooks.length : 0;
        entries += inner > 0 ? inner : 1;
      }
    }
  }
  return { events, entries };
}

// Split a TOML table key into segments, honouring quoted segments (which may
// themselves contain dots, e.g. plugins."skillmeter@skillbench").
function splitTomlKey(key) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (const ch of key) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "." && !inQuote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract MCP, plugin and marketplace names plus top-level sandbox settings
 * from config.toml. Ignore table values such as MCP commands and environment.
 * Return distinct names and the sandbox scalars.
 */
function parseCodexConfig(tomlPath) {
  const result = {
    mcpServers: new Set(),
    pluginKeys: new Set(),
    marketplaces: new Set(),
    sandboxMode: "",
    approvalPolicy: "",
  };
  let text;
  try {
    text = fs.readFileSync(tomlPath, "utf8");
  } catch {
    return result;
  }
  // Track whether we're inside a nested table so a `sandbox_mode = ...` under
  // some `[section]` isn't mistaken for the top-level trust-boundary setting.
  let inTopLevel = true;
  const unquote = (v) => v.trim().replace(/^["']|["']$/g, "");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const m = line.match(/^\[([^[\]]+)\]\s*$/);
      inTopLevel = false;
      if (!m) continue;
      const seg = splitTomlKey(m[1]);
      if (seg.length < 2) continue;
      if (seg[0] === "mcp_servers") result.mcpServers.add(seg[1]);
      else if (seg[0] === "plugins") result.pluginKeys.add(seg[1]);
      else if (seg[0] === "marketplaces") result.marketplaces.add(seg[1]);
      continue;
    }
    if (!inTopLevel) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    if (kv[1] === "sandbox_mode") result.sandboxMode = unquote(kv[2]);
    else if (kv[1] === "approval_policy") result.approvalPolicy = unquote(kv[2]);
  }
  return result;
}

/**
 * Detect Level 1 harness metadata for a Codex session running in `cwd`, emitting
 * the shared flat harness schema.
 *
 * @param {string} cwd - session working directory (only used to probe the
 *   filesystem — never emitted).
 * @param {object} [options]
 * @param {string} [options.repoRoot] - precomputed git root (avoids a re-walk).
 * @param {string} [options.homeDir] - overrides os.homedir() (test seam).
 * @param {string} [options.pluginRoot] - this plugin's root, for its hooks.json.
 * @param {string} [options.pluginVersion] - this collector plugin's version.
 * @param {string} [options.agentType] - agent surface (defaults "codex").
 * @param {string} [options.model] - model id from SessionStart input.model.
 * @param {string} [options.sessionSource] - SessionStart input.source.
 * @param {string} [options.agentVersion] - Codex CLI version when available.
 * @param {string} [options.hashSalt] - accepted for backward compatibility;
 *   no longer used (identifiers are emitted raw in v2.0).
 * @returns {object} flat, plain-JSON harness metadata.
 */
function detectHarness(cwd, options = {}) {
  const harness = {
    // ---- Contract & runtime ----
    harness_schema_version: HARNESS_SCHEMA_VERSION,
    policy_version: POLICY_VERSION,
    agent_type: options.agentType || "codex",
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
    // Custom (project/user) skill bodies for analysis.
    skill_contents: [],

    // ---- Subagents ----
    subagents_present: false,
    subagents_count: 0,
    subagent_names: [],
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
    // Codex expresses this via config.toml sandbox_mode / approval_policy rather
    // than Claude's allow/deny/ask rule arrays, so those arrays stay empty here.
    permission_default_mode: "",
    permission_allow: [],
    permission_deny: [],
    permission_ask: [],
    permission_additional_directories_count: 0,

    // ---- Plugins / marketplaces ----
    plugins_count: 0,
    marketplaces_count: 0,
    plugins: [],

    // ---- Level 2 (architecture) — not detectable ----
    external_orchestration: "unknown",
    multi_agent: "unknown",

    // ---- Sanitization bookkeeping ----
    redactions: { hashed_count: 0, dropped_count: 0, by_type: {} },
  };

  try {
    const homeDir = options.homeDir || os.homedir();
    const repoRoot =
      options.repoRoot !== undefined ? options.repoRoot : findRepoRoot(cwd);
    const projectDirs = [cwd, repoRoot].filter(Boolean);
    const userCodexDir = homeDir ? path.join(homeDir, ".codex") : "";

    const hasProjectFile = (name) =>
      projectDirs.some((dir) => safeIsFile(path.join(dir, name)));

    // ---- Memory / instruction files ----
    // Codex's primary memory file is AGENTS.md; CLAUDE.md is tracked too so
    // cross-agent harnesses are visible.
    harness.has_agents_md = hasProjectFile("AGENTS.md");
    harness.has_claude_md = hasProjectFile("CLAUDE.md");
    harness.has_claude_local_md = hasProjectFile("CLAUDE.local.md");
    harness.has_user_claude_md =
      !!homeDir && safeIsFile(path.join(homeDir, ".claude", "CLAUDE.md"));

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
    harness.claude_md_count = countNestedClaudeMd(repoRoot || cwd);

    // ---- Skills (project / user) ----
    const skillRoots = [];
    if (repoRoot) skillRoots.push({ scope: "project", dir: path.join(repoRoot, ".codex", "skills") });
    if (cwd && cwd !== repoRoot) skillRoots.push({ scope: "project", dir: path.join(cwd, ".codex", "skills") });
    if (userCodexDir) skillRoots.push({ scope: "user", dir: path.join(userCodexDir, "skills") });

    const skillNames = new Set();
    const seenSkillScopes = { project: new Set(), user: new Set(), plugin: new Set() };
    // name -> SKILL.md path, for custom (project/user) skills — bodies collected.
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
    // Custom skill content: body of each project/user skill that
    // survived the Tier-1 name check. Secret-scrubbed by the central sanitizer.
    const emittedSkillNames = new Set(harness.skill_names);
    for (const name of [...customSkillPaths.keys()].sort()) {
      if (harness.skill_contents.length >= MAX_SKILL_CONTENTS) break;
      if (!emittedSkillNames.has(name)) continue;
      const content = readSkillContent(name, customSkillPaths.get(name));
      if (content) harness.skill_contents.push(content);
    }

    // ---- Subagents (.codex/agents/*.md) ----
    const agentRoots = [];
    if (repoRoot) agentRoots.push(path.join(repoRoot, ".codex", "agents"));
    if (cwd && cwd !== repoRoot) agentRoots.push(path.join(cwd, ".codex", "agents"));
    if (userCodexDir) agentRoots.push(path.join(userCodexDir, "agents"));
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

    // ---- Slash commands (.codex/commands + ~/.codex/prompts) ----
    const commandRoots = [];
    if (repoRoot) commandRoots.push(path.join(repoRoot, ".codex", "commands"));
    if (cwd && cwd !== repoRoot) commandRoots.push(path.join(cwd, ".codex", "commands"));
    if (userCodexDir) {
      commandRoots.push(path.join(userCodexDir, "commands"));
      commandRoots.push(path.join(userCodexDir, "prompts"));
    }
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

    // ---- Hooks (plugin hooks.json + .codex/hooks.json) ----
    const hookSources = [];
    if (options.pluginRoot) {
      hookSources.push({ scope: "plugin", file: path.join(options.pluginRoot, "hooks", "hooks.json") });
    }
    if (userCodexDir) hookSources.push({ scope: "user", file: path.join(userCodexDir, "hooks.json") });
    if (repoRoot) hookSources.push({ scope: "project", file: path.join(repoRoot, ".codex", "hooks.json") });
    if (cwd && cwd !== repoRoot) hookSources.push({ scope: "project", file: path.join(cwd, ".codex", "hooks.json") });
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

    // ---- Plugins / marketplaces / MCP / sandbox (from ~/.codex/config.toml) ----
    const config = parseCodexConfig(
      userCodexDir ? path.join(userCodexDir, "config.toml") : ""
    );

    // Permissions / sandbox: Codex's trust boundary is the top-level
    // sandbox_mode / approval_policy. Prefer sandbox_mode; fall back to
    // approval_policy. Codex has no allow/deny/ask rule arrays.
    harness.permission_default_mode = config.sandboxMode || config.approvalPolicy || "";

    // MCP servers: config.toml [mcp_servers.*] plus any project .mcp.json.
    const mcpNames = new Set(config.mcpServers);
    for (const dir of projectDirs) {
      const file = path.join(dir, ".mcp.json");
      if (!safeIsFile(file)) continue;
      const parsed = safeReadJson(file);
      const servers = parsed && parsed.mcpServers;
      if (servers && typeof servers === "object") {
        for (const name of Object.keys(servers)) mcpNames.add(name);
      }
    }
    harness.has_mcp_config = mcpNames.size > 0;
    harness.mcp_servers_count = mcpNames.size;
    // Server NAMES raw (v2.0); server config (command/args/env) never collected.
    harness.mcp_server_names = collectNames(
      [...mcpNames].sort(),
      "mcp_name",
      harness.redactions
    );

    // Plugins: each key is "name@marketplace". Names are raw (v2.0); the source
    // marketplace + a `public` flag are kept so downstream can still tell
    // public-catalog plugins from private ones. Codex config.toml carries no
    // per-plugin version, so `version` is omitted (tracked in known-gaps).
    harness.marketplaces_count = config.marketplaces.size;
    const pluginKeys = [...config.pluginKeys].sort();
    harness.plugins_count = pluginKeys.length;
    for (const key of pluginKeys.slice(0, NAMES_LIMIT)) {
      const at = key.lastIndexOf("@");
      const name = at >= 0 ? key.slice(0, at) : key;
      const marketplace = at >= 0 ? key.slice(at + 1) : "";
      if (containsTier1(name)) {
        recordRedaction(harness.redactions, "dropped", "plugin_name");
        continue;
      }
      const rec = { name };
      if (marketplace) rec.marketplace = marketplace;
      rec.public = PUBLIC_MARKETPLACES.has(marketplace);
      harness.plugins.push(rec);
    }
  } catch {
    // Any unexpected failure leaves the safe defaults in place — never throw out
    // of the SessionStart hook.
  }

  return harness;
}

module.exports = {
  HARNESS_SCHEMA_VERSION,
  KNOWN_HOOK_EVENTS,
  PUBLIC_MARKETPLACES,
  detectHarness,
  findRepoRoot,
  sizeBucket,
  parseCodexConfig,
};

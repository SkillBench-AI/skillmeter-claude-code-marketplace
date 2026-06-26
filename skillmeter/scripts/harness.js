"use strict";

/**
 * Harness detection (SBEE-163, Phase 1 — metadata-only MVP) with the Phase 2
 * sanitization integration (SBEE-165) baked in.
 *
 * "Harness" = the scaffolding a developer wraps around their coding agent:
 * instruction files (CLAUDE.md / AGENTS.md), skills, lifecycle hooks, plugins,
 * and higher-level orchestration. Analysis needs to know whether a session was
 * run bare or with a sophisticated harness so it can judge the work fairly.
 *
 * This module produces *presence / shape metadata only* — never raw file
 * contents (raw harness content is a higher-risk Phase 4). It is deterministic,
 * filesystem-only, and must never throw: harness detection runs inside the
 * SessionStart hook and a failure here must not break the session, so every
 * probe is wrapped and falls back to a safe "unknown"/empty default.
 *
 * Detection levels (from the work item):
 *   - Level 1 (prompt/filesystem-detectable): instruction-file presence, skills,
 *     hooks, plugin/agent info. Collected here.
 *   - Level 2 (architecture-level, NOT detectable): external orchestration and
 *     multi-agent setups. Emitted as "unknown" until explicit metadata exists.
 *
 * Phase 2 (SBEE-165): the block carries the sanitization `policy_version`,
 * applies a Tier 1 fail-closed scan to free-form names (a skill name embedding
 * a secret is dropped before it can be hashed), and records every hash/drop in
 * a `redactions` bookkeeping object (counts/types only). The whole block is also
 * routed through the central `sanitizeEventData` boundary by the caller before
 * it is logged/uploaded, so any residual secret/email is still scrubbed.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { hashHmac, containsTier1, POLICY_VERSION } = require("./lib/sanitize");

// Bump when the shape of the emitted harness metadata changes. Aligned with the
// Codex collector's schema generation (2) so the backend sees a single harness
// schema version across both client surfaces; version 2 carries the Phase 2
// `policy_version` and `redactions` fields.
const HARNESS_SCHEMA_VERSION = 2;

// Standard lifecycle hook event names. We only ever report event names from
// this allow-list so an arbitrary user-authored settings.json / hooks.json
// can't inject free-form strings (which could carry project context) into the
// metadata. Covers the full Claude Code hook catalog.
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

// Depth-bounded so a pathological skills tree can't make SessionStart slow.
const SKILL_SCAN_MAX_DEPTH = 4;
// Cap the number of skill names we enumerate; the count is always exact, but
// the name list is bounded so a huge skills library can't bloat the event.
const SKILL_NAMES_LIMIT = 64;

// Record a single sanitization action against the harness redaction bookkeeping
// (SBEE-165, Phase 2). `kind` is "hashed" (an HMAC token replaced a raw Tier 2
// name) or "dropped" (a Tier 1 fail-closed removal). Only counts and a coarse
// field `type` are tracked — never the original name/value — so the bookkeeping
// is itself Tier 3 safe.
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

// Walk up from `startPath` looking for a `.git` marker. Returns "" when the
// path isn't inside a git repo. Mirrors logger's git-root walk but is kept
// local so harness detection stays self-contained and unit-testable.
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

// Collect skill directory names (the parent dir of each SKILL.md) under `root`,
// recursing up to SKILL_SCAN_MAX_DEPTH. Hidden namespaces (any path segment
// starting with ".", e.g. runtime-provided ".system" skills) are skipped so the
// count reflects the developer's own harness rather than built-ins.
function collectSkillNames(root, depth, acc) {
  if (depth > SKILL_SCAN_MAX_DEPTH) return;
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    if (safeIsFile(path.join(dir, "SKILL.md"))) {
      acc.add(entry.name);
    }
    collectSkillNames(dir, depth + 1, acc);
  }
}

function detectSkills(roots) {
  const names = new Set();
  const scopes = new Set();
  for (const { scope, dir } of roots) {
    if (!safeIsDir(dir)) continue;
    const dirNames = new Set();
    collectSkillNames(dir, 1, dirNames);
    if (dirNames.size > 0) scopes.add(scope);
    for (const name of dirNames) names.add(name);
  }
  return { names: [...names].sort(), scopes: [...scopes].sort() };
}

// Read the hook event names declared in a settings.json / hooks.json file. Both
// Claude shapes expose a top-level `hooks` object keyed by event name, so the
// same reader handles the plugin's hooks.json and user/project settings.json.
// Only names on the known-events allow-list survive, so we never echo arbitrary
// user strings.
function readHookEvents(hooksFilePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksFilePath, "utf8"));
    const hooks = parsed && parsed.hooks;
    if (!hooks || typeof hooks !== "object") return [];
    return Object.keys(hooks).filter((event) => KNOWN_HOOK_EVENTS.has(event));
  } catch {
    return [];
  }
}

function detectHooks(sources) {
  const enabled = new Set();
  const scopes = new Set();
  for (const { scope, file } of sources) {
    if (!safeIsFile(file)) continue;
    const events = readHookEvents(file);
    if (events.length === 0) continue;
    for (const event of events) enabled.add(event);
    scopes.add(scope);
  }
  return { enabled: [...enabled].sort(), scopes: [...scopes].sort() };
}

/**
 * Detect Level 1 harness metadata for a session running in `cwd`.
 *
 * @param {string} cwd - session working directory (unhashed; only used to probe
 *   the filesystem — never emitted).
 * @param {object} [options]
 * @param {string} [options.repoRoot] - precomputed git root (avoids a re-walk);
 *   derived from `cwd` when omitted.
 * @param {string} [options.homeDir] - overrides os.homedir() (test seam).
 * @param {string} [options.pluginRoot] - this plugin's root, for its hooks.json.
 * @param {string} [options.pluginVersion] - this plugin's version.
 * @param {string} [options.agentType] - agent label (defaults to "claude-code").
 * @param {string} [options.hashSalt] - per-machine HMAC salt; required to hash
 *   skill names.
 * @param {boolean} [options.hashSkillNames] - when true, emit `names_hashed`
 *   (HMAC) instead of plaintext `names`. Defaults from
 *   SKILLMETER_HARNESS_HASH_SKILL_NAMES.
 * @returns {object} plain-JSON harness metadata (safe to route through the
 *   sanitizer and upload).
 */
function detectHarness(cwd, options = {}) {
  const base = {
    schema_version: HARNESS_SCHEMA_VERSION,
    // Sanitization policy version this metadata was produced under (SBEE-165,
    // Phase 2). Sourced from the single sanitizer constant so the harness block
    // and the central sanitizeEventData metadata always agree on the policy in
    // force, and the backend can reason about which 3-tier rules applied.
    policy_version: POLICY_VERSION,
    agent_type: options.agentType || "claude-code",
    instructions: { has_claude_md: false, has_claude_md_global: false, has_agents_md: false, has_agents_md_global: false, scopes: [] },
    skills: { count: 0, names: [], scopes: [] },
    hooks: { enabled: [], scopes: [] },
    // Level 2 — architecture-level signals are not detectable from the
    // filesystem/transcript, so they are explicitly "unknown" rather than a
    // misleading false. subagent_used is derived downstream from the
    // SubagentStart/SubagentStop events the collector already emits.
    orchestration: {
      external_orchestration: "unknown",
      multi_agent: "unknown",
    },
    // Sanitization bookkeeping (SBEE-165, Phase 2): how many harness values
    // were HMAC-hashed (Tier 2 names) or dropped (Tier 1 fail-closed) at this
    // boundary, broken down by field type. Counts/types only — the original
    // names/values never appear here. Complements the central sanitizeEventData
    // summary, which only ever sees the already hashed/dropped result.
    redactions: { hashed_count: 0, dropped_count: 0, by_type: {} },
  };

  try {
    if (options.pluginVersion) {
      base.plugin = { name: "skillmeter", version: options.pluginVersion };
    }

    const homeDir = options.homeDir || os.homedir();
    const repoRoot =
      options.repoRoot !== undefined ? options.repoRoot : findRepoRoot(cwd);

    // ---- Instruction files (CLAUDE.md / AGENTS.md) ----
    // Project-scope = cwd or repo root; global-scope = ~/.claude. CLAUDE.md is
    // Claude Code's primary memory file; AGENTS.md is tracked too so cross-agent
    // harnesses are visible.
    const instrScopes = new Set();
    const projectDirs = [cwd, repoRoot].filter(Boolean);

    const hasProjectFile = (name) =>
      projectDirs.some((dir) => safeIsFile(path.join(dir, name)));

    const claudeProject = hasProjectFile("CLAUDE.md");
    const agentsProject = hasProjectFile("AGENTS.md");
    const claudeGlobal =
      !!homeDir && safeIsFile(path.join(homeDir, ".claude", "CLAUDE.md"));
    const agentsGlobal =
      !!homeDir && safeIsFile(path.join(homeDir, ".claude", "AGENTS.md"));

    if (claudeProject || agentsProject) instrScopes.add("project");
    if (claudeGlobal || agentsGlobal) instrScopes.add("global");

    base.instructions.has_claude_md = claudeProject;
    base.instructions.has_claude_md_global = claudeGlobal;
    base.instructions.has_agents_md = agentsProject;
    base.instructions.has_agents_md_global = agentsGlobal;
    base.instructions.scopes = [...instrScopes].sort();

    // ---- Skills ----
    const skillRoots = [];
    if (repoRoot) skillRoots.push({ scope: "project", dir: path.join(repoRoot, ".claude", "skills") });
    if (cwd && cwd !== repoRoot) skillRoots.push({ scope: "project", dir: path.join(cwd, ".claude", "skills") });
    if (homeDir) skillRoots.push({ scope: "global", dir: path.join(homeDir, ".claude", "skills") });

    const { names: skillNames, scopes: skillScopes } = detectSkills(skillRoots);
    base.skills.count = skillNames.length;
    base.skills.scopes = skillScopes;

    const hashNames =
      options.hashSkillNames !== undefined
        ? options.hashSkillNames
        : process.env.SKILLMETER_HARNESS_HASH_SKILL_NAMES === "1";
    const limited = skillNames.slice(0, SKILL_NAMES_LIMIT);

    // Tier 1 fail-closed scan (SBEE-165, Phase 2). A skill *name* is Tier 2
    // business data we may hash, but the directory name could still accidentally
    // embed a Tier 1 secret (an env var or token pasted into a folder name).
    // Drop any such name outright — never hash or emit it — and record the drop
    // in the bookkeeping. Scanning happens here, before the value is hashed,
    // because once hashed the central boundary can no longer tell it apart from
    // a benign token. (`skills.count` is a non-sensitive integer and keeps the
    // true on-disk total, just as it does for truncation.)
    const safeNames = limited.filter((name) => {
      if (containsTier1(name)) {
        recordRedaction(base.redactions, "dropped", "skill_name");
        return false;
      }
      return true;
    });

    if (hashNames && options.hashSalt) {
      delete base.skills.names;
      base.skills.names_hashed = safeNames.map((n) => {
        recordRedaction(base.redactions, "hashed", "skill_name");
        return hashHmac(n, options.hashSalt);
      });
    } else {
      base.skills.names = safeNames;
    }
    if (skillNames.length > limited.length) {
      base.skills.names_truncated = true;
    }

    // ---- Hooks ----
    // Claude hooks live in the plugin's hooks.json and in settings.json files
    // (user / project / local), all of which expose a top-level `hooks` object
    // keyed by event name.
    const hookSources = [];
    if (options.pluginRoot) {
      hookSources.push({
        scope: "plugin",
        file: path.join(options.pluginRoot, "hooks", "hooks.json"),
      });
    }
    if (homeDir) hookSources.push({ scope: "user", file: path.join(homeDir, ".claude", "settings.json") });
    if (repoRoot) {
      hookSources.push({ scope: "project", file: path.join(repoRoot, ".claude", "settings.json") });
      hookSources.push({ scope: "local", file: path.join(repoRoot, ".claude", "settings.local.json") });
    }
    if (cwd && cwd !== repoRoot) {
      hookSources.push({ scope: "project", file: path.join(cwd, ".claude", "settings.json") });
      hookSources.push({ scope: "local", file: path.join(cwd, ".claude", "settings.local.json") });
    }

    const { enabled, scopes: hookScopes } = detectHooks(hookSources);
    base.hooks.enabled = enabled;
    base.hooks.scopes = hookScopes;
  } catch {
    // Any unexpected failure leaves the safe defaults in place — never throw
    // out of the SessionStart hook.
  }

  return base;
}

module.exports = {
  HARNESS_SCHEMA_VERSION,
  KNOWN_HOOK_EVENTS,
  detectHarness,
  findRepoRoot,
};

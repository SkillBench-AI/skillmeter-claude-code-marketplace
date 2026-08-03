/**
 * Shared path constants for the plugin runtime. Centralised here so every
 * module (logger, transfer, etc.) agrees on where logs and pending files live.
 *
 * `CLAUDE_PLUGIN_ROOT` is set by the Claude Code loader when a hook runs; the
 * fallback resolves two levels up from this file for direct `node` invocations.
 *
 */

const path = require("path");
const crypto = require("crypto");
const { safeReadJson } = require("./io");
const { resolvePluginDataRoot } = require("./plugin-data-root");

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", "..");

// The telemetry queue + lock files must survive plugin updates, so they live
// exclusively in the host's persistent data dir. PLUGIN_ROOT is deliberately
// NOT a fallback: it is the install/cache dir, it changes on every update, and
// the old copy is reclaimed after about 14 days, stranding any queue there.
//
// Claude Code injects CLAUDE_PLUGIN_DATA into hooks but NOT into monitors or
// the `node ...` commands inside SKILL.md, so resolvePluginDataRoot derives the
// same directory for those. PLUGIN_ROOT is passed in rather than read from the
// environment because those processes have no CLAUDE_PLUGIN_ROOT either — only
// the __dirname fallback above is reliable there. See lib/plugin-data-root.js.
const DATA_ROOT = resolvePluginDataRoot(PLUGIN_ROOT);
if (!DATA_ROOT) {
  throw new Error(
    "[skillmeter] Could not resolve the plugin data directory from " +
    `${PLUGIN_ROOT}. Set CLAUDE_PLUGIN_DATA explicitly to run a script outside ` +
    "a plugin installation."
  );
}
const LOG_DIR = path.join(DATA_ROOT, "logs");
// Every queue is repository-scoped: telemetry is only ever staged under a
// canonical GitHub identity, so a queued artifact can never be transmitted
// under the wrong organization.
const REPOSITORIES_LOG_DIR = path.join(LOG_DIR, "repositories");
const ORGANIZATION_AUDIT_LOG_DIR = path.join(LOG_DIR, "organization-audit");
const SESSIONS_DIR = path.join(DATA_ROOT, "sessions");
const BACKFILL_STATE_FILE = path.join(DATA_ROOT, "backfill-state.json");

function repositoryStorageId(repoKey, hashSalt) {
  return crypto.createHmac("sha256", hashSalt).update(repoKey).digest("hex").slice(0, 12);
}

// `chunks` holds durable per-turn delta bodies (drained independently, deleted
// on 2xx). `cursors` is kept SEPARATE so a cursor ({transcriptId,lastUuid,seq})
// survives chunk deletion on the next turn and session end (--resume).
function repositoryQueuePaths(repoKey, hashSalt) {
  const root = path.join(REPOSITORIES_LOG_DIR, repositoryStorageId(repoKey, hashSalt));
  return {
    root,
    metadata: path.join(root, "repository.json"),
    eventLog: path.join(root, "events.jsonl"),
    chunks: path.join(root, "transcripts", "chunks"),
    cursors: path.join(root, "transcripts", "cursors"),
  };
}

function organizationAuditQueuePaths(tenantFingerprint) {
  const root = path.join(ORGANIZATION_AUDIT_LOG_DIR, tenantFingerprint);
  return {
    root,
    metadata: path.join(root, "tenant.json"),
    eventLog: path.join(root, "events.jsonl"),
  };
}

const PLUGIN_VERSION =
  (safeReadJson(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), {})).version ||
  "unknown";

module.exports = {
  PLUGIN_ROOT,
  LOG_DIR,
  REPOSITORIES_LOG_DIR,
  ORGANIZATION_AUDIT_LOG_DIR,
  SESSIONS_DIR,
  BACKFILL_STATE_FILE,
  repositoryQueuePaths,
  organizationAuditQueuePaths,
  PLUGIN_VERSION,
};

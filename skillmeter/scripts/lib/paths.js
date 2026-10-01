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
const { STATE_DIR } = require("./config");

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", "..");

// Queues and locks must survive updates in the persistent plugin data directory.
// Pass the resolved root to the data-directory resolver for skill/monitor calls
// without plugin environment variables. Never fall back to the install cache.
const DATA_ROOT = resolvePluginDataRoot(PLUGIN_ROOT);
if (!DATA_ROOT) {
  throw new Error(
    "[skillmeter] Could not resolve the plugin data directory from " +
    `${PLUGIN_ROOT}. Set CLAUDE_PLUGIN_DATA explicitly to run a script outside ` +
    "a plugin installation."
  );
}
const LOG_DIR = path.join(DATA_ROOT, "logs");
// Partition full telemetry by canonical repository identity; transfer rechecks
// current scope and consent before sending. Organization audits use a separate queue.
const REPOSITORIES_LOG_DIR = path.join(LOG_DIR, "repositories");
const ORGANIZATION_AUDIT_LOG_DIR = path.join(LOG_DIR, "organization-audit");
const SESSIONS_DIR = path.join(DATA_ROOT, "sessions");
const BACKFILL_STATE_FILE = path.join(DATA_ROOT, "backfill-state.json");
// Watched by FileChanged; written once when every historical chunk is settled.
const BACKFILL_RESULT_FILE = path.join(DATA_ROOT, "backfill-result.json");

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

// This client's own account state (ADR 005): its session, the session's status
// record and the sign-in and upload sentinels. Nothing here is shared with
// another client. Keyed by the shared state directory, so a dev and a prod
// environment on one installation (SKILLMETER_STATE_DIR) never share a session.
const ACCOUNT_DIR = path.join(
  DATA_ROOT,
  "account",
  crypto.createHash("sha256").update(path.resolve(STATE_DIR)).digest("hex").slice(0, 12)
);

const PLUGIN_VERSION =
  (safeReadJson(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), {})).version ||
  "unknown";

module.exports = {
  PLUGIN_ROOT,
  LOG_DIR,
  ACCOUNT_DIR,
  REPOSITORIES_LOG_DIR,
  ORGANIZATION_AUDIT_LOG_DIR,
  SESSIONS_DIR,
  BACKFILL_STATE_FILE,
  BACKFILL_RESULT_FILE,
  repositoryQueuePaths,
  organizationAuditQueuePaths,
  PLUGIN_VERSION,
};

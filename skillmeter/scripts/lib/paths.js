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

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", "..");

// The telemetry queue + lock files must survive plugin updates. PLUGIN_ROOT is
// the install/cache dir — it changes on every update and the old copy is deleted
// ~7 days later, which would strand any un-drained queue. CLAUDE_PLUGIN_DATA is
// the host-provided persistent data dir; prefer it. When it's unavailable
// (older Claude Code, direct `node`, tests) we fall back to PLUGIN_ROOT so
// behavior is byte-identical to before. lib/transfer.migrateLegacyQueue()
// removes old unbound queue items that cannot be authorized safely.
const DATA_ROOT = process.env.CLAUDE_PLUGIN_DATA || PLUGIN_ROOT;
const LOG_DIR = path.join(DATA_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");
const REPOSITORIES_LOG_DIR = path.join(LOG_DIR, "repositories");
// Transcripts that failed to upload get parked here for retry on next session.
const TRANSCRIPTS_PENDING_DIR = path.join(LOG_DIR, "transcripts", "pending");
// Delta-upload chunks (uuid-cursor): durable per-turn deltas drained
// independently and deleted on 2xx. Distinct dir from `pending` so the drain
// tells delta chunks from legacy full-file staging by directory alone.
const TRANSCRIPTS_CHUNKS_DIR = path.join(LOG_DIR, "transcripts", "chunks");
// Delta-upload cursors ({transcriptId,lastUuid,seq}). Kept SEPARATE from chunks
// so a cursor survives chunk deletion (next turn) and session end (--resume).
const TRANSCRIPTS_CURSORS_DIR = path.join(LOG_DIR, "transcripts", "cursors");
// Pre-0.17 / no-CLAUDE_PLUGIN_DATA location, for one-time forward migration.
const LEGACY_LOG_DIR = path.join(PLUGIN_ROOT, "logs");

function repositoryStorageId(repoKey, hashSalt) {
  return crypto.createHmac("sha256", hashSalt).update(repoKey).digest("hex").slice(0, 12);
}

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

const PLUGIN_VERSION =
  (safeReadJson(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), {})).version ||
  "unknown";

module.exports = {
  PLUGIN_ROOT,
  LOG_DIR,
  LOG_FILE,
  REPOSITORIES_LOG_DIR,
  TRANSCRIPTS_PENDING_DIR,
  TRANSCRIPTS_CHUNKS_DIR,
  TRANSCRIPTS_CURSORS_DIR,
  LEGACY_LOG_DIR,
  repositoryStorageId,
  repositoryQueuePaths,
  PLUGIN_VERSION,
};

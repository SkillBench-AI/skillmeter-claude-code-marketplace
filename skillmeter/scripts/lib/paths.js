/**
 * Shared path constants for the plugin runtime. Centralised here so every
 * module (logger, transfer, etc.) agrees on where logs and pending files live.
 *
 * `CLAUDE_PLUGIN_ROOT` is set by the Claude Code loader when a hook runs; the
 * fallback resolves two levels up from this file for direct `node` invocations.
 *
 * Cross-session user state (STATE_DIR/CRED_FILE) is owned by lib/config.js and
 * re-exported here so existing consumers (credstore, signin) keep importing it
 * from paths. Dependency direction is one-way: paths → config.
 */

const fs = require("fs");
const path = require("path");
const { STATE_DIR, CRED_FILE } = require("./config");

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", "..");

// The telemetry queue + lock files must survive plugin updates. PLUGIN_ROOT is
// the install/cache dir — it changes on every update and the old copy is deleted
// ~7 days later, which would strand any un-drained queue. CLAUDE_PLUGIN_DATA is
// the host-provided persistent data dir; prefer it. When it's unavailable
// (older Claude Code, direct `node`, tests) we fall back to PLUGIN_ROOT so
// behavior is byte-identical to before. lib/transfer.migrateLegacyQueue() moves
// any queue left in the legacy location forward on first run.
const DATA_ROOT = process.env.CLAUDE_PLUGIN_DATA || PLUGIN_ROOT;
const LOG_DIR = path.join(DATA_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");
// Transcripts that failed to upload get parked here for retry on next session.
const TRANSCRIPTS_PENDING_DIR = path.join(LOG_DIR, "transcripts", "pending");
// Pre-0.17 / no-CLAUDE_PLUGIN_DATA location, for one-time forward migration.
const LEGACY_LOG_DIR = path.join(PLUGIN_ROOT, "logs");

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
})();

module.exports = {
  PLUGIN_ROOT,
  STATE_DIR,
  CRED_FILE,
  LOG_DIR,
  LOG_FILE,
  TRANSCRIPTS_PENDING_DIR,
  LEGACY_LOG_DIR,
  PLUGIN_VERSION,
};

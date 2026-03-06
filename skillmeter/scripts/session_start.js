#!/usr/bin/env node
/**
 * SessionStart hook - Logs session start events
 * Expected input JSON structure:
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionStart",
 *   "source": "startup",
 *   "model": "claude-sonnet-4-6"
 * }
 */

const fs = require("fs");
const path = require("path");
const { getDeviceId, logInfo, readStdin, processTranscript, retryFailedLogs, getTelemetryOptIn, promptTelemetryOptIn, PLUGIN_ROOT } = require("./logger.js");

// Read version from plugin.json
const pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
const VERSION = pluginJson.version || "unknown";

async function main() {
  // Get device ID (skip logging if unavailable)
  const deviceId = getDeviceId();
  if (!deviceId) {
    process.exit(0);
  }

  // Retry failed log transfers from previous sessions
  retryFailedLogs(deviceId, "SessionStart");

  // Read input from stdin
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  // Check telemetry opt-in
  const cwd = input.cwd || process.cwd();
  let optIn = getTelemetryOptIn(cwd);
  if (optIn === null) {
    optIn = promptTelemetryOptIn(cwd);
  }

  // Display version and activation status
  if (optIn) {
    process.stderr.write(`SkillMeter v${VERSION} (activated)\n`);
  } else {
    process.stderr.write(`SkillMeter v${VERSION} (not activated)\n`);
    process.exit(0);
  }

  // Extract session_id and transcript_path
  const sessionId = input.session_id || "unknown";
  const transcriptPath = input.transcript_path || "";

  // Build data object
  const data = {
    permission_mode: input.permission_mode,
    source: input.source,
    model: input.model,
  };

  // Log the event
  logInfo("SessionStart", sessionId, data, deviceId);

  // Process transcript incrementally
  if (transcriptPath) {
    processTranscript(transcriptPath, "SessionStart", sessionId, deviceId, data);
  }
}

main().catch(() => process.exit(1));

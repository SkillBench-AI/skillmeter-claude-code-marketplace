#!/usr/bin/env node
/**
 * SessionStart hook - Logs session start events
 * Expected input JSON structure:
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionStart",
 *   "source": "startup"
 * }
 */

const { getDeviceId, logInfo, readStdin } = require("./logger.js");

async function main() {
  // Get device ID (skip logging if unavailable)
  const deviceId = getDeviceId();
  if (!deviceId) {
    process.exit(0);
  }

  // Read input from stdin
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  // Extract session_id
  const sessionId = input.session_id || "unknown";

  // Build data object
  const data = {
    permission_mode: input.permission_mode,
    source: input.source,
  };

  // Log the event
  logInfo("SessionStart", sessionId, data, deviceId);
}

main().catch(() => process.exit(1));

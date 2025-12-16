#!/usr/bin/env node
/**
 * Stop hook - Logs when Claude is interrupted/stopped
 * Expected input JSON structure:
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
 *   "permission_mode": "default",
 *   "hook_event_name": "Stop",
 *   "stop_hook_active": true
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
    stop_hook_active: input.stop_hook_active,
  };

  // Log the event
  logInfo("Stop", sessionId, data, deviceId);
}

main().catch(() => process.exit(1));

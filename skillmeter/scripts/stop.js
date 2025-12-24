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

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getDeviceId, logInfo, readStdin, PLUGIN_ROOT, LOG_FILE } = require("./logger.js");

// Transfer script path
const TRANSFER_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "transfer_log.js");

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

  // Transfer log file after stop (atomic rename to prevent race conditions)
  if (fs.existsSync(LOG_FILE) && fs.existsSync(TRANSFER_SCRIPT)) {
    try {
      const timestamp = Date.now();
      const sendingFile = `${LOG_FILE}.${timestamp}`;
      fs.renameSync(LOG_FILE, sendingFile);

      spawn("node", [TRANSFER_SCRIPT, sendingFile], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch {
      // Ignore errors (file might have been renamed by another session)
    }
  }
}

main().catch(() => process.exit(1));

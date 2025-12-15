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

const fs = require("fs");
const path = require("path");
const { getDeviceId, logInfo, readStdin, expandHome, PLUGIN_ROOT } = require("./logger.js");

// Tracking directory for transcript read positions
const TRACKING_DIR = path.join(PLUGIN_ROOT, "tracking");

/**
 * Get current line count of a file
 * @param {string} filePath - Path to the file
 * @returns {number} Line count (0 if file doesn't exist)
 */
function getLineCount(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Create or update tracking file for a session
 * @param {string} sessionId - Session ID
 * @param {number} lineCount - Current line count to store
 */
function createTrackingFile(sessionId, lineCount) {
  try {
    fs.mkdirSync(TRACKING_DIR, { recursive: true });
    const trackingFile = path.join(TRACKING_DIR, `${sessionId}.txt`);
    fs.writeFileSync(trackingFile, String(lineCount), { mode: 0o600 });
  } catch {
    // Ignore errors
  }
}

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

  // Extract transcript_path and create tracking file
  const transcriptPath = input.transcript_path || "";
  if (transcriptPath) {
    const expandedPath = expandHome(transcriptPath);
    const currentLineCount = getLineCount(expandedPath);
    createTrackingFile(sessionId, currentLineCount);
  }

  // Build data object
  const data = {
    permission_mode: input.permission_mode,
    source: input.source,
  };

  // Log the event
  logInfo("SessionStart", sessionId, data, deviceId);
}

main().catch(() => process.exit(1));

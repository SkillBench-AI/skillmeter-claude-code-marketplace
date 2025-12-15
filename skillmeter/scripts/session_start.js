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
 * Parse transcript JSONL file and get tracking info
 * @param {string} filePath - Path to the transcript JSONL file
 * @returns {object} Tracking info with lineCount and lastUuid
 */
function parseTranscript(filePath) {
  const result = { lineCount: 0, lastUuid: null, messages: [] };

  try {
    if (!fs.existsSync(filePath)) return result;

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        result.messages.push(entry);
        // Track UUID if available
        if (entry.uuid) {
          result.lastUuid = entry.uuid;
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    result.lineCount = result.messages.length;
  } catch {
    // Ignore file read errors
  }

  return result;
}

/**
 * Create or update tracking file for a session
 * @param {string} sessionId - Session ID
 * @param {object} trackingInfo - Tracking info to store
 */
function createTrackingFile(sessionId, trackingInfo) {
  try {
    fs.mkdirSync(TRACKING_DIR, { recursive: true });
    const trackingFile = path.join(TRACKING_DIR, `${sessionId}.json`);
    fs.writeFileSync(trackingFile, JSON.stringify(trackingInfo, null, 2), { mode: 0o600 });
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
    const trackingInfo = parseTranscript(expandedPath);
    // Don't store messages in tracking file, just metadata
    createTrackingFile(sessionId, {
      lineCount: trackingInfo.lineCount,
      lastUuid: trackingInfo.lastUuid,
    });
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

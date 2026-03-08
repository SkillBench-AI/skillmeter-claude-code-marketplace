#!/usr/bin/env node
/**
 * SessionEnd hook - Logs session end events and finalizes conversation
 * Expected input JSON structure:
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
 *   "cwd": "/Users/...",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionEnd",
 *   "reason": "exit"
 * }
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  getDeviceId,
  getLicenseToken,
  logInfo,
  readStdin,
  processTranscript,
  transferConversation,
  getTelemetryOptIn,
  PLUGIN_ROOT,
} = require("./logger.js");

const TRANSFER_CONVERSATION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "transfer_conversation.js");

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

  // Check telemetry opt-in
  const cwd = input.cwd || process.cwd();
  if (getTelemetryOptIn(cwd) !== true) {
    process.exit(0);
  }

  // Extract session_id
  const sessionId = input.session_id || "unknown";
  const transcriptPath = input.transcript_path || "";
  const reason = input.reason || "";

  // Build data object
  const data = {
    permission_mode: input.permission_mode,
    reason: reason,
  };

  // Log to events.jsonl
  logInfo("SessionEnd", sessionId, data, deviceId);

  // Finalize transcript processing
  if (transcriptPath) {

    // Process any remaining messages
    processTranscript(transcriptPath, "SessionEnd", sessionId, deviceId, data);

    // Transfer conversation on session end
    const sendingFile = transferConversation(sessionId, "SessionEnd", deviceId, data);

    if (sendingFile) {
      if (fs.existsSync(TRANSFER_CONVERSATION_SCRIPT)) {
        const token = getLicenseToken();
        if (!token) {
          process.stderr.write("SkillMeter: Chat data not transferred (no license token)\n");
        } else {
          const result = spawnSync("node", [TRANSFER_CONVERSATION_SCRIPT, sendingFile, "SessionEnd", sessionId, deviceId, JSON.stringify(data)], {
            timeout: 8000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          if (result.status === 0) {
            process.stderr.write("SkillMeter: Chat data transferred\n");
          } else {
            const err = result.stderr?.toString().trim() || "unknown error";
            process.stderr.write(`SkillMeter: Chat data transfer failed (${err})\n`);
          }
        }
      }
    } else {
      process.stderr.write("SkillMeter: No chat data to transfer\n");
    }
  }
}

main().catch(() => process.exit(1));

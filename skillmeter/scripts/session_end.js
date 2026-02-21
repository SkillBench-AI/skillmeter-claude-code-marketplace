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
const { spawn } = require("child_process");
const {
  getDeviceId,
  logInfo,
  readStdin,
  processTranscript,
  getConversationFilePath,
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

    // Transfer conversation if prompt_input_exit
    const conversationFile = getConversationFilePath(sessionId);

    if (reason === "prompt_input_exit" && fs.existsSync(conversationFile)) {
      const timestamp = Date.now();
      const sendingFile = `${conversationFile}.${timestamp}`;
      fs.renameSync(conversationFile, sendingFile);

      if (fs.existsSync(TRANSFER_CONVERSATION_SCRIPT)) {
        spawn("node", [TRANSFER_CONVERSATION_SCRIPT, sendingFile, "SessionEnd", sessionId, deviceId, JSON.stringify(data)], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
    }
  }
}

main().catch(() => process.exit(1));

#!/usr/bin/env node
/**
 * PostToolUse hook - Logs tool invocations with privacy-preserving hashing
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id
 */

const { getDeviceId, hashHmac, getOrCreateHashSalt, logInfo, readStdin, processTranscript, getTelemetryOptIn } = require("./logger.js");

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

  // Extract session_id and transcript_path
  const sessionId = input.session_id || "unknown";
  const transcriptPath = input.transcript_path || "";

  // Get hash salt for HMAC hashing
  const hashSalt = getOrCreateHashSalt();

  // Extract and hash file_path if present in tool_input
  const filePath = input.tool_input?.file_path || "";
  let data;

  if (filePath) {
    // Hash the file path for privacy (first 12 chars of HMAC-SHA256)
    const fileHash = hashHmac(filePath, hashSalt);

    // Build data object with only file_path in tool_input
    data = {
      permission_mode: input.permission_mode,
      tool_name: input.tool_name,
      tool_input: { file_path: fileHash },
      tool_use_id: input.tool_use_id,
    };
  } else {
    // Build data object without tool_input (no file_path to log)
    data = {
      permission_mode: input.permission_mode,
      tool_name: input.tool_name,
      tool_input: {},
      tool_use_id: input.tool_use_id,
    };
  }

  // Log the event
  logInfo("PostToolUse", sessionId, data, deviceId);

  // Process transcript incrementally
  if (transcriptPath) {
    processTranscript(transcriptPath, "PostToolUse", sessionId, deviceId, data);
  }
}

main().catch(() => process.exit(1));

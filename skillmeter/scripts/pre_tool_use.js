#!/usr/bin/env node
/**
 * PreToolUse hook - Logs tool invocations with privacy-preserving hashing
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id
 */

const { getDeviceId, hashSha256, logInfo, readStdin } = require("./logger.js");

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

  // Extract and hash file_path if present in tool_input
  const filePath = input.tool_input?.file_path || "";
  let data;

  if (filePath) {
    // Hash the file path for privacy (first 16 chars of SHA256)
    const fileHash = hashSha256(filePath);

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
  logInfo("PreToolUse", sessionId, data, deviceId);
}

main().catch(() => process.exit(1));

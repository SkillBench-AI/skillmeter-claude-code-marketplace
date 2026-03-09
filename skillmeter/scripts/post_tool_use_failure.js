#!/usr/bin/env node
/**
 * PostToolUseFailure hook - Logs when a tool execution fails
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id, error
 */

const { getDeviceId, getOrCreateHashSalt, getTranscriptId, hashHmac, logInfo, readStdin, sanitizeToolData, getTelemetryOptIn } = require("./logger.js");

async function main() {
  const deviceId = getDeviceId();
  if (!deviceId) {
    process.exit(0);
  }

  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  if (getTelemetryOptIn(cwd) !== true) {
    process.exit(0);
  }

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();

  const data = {
    transcript_path: getTranscriptId(input.transcript_path),
    cwd: hashHmac(cwd, hashSalt),
    permission_mode: input.permission_mode,
    tool_name: input.tool_name,
    tool_input: sanitizeToolData(input.tool_input, hashSalt),
    tool_use_id: input.tool_use_id,
    error: input.error,
    is_interrupt: input.is_interrupt,
  };

  logInfo("PostToolUseFailure", sessionId, data, deviceId);
}

main().catch(() => process.exit(1));

#!/usr/bin/env node
/**
 * PermissionRequest hook - Logs when a permission dialog is shown
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input
 */

const { getDeviceId, hashHmac, getOrCreateHashSalt, logInfo, readStdin, processTranscript, getTelemetryOptIn } = require("./logger.js");

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
  const transcriptPath = input.transcript_path || "";

  const hashSalt = getOrCreateHashSalt();
  const filePath = input.tool_input?.file_path || "";

  const data = {
    permission_mode: input.permission_mode,
    tool_name: input.tool_name,
    tool_input: filePath ? { file_path: hashHmac(filePath, hashSalt) } : {},
  };

  logInfo("PermissionRequest", sessionId, data, deviceId);

  if (transcriptPath) {
    processTranscript(transcriptPath, "PermissionRequest", sessionId, deviceId, data);
  }
}

main().catch(() => process.exit(1));

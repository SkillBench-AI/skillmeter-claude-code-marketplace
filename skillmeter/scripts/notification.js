#!/usr/bin/env node
/**
 * Notification hook - Logs when Claude Code sends notifications
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, message
 */

const { getDeviceId, logInfo, readStdin, processTranscript, getTelemetryOptIn } = require("./logger.js");

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

  const data = {
    permission_mode: input.permission_mode,
  };

  logInfo("Notification", sessionId, data, deviceId);

  if (transcriptPath) {
    processTranscript(transcriptPath, "Notification", sessionId, deviceId, data);
  }
}

main().catch(() => process.exit(1));

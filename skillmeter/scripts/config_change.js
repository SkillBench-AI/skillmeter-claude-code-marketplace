#!/usr/bin/env node
/**
 * ConfigChange hook - Logs when a configuration file changes during a session
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name
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

  logInfo("ConfigChange", sessionId, data, deviceId);

  if (transcriptPath) {
    processTranscript(transcriptPath, "ConfigChange", sessionId, deviceId, data);
  }
}

main().catch(() => process.exit(1));

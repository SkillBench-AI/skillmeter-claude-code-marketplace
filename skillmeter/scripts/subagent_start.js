#!/usr/bin/env node
/**
 * SubagentStart hook - Logs when a subagent is started
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, subagent_type
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
    subagent_type: input.subagent_type,
  };

  logInfo("SubagentStart", sessionId, data, deviceId);

  if (transcriptPath) {
    processTranscript(transcriptPath, "SubagentStart", sessionId, deviceId, data);
  }
}

main().catch(() => process.exit(1));

#!/usr/bin/env node
/**
 * SubagentStop hook - Logs when a subagent attempts to stop
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active, agent_id, agent_type, agent_transcript_path, last_assistant_message
 */

const { getDeviceId, getOrCreateHashSalt, getTranscriptId, hashHmac, logInfo, readStdin, getTelemetryOptIn } = require("./logger.js");

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
    stop_hook_active: input.stop_hook_active,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    agent_transcript_path: getTranscriptId(input.agent_transcript_path),
    last_assistant_message: input.last_assistant_message,
  };

  logInfo("SubagentStop", sessionId, data, deviceId);

}

main().catch(() => process.exit(1));

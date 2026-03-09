#!/usr/bin/env node
/**
 * SubagentStart hook - Logs when a subagent is started
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, agent_id, agent_type
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
    agent_id: input.agent_id,
    agent_type: input.agent_type,
  };

  logInfo("SubagentStart", sessionId, data, deviceId);

}

main().catch(() => process.exit(1));

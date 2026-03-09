#!/usr/bin/env node
/**
 * WorktreeCreate hook - Logs when a worktree is being created
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name
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
    name: input.name,
  };

  logInfo("WorktreeCreate", sessionId, data, deviceId);

}

main().catch(() => process.exit(1));

#!/usr/bin/env node
/**
 * UserPromptSubmit hook - Logs user prompt submissions with privacy-preserving hashing
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt
 */

const { getDeviceId, getOrCreateHashSalt, getTranscriptId, hashHmac, logInfo, readStdin, getTelemetryOptIn } = require("./logger.js");

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

  // Extract session_id
  const sessionId = input.session_id || "unknown";

  const hashSalt = getOrCreateHashSalt();
  const data = {
    transcript_path: getTranscriptId(input.transcript_path),
    cwd: hashHmac(cwd, hashSalt),
    permission_mode: input.permission_mode,
    prompt: input.prompt,
  };

  // Log the event
  logInfo("UserPromptSubmit", sessionId, data, deviceId);
}

main().catch(() => process.exit(1));

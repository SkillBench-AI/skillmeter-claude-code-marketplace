#!/usr/bin/env node
/**
 * UserPromptSubmit hook - Logs user prompt submissions with privacy-preserving hashing
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt
 */

const { getDeviceId, hashHmac, getOrCreateHashSalt, logInfo, readStdin, getTelemetryOptIn } = require("./logger.js");

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

  // Get hash salt for HMAC hashing
  const hashSalt = getOrCreateHashSalt();

  // Extract and hash transcript_path if present
  const transcriptPath = input.transcript_path || "";
  let data;

  if (transcriptPath) {
    // Hash the transcript path for privacy (first 12 chars of HMAC-SHA256)
    const transcriptHash = hashHmac(transcriptPath, hashSalt);

    // Build data object with hashed transcript_path
    data = {
      transcript_path: transcriptHash,
      permission_mode: input.permission_mode,
      prompt: input.prompt,
    };
  } else {
    // Build data object without transcript_path
    data = {
      permission_mode: input.permission_mode,
      prompt: input.prompt,
    };
  }

  // Log the event
  logInfo("UserPromptSubmit", sessionId, data, deviceId);
}

main().catch(() => process.exit(1));

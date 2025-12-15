#!/usr/bin/env node
/**
 * UserPromptSubmit hook - Logs user prompt submissions with privacy-preserving hashing
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt
 */

const { getDeviceId, hashSha256, logInfo, readStdin } = require("./logger.js");

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

  // Extract session_id
  const sessionId = input.session_id || "unknown";

  // Extract and hash transcript_path if present
  const transcriptPath = input.transcript_path || "";
  let data;

  if (transcriptPath) {
    // Hash the transcript path for privacy (first 16 chars of SHA256)
    const transcriptHash = hashSha256(transcriptPath);

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

#!/usr/bin/env node
/**
 * InstructionsLoaded hook - Logs when CLAUDE.md or .claude/rules/*.md files are loaded
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name
 */

const { getDeviceId, logInfo, readStdin, getTelemetryOptIn } = require("./logger.js");

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

  const data = {
    permission_mode: input.permission_mode,
    file_path: input.file_path,
    memory_type: input.memory_type,
    load_reason: input.load_reason,
  };

  logInfo("InstructionsLoaded", sessionId, data, deviceId);

}

main().catch(() => process.exit(1));

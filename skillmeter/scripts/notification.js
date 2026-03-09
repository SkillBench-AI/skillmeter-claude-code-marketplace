#!/usr/bin/env node
/**
 * Notification hook - Logs when Claude Code sends notifications
 * Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, message
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
    message: input.message,
    title: input.title,
    notification_type: input.notification_type,
  };

  logInfo("Notification", sessionId, data, deviceId);

}

main().catch(() => process.exit(1));

#!/usr/bin/env node
const {
  runHook,
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
  tryRefreshLicense,
  getTelemetryOptIn,
  PLUGIN_VERSION,
} = require("./logger.js");

runHook("SessionStart", (input) => ({
  source: input.source,
  model: input.model,
  agent_type: input.agent_type,
}), {
  checkOptIn: (cwd) => {
    const optIn = getTelemetryOptIn(cwd);
    if (optIn === true) {
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (activated)\n`);
      retryFailedLogs();
      retryFailedTranscripts();
      cleanupStaleFiles();
      return true;
    }
    if (optIn === false) {
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (telemetry disabled for this project)\n`);
      return false;
    }
    // optIn === null — no per-project preference yet. Nudge the user to
    // choose via the slash command. Telemetry is skipped this session until
    // they pick one.
    process.stderr.write(
      `SkillMeter v${PLUGIN_VERSION} (telemetry not configured for this project)\n` +
      `  Run /skillmeter:telemetry enable   — send anonymized session data\n` +
      `  Run /skillmeter:telemetry disable  — opt out for this project\n`
    );
    return false;
  },
  // Mirror the VS Code extension's auto-refresh on service start: if
  // the stored license JWT is missing or within the expiry skew, try
  // the silent gh path. Best-effort — never blocks the session.
  afterLog: async (_input, deviceId) => {
    try { await tryRefreshLicense(deviceId); } catch {}
  },
}).catch(() => process.exit(1));

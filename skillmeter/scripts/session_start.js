#!/usr/bin/env node
const {
  runHook,
  retryFailedLogs,
  tryRefreshLicense,
  getTelemetryOptIn,
  promptTelemetryOptIn,
  PLUGIN_VERSION,
} = require("./logger.js");

runHook("SessionStart", (input) => ({
  source: input.source,
  model: input.model,
  agent_type: input.agent_type,
}), {
  checkOptIn: (cwd) => {
    let optIn = getTelemetryOptIn(cwd);
    if (optIn === null) optIn = promptTelemetryOptIn(cwd);
    if (optIn) {
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (activated)\n`);
      retryFailedLogs();
    } else {
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (not activated)\n`);
    }
    return optIn;
  },
  // Mirror the VS Code extension's auto-refresh on service start: if
  // the stored license JWT is missing or within the expiry skew, try
  // the silent gh path. Best-effort — never blocks the session.
  afterLog: async (_input, deviceId) => {
    try { await tryRefreshLicense(deviceId); } catch {}
  },
}).catch(() => process.exit(1));

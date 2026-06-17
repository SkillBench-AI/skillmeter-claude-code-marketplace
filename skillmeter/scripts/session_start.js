#!/usr/bin/env node
const {
  runHook,
  resolveTelemetryGate,
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
  tryRefreshLicense,
  getTelemetryOptIn,
  PLUGIN_VERSION,
} = require("./logger.js");
const { getRepoScopeDecision } = require("./lib/repo-scope");

runHook("SessionStart", (input) => ({
  source: input.source,
  model: input.model,
  agent_type: input.agent_type,
}), {
  checkOptIn: (cwd) => {
    const optIn = getTelemetryOptIn(cwd);
    if (optIn === false) {
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (telemetry disabled for this project)\n`);
      return false;
    }
    // Same policy as the default gate (resolveTelemetryGate): explicit opt-in,
    // or auto-enable when the repo is owned by an allowed org. Kept in sync via
    // the shared helper so SessionStart can't drift from the rest of the hooks.
    const { capture, mode } = resolveTelemetryGate(optIn, getRepoScopeDecision(cwd).allowed);
    if (capture) {
      const note = mode === "auto_org"
        ? "(telemetry auto-enabled — repo owned by allowed org)"
        : "(activated)";
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} ${note}\n`);
      retryFailedLogs();
      retryFailedTranscripts();
      cleanupStaleFiles();
      return true;
    }
    // optIn === null AND repo not org-owned — no per-project preference and no
    // auto-enable signal. Nudge the user to choose via the slash command.
    process.stderr.write(
      `SkillMeter v${PLUGIN_VERSION} (telemetry not configured for this project)\n` +
      `  /skillmeter:signin                — sign in with GitHub\n` +
      `  /skillmeter:telemetry enable      — opt this project in\n` +
      `  /skillmeter:telemetry disable     — opt this project out\n` +
      `  /skillmeter:telemetry status      — show current state\n`
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

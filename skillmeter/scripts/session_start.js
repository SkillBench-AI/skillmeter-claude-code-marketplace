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
const { detectHarness } = require("./harness.js");
const { PLUGIN_ROOT } = require("./lib/paths");
const { sanitizeEventData } = require("./lib/sanitize");

runHook("SessionStart", (input, ctx) => {
  // Harness metadata (SBEE-163, Phase 1): presence/shape of the developer's
  // harness (instruction files, skills, hooks, plugin/agent info), detected
  // once at session start. Metadata only — no raw harness file contents.
  const harness = detectHarness(ctx.cwd, {
    hashSalt: ctx.hashSalt,
    pluginRoot: PLUGIN_ROOT,
    pluginVersion: PLUGIN_VERSION,
    agentType: input.agent_type,
    model: input.model,
    sessionSource: input.source,
  });

  // Phase 2 (SBEE-165): route the harness block through the deterministic
  // Tier-1/Tier-2 sanitization boundary as a catch-all on top of harness.js's
  // own fail-closed name handling, so any residual secret/email in a probed
  // value is scrubbed before the event is logged or uploaded.
  const { value: sanitizedHarness, meta } = sanitizeEventData(harness);
  if (meta.tier1 > 0 || meta.tier2 > 0) {
    sanitizedHarness._sanitization = meta;
    process.stderr.write(
      `[skillmeter] SessionStart: redacted ${meta.tier1} secret(s) and ${meta.tier2} identifier(s) from harness metadata before upload\n`
    );
  }

  return {
    source: input.source,
    model: input.model,
    agent_type: input.agent_type,
    harness: sanitizedHarness,
  };
}, {
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

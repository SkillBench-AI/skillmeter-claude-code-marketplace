#!/usr/bin/env node
const { runHook } = require("./logger.js");
const { retryFailedLogs, retryFailedTranscripts, cleanupStaleFiles, migrateLegacyQueue } = require("./lib/transfer");
const { refreshLicense } = require("./lib/license-activation");
const { detectHarness } = require("./harness.js");
const { PLUGIN_ROOT, PLUGIN_VERSION } = require("./lib/paths");
const { sanitizeEventData } = require("./lib/sanitize");
const { signInRequiredBanner, telemetryActiveBanner } = require("./lib/banner.js");
const credstore = require("./credstore.js");

// Pre-hook work: refresh the license (silent gh) so the banner decision below
// reflects the freshest state, and ensure the sign-in sentinel file exists so
// SessionStart's `watchPaths` can register it before the first sign-in. No
// stdout here — all SessionStart stdout is emitted once, from onGate, so
// watchPaths and the optional banner stay a single JSON object.
async function prepareSession() {
  const deviceId = credstore.getDeviceId();
  if (!deviceId || credstore.getTelemetryDisabled()) return;
  credstore.ensureSigninResultFile();
  migrateLegacyQueue();
  try { await refreshLicense(deviceId); } catch {}
}

function runSessionStartHook() {
  return runHook("SessionStart", (input, ctx) => {
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
    // React to the gate runHook already resolved (capture decision stays central).
    onGate: ({ gate, repoScopeDecision }) => {
      // Single SessionStart stdout JSON. Always register the sign-in sentinel so
      // the FileChanged notifier can report sign-in success/failure without the
      // user re-running /skillmeter:signin. Attach exactly one banner when
      // relevant (not-signed-in vs telemetry-active are mutually exclusive).
      const out = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          watchPaths: [credstore.SIGNIN_RESULT_FILE],
        },
      };
      if (!credstore.hasValidLicense()) {
        out.systemMessage = signInRequiredBanner();
      } else if (gate.capture && repoScopeDecision.allowed) {
        // Telemetry actually captures only when the repo is in scope too (the
        // hard repo-scope block downstream); show "active" only then.
        out.systemMessage = telemetryActiveBanner(repoScopeDecision.remoteOrg);
      }
      process.stdout.write(JSON.stringify(out) + "\n");

      // stderr notices + SessionStart-only side effects (wording unchanged).
      if (gate.mode === "opted_out") {
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (telemetry disabled for this project)\n`);
        return;
      }
      if (gate.capture) {
        const note = gate.mode === "auto_org"
          ? "(telemetry auto-enabled — repo owned by allowed org)"
          : "(activated)";
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} ${note}\n`);
        retryFailedLogs();
        retryFailedTranscripts();
        cleanupStaleFiles();
        return;
      }
      // not_enabled: no per-project preference and no auto-enable signal.
      process.stderr.write(
        `SkillMeter v${PLUGIN_VERSION} (telemetry not configured for this project)\n` +
        `  /skillmeter:signin                — sign in with GitHub\n` +
        `  /skillmeter:telemetry enable      — opt this project in\n` +
        `  /skillmeter:telemetry disable     — opt this project out\n` +
        `  /skillmeter:telemetry status      — show current state\n`
      );
    },
  });
}

// Refresh the license + ensure the sentinel first, then run the telemetry hook
// (which emits the single SessionStart stdout JSON from onGate). Sequenced so
// the refresh completes before onGate reads the license state.
prepareSession()
  .catch(() => {})
  .finally(() => {
    runSessionStartHook().catch(() => process.exit(1));
  });

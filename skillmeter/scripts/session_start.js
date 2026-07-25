#!/usr/bin/env node
const { runHook } = require("./logger.js");
const { retryFailedLogs, retryFailedTranscripts, cleanupStaleFiles, migrateLegacyQueue } = require("./lib/transfer");
const { refreshLicense } = require("./lib/license-activation");
const { detectHarness } = require("./harness.js");
const { PLUGIN_ROOT, PLUGIN_VERSION } = require("./lib/paths");
const {
  signInRequiredBanner,
  telemetryConsentRequiredBanner,
  telemetryActiveBanner,
  telemetrySentNotice,
  telemetryFailedNotice,
} = require("./lib/banner.js");
const credstore = require("./credstore.js");

// Pre-hook work: refresh the license (silent gh) so the banner decision below
// reflects the freshest state, and ensure the sign-in sentinel file exists so
// SessionStart's `watchPaths` can register it before the first sign-in. No
// stdout here — all SessionStart stdout is emitted once, from onGate, so
// watchPaths and the optional banner stay a single JSON object.
async function prepareSession() {
  const deviceId = credstore.getDeviceId();
  credstore.ensureSigninResultFile();
  credstore.migrateOrgTelemetryConsent();
  migrateLegacyQueue();
  if (!deviceId || credstore.getTelemetryDisabled()) return;
  try { await refreshLicense(deviceId); } catch {}
}

function runSessionStartHook() {
  return runHook("SessionStart", (input, ctx) => {
    // Harness metadata (SBEE-163, Phase 1): presence/shape of the developer's
    // harness (instruction files, skills, hooks, plugin/agent info), detected
    // once at session start. Metadata only — no raw harness file contents.
    const harness = detectHarness(ctx.cwd, {
      pluginRoot: PLUGIN_ROOT,
      pluginVersion: PLUGIN_VERSION,
      agentType: input.agent_type,
      // Claude Code does not expose its CLI version to hooks today; read the
      // common env-var candidates best-effort so the field populates if a future
      // runtime does. Typically "".
      agentVersion:
        input.version ||
        process.env.CLAUDE_CODE_VERSION ||
        process.env.CLAUDECODE_VERSION ||
        "",
      model: input.model,
      sessionSource: input.source,
    });

    // The harness block is returned raw here; runHook's central sanitizeEventData
    // boundary scrubs it (secret/PII + path hashing) as a catch-all on top of
    // harness.js's own fail-closed name handling, and records the redaction tally
    // in the event's `_sanitization` field.
    return {
      source: input.source,
      model: input.model,
      agent_type: input.agent_type,
      session_title: input.session_title,
      harness,
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
      // One banner (not-signed-in vs telemetry-active are mutually exclusive),
      // optionally preceded by a one-line notice from the last drain (which ran
      // detached and couldn't print itself): success with counts, or failure
      // with the error. Shown once, then marked notified so it doesn't repeat.
      const lines = [];
      const up = credstore.readUploadResult();
      if (up && !up.notified) {
        if (up.events > 0 || up.transcripts > 0) {
          lines.push(telemetrySentNotice(up.events, up.transcripts));
          credstore.markUploadNotified();
        } else if (up.error) {
          lines.push(telemetryFailedNotice(up.error));
          credstore.markUploadNotified();
        }
      }
      if (!credstore.hasValidLicense()) {
        lines.push(signInRequiredBanner());
      } else if (gate.mode === "org_consent_required") {
        lines.push(telemetryConsentRequiredBanner(repoScopeDecision.remoteOrg));
      } else if (gate.capture && repoScopeDecision.allowed) {
        // Telemetry actually captures only when the repo is in scope too (the
        // hard repo-scope block downstream); show "active" only then.
        lines.push(telemetryActiveBanner(repoScopeDecision.remoteOrg));
      }
      if (lines.length) out.systemMessage = lines.join("\n");
      process.stdout.write(JSON.stringify(out) + "\n");

      // stderr notices + SessionStart-only side effects (wording unchanged).
      if (gate.mode === "project_disabled") {
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (telemetry disabled for this project)\n`);
        return;
      }
      if (gate.mode === "org_consent_required") {
        process.stderr.write(
          `SkillMeter v${PLUGIN_VERSION} (telemetry choice required for @${repoScopeDecision.remoteOrg})\n`
        );
        return;
      }
      if (gate.mode === "org_disabled") {
        process.stderr.write(
          `SkillMeter v${PLUGIN_VERSION} (telemetry disabled for @${repoScopeDecision.remoteOrg})\n`
        );
        return;
      }
      if (gate.capture) {
        const note = gate.mode === "org_enabled"
          ? `(telemetry enabled for @${repoScopeDecision.remoteOrg})`
          : "(activated)";
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} ${note}\n`);
        retryFailedLogs();
        retryFailedTranscripts();
        cleanupStaleFiles();
        return;
      }
      // Not signed in, out of scope, or globally paused.
      process.stderr.write(
        `SkillMeter v${PLUGIN_VERSION} (telemetry not configured for this project)\n` +
        `  /skillmeter:signin                — sign in with GitHub\n` +
        `  /skillmeter:telemetry list        — review repository targets\n`
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

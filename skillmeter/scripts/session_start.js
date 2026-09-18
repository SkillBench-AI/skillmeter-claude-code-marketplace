#!/usr/bin/env node
const { runHook } = require("./logger.js");
const {
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
  initializeTranscriptCursor,
} = require("./lib/transfer");
const { refreshLicense } = require("./lib/license-activation");
const { clearTerminal } = require("./lib/license-status");
const { detectHarness } = require("./harness.js");
const { PLUGIN_ROOT, PLUGIN_VERSION } = require("./lib/paths");
const { initializeBackfillLifecycle } = require("./lib/backfill-state");
const {
  signInRequiredBanner,
  telemetryConsentRequiredBanner,
  telemetryRepositoryRequiredBanner,
  telemetryActiveBanner,
  telemetrySentNotice,
  telemetryFailedNotice,
} = require("./lib/banner.js");
const credstore = require("./credstore.js");
const telemetryStore = require("./lib/telemetry-store");

// Refresh the stored license and create the sign-in result sentinel before
// reporting startup state. Keep stdout for the single onGate JSON response.
async function prepareSession() {
  // Materialize the one-time historical-backfill offer before sign-in state is
  // evaluated. Existing and new users receive the same lifecycle.
  initializeBackfillLifecycle();
  const deviceId = credstore.getDeviceId();
  credstore.ensureSigninResultFile();
  if (!deviceId) return;
  // A new session gets one fresh attempt even if the daemon gave up last time
  // (ADR 001, decision 2: SessionStart clears the terminal state). Done before
  // the global gate so a session that starts paused and is re-enabled later
  // does not inherit a stale terminal state.
  clearTerminal({ source: "session_start" });
  if (telemetryStore.getGlobalDisabled()) return;
  try { await refreshLicense(deviceId, { source: "session_start" }); } catch {}
}

function runSessionStartHook() {
  return runHook("SessionStart", (input, ctx) => {
    // Collect configuration names/counts, permission rules and bounded custom
    // skill bodies. runHook sanitizes the block before queueing.
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
      } else if (gate.mode === "repository_consent_required") {
        const repository = repoScopeDecision.repoName
          ? `@${repoScopeDecision.remoteOrg}/${repoScopeDecision.repoName}`
          : "";
        lines.push(telemetryRepositoryRequiredBanner(
          repoScopeDecision.remoteOrg,
          repository
        ));
      } else if (gate.capture && repoScopeDecision.allowed) {
        // Telemetry actually captures only when the repo is in scope too (the
        // hard repo-scope block downstream); show "active" only then.
        lines.push(telemetryActiveBanner(repoScopeDecision.remoteOrg));
      }
      if (lines.length) out.systemMessage = lines.join("\n");
      process.stdout.write(JSON.stringify(out) + "\n");

      // Organization-authorized audit and repository queues can be drained
      // independently of the repository this new session starts in.
      if (
        credstore.hasValidLicense() &&
        credstore.isTelemetryTransmissionAllowed("")
      ) {
        retryFailedLogs();
        retryFailedTranscripts();
        cleanupStaleFiles();
      }

      // stderr notices + SessionStart-only side effects (wording unchanged).
      if (gate.mode === "project_disabled") {
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (telemetry disabled for this project)\n`);
        return;
      }
      if (gate.mode === "repository_consent_required") {
        process.stderr.write(
          `SkillMeter v${PLUGIN_VERSION} (repository telemetry choice required)\n`
        );
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
        process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (activated)\n`);
        return;
      }
      // Not signed in, out of scope, or globally paused.
      process.stderr.write(
        `SkillMeter v${PLUGIN_VERSION} (telemetry not configured for this project)\n` +
        `  /skillmeter:signin                — sign in with GitHub\n` +
        `  /skillmeter:telemetry list        — review repository targets\n`
      );
    },
    afterLog: initializeTranscriptCursor,
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

#!/usr/bin/env node
const { runHook } = require("./logger.js");
const {
  spawnDetachedDrain,
  cleanupStaleFiles,
  initializeTranscriptCursor,
} = require("./lib/transfer");
const { LICENSE_STATUS_FILE, clearTerminal } = require("./lib/license-status");
const { STATES, readCollectionState } = require("./lib/collection-state");
const { startSessionState } = require("./lib/collection-notice");
const { detectHarness } = require("./harness.js");
const { PLUGIN_ROOT, PLUGIN_VERSION } = require("./lib/paths");
const { initializeBackfillLifecycle } = require("./lib/backfill-state");
const {
  BACKFILL_RESULT_FILE,
  ensureBackfillResultFile,
  settleBackfillDelivery,
  takeBackfillNotice,
} = require("./lib/backfill-delivery");
const { getLicenseAudiences } = require("./lib/jwt");
const {
  signInRequiredBanner,
  sessionEndedBanner,
  pausedBanner,
  telemetryConsentRequiredBanner,
  telemetryRepositoryRequiredBanner,
  telemetryActiveBanner,
  telemetrySentNotice,
  telemetryFailedNotice,
} = require("./lib/banner.js");
const credstore = require("./credstore.js");
const telemetryStore = require("./lib/telemetry-store");

// Create the sign-in result sentinel and re-arm refresh before reporting
// startup state. Keep stdout for the single onGate JSON response.
async function prepareSession() {
  // Materialize the one-time historical-backfill offer before sign-in state is
  // evaluated. Existing and new users receive the same lifecycle. A backfill
  // problem must not skip the session setup below.
  try { initializeBackfillLifecycle(); } catch {}
  const deviceId = credstore.getDeviceId();
  credstore.ensureSigninResultFile();
  ensureBackfillResultFile();
  // Catches an import whose last drain finished before the snapshot was
  // marked done, or whose settle was interrupted.
  try { settleBackfillDelivery(); } catch {}
  if (!deviceId) return;
  // A new session gets one fresh attempt even after a refresh ended in a
  // sign-in-required state: SessionStart clears the terminal state. Done
  // before the global gate so a session that starts paused and is re-enabled
  // later does not inherit a stale terminal state.
  clearTerminal({ source: "session_start" });
}

// The card for the collection state (ADR 003, decision 4), or "" when the state
// needs none. SessionStart's terminal clear has already run; the state reads
// the reason that clear keeps.
function stateBanner({ state, reason }, repoScopeDecision) {
  const org = repoScopeDecision.remoteOrg;
  switch (state) {
    case STATES.PAUSED:
      return pausedBanner();
    case STATES.SIGNED_OUT:
    case STATES.NEVER_SIGNED_IN:
    case STATES.TOKEN_MISSING:
    case STATES.REVOKED:
      return signInRequiredBanner(state);
    case STATES.DELIVERY_PAUSED:
      return sessionEndedBanner();
    case STATES.RECORDING:
      return telemetryActiveBanner(org);
    case STATES.UNCONFIGURED:
      // Only a pending choice has a card. Telemetry the user turned off, a
      // repository outside the license and no working directory stay quiet.
      if (reason === "org_consent_required") return telemetryConsentRequiredBanner(org);
      if (reason === "repository_consent_required") {
        const repository = repoScopeDecision.repoName ? `@${org}/${repoScopeDecision.repoName}` : "";
        return telemetryRepositoryRequiredBanner(org, repository);
      }
      return "";
    default:
      return "";
  }
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
    onGate: ({ gate, repoScopeDecision, input }) => {
      // The state this session starts in, so a FileChanged notice announces
      // only what changes after the card below.
      try { startSessionState(input.session_id); } catch {}
      // Single SessionStart stdout JSON. Always register the sign-in sentinel so
      // the FileChanged notifier can report sign-in success/failure without the
      // user re-running /skillmeter:signin, and the session and its status
      // record for the collection notices. Attach exactly one banner when
      // relevant (not-signed-in vs telemetry-active are mutually exclusive).
      const out = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          watchPaths: [credstore.SIGNIN_RESULT_FILE, BACKFILL_RESULT_FILE, credstore.SESSION_FILE, LICENSE_STATUS_FILE],
        },
      };
      // One banner (not-signed-in vs telemetry-active are mutually exclusive),
      // optionally preceded by a one-line notice from the last drain (which ran
      // detached and couldn't print itself): success with counts, or failure
      // with the error. Shown once, then marked notified so it doesn't repeat.
      const lines = [];
      // An import that finished while no session was open is announced here.
      try {
        const backfillNotice = takeBackfillNotice({
          audiences: getLicenseAudiences(credstore.getLicenseToken()),
        });
        if (backfillNotice) lines.push(backfillNotice.message);
      } catch {}
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
      const banner = stateBanner(readCollectionState({ gate }), repoScopeDecision);
      if (banner) lines.push(banner);
      if (lines.length) out.systemMessage = lines.join("\n");
      process.stdout.write(JSON.stringify(out) + "\n");

      // Organization-authorized audit and repository queues can be drained
      // independently of the repository this new session starts in. The drain
      // runs detached, refreshes the license itself if needed, and so never
      // holds session start on the network.
      if (
        credstore.isSignedIn() &&
        credstore.isTelemetryTransmissionAllowed("")
      ) {
        spawnDetachedDrain();
      }
      // Local-only; runs even without a usable license so unsent data still
      // ages out for a device that can no longer sign in.
      try { cleanupStaleFiles(); } catch {}

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
        `  /skillmeter:signin                — sign in\n` +
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

#!/usr/bin/env node
const {
  runHook,
  recoverStaleActiveLog,
  spawnDetachedDrain,
  spawnRetryDaemon,
  cleanupStaleFiles,
  purgeEventLogs,
  eventQueueEmpty,
  writeTelemetryConsentFallback,
  PLUGIN_ROOT,
  PLUGIN_VERSION,
} = require("./logger.js");
const credstore = require("./credstore");
const licenseActivation = require("./lib/license-activation");
const { detectHarness } = require("./harness.js");

// Retry incomplete legacy cleanup before capture or delivery becomes possible.
// Renewal is not done here; the drains renew before they send.
function prepareSession() {
  try { return credstore.completeEventCutover(purgeEventLogs, eventQueueEmpty); }
  catch { return false; }
}

const CUTOVER_HOLD = "SkillMeter upgrade is on hold: event queue cutover is incomplete. Close older Codex sessions and retry. If this persists, preserve the queue and contact support before resetting or signing out.";

// A missing license, or one whose session the sign-in service ended.
function signInRequired() {
  if (!credstore.isSignedIn()) return true;
  return licenseActivation.readStatus().terminal !== null;
}

function buildSessionStartEvent(input, ctx) {
  return {
    source: input.source,
    // Collect configuration names/counts and bounded custom skill bodies.
    // runHook sanitizes this block with the rest of the event.
    harness: detectHarness(ctx.cwd, {
      hashSalt: ctx.hashSalt,
      pluginRoot: PLUGIN_ROOT,
      pluginVersion: PLUGIN_VERSION,
      agentType: input.agent_type,
      agentVersion: input.version || process.env.CODEX_VERSION || "",
      model: input.model,
      sessionSource: input.source,
    }),
  };
}

// Report the capture decision already resolved by runHook.
function onGate({ gate, cwd }) {
  if (!credstore.isEventCutoverComplete()) {
    process.stderr.write(CUTOVER_HOLD + "\n");
    return;
  }
  if (signInRequired()) {
    process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (sign-in required; run $skillmeter:signin)\n`);
    process.stdout.write("SkillMeter is not signed in, so nothing is being recorded. Ask the user to run $skillmeter:signin.\n");
    cleanupStaleFiles();
    return;
  }
  if (gate.capture) {
    process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (activated)\n`);
    // Recover prior queues before appending this SessionStart event.
    // Detached workers handle uploads and retries.
    recoverStaleActiveLog();
    spawnDetachedDrain();
    spawnRetryDaemon();
    cleanupStaleFiles();
    return;
  }
  if (gate.mode === "opted_out") {
    process.stderr.write(
      `SkillMeter v${PLUGIN_VERSION} (telemetry disabled for this project)\n`
    );
    return;
  }
  if (gate.mode === "out_of_scope") {
    process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (repository out of scope)\n`);
    return;
  }
  // An eligible repository still requires an explicit choice.
  process.stderr.write(
    `SkillMeter v${PLUGIN_VERSION} (telemetry not configured for this project)\n`
  );
  writeTelemetryConsentFallback(cwd);
}

function runSessionStartHook() {
  return runHook("SessionStart", buildSessionStartEvent, { onGate });
}

function main() {
  prepareSession();
  return runSessionStartHook().catch(() => process.exit(1));
}

if (require.main === module) {
  main();
}

module.exports = { CUTOVER_HOLD, prepareSession, buildSessionStartEvent, onGate, main };

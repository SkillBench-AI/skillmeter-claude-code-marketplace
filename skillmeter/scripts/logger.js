#!/usr/bin/env node
/**
 * Hook orchestrator + narrow entrypoint façade.
 *
 * The bulk of the plugin runtime is split into focused modules under
 * `lib/`: sanitisation, JWT handling, project settings, repo-scope
 * decisions, and the upload/retry/cleanup transport layer. This file
 * keeps only:
 *
 *   - the `runHook` lifecycle that every hook script drives,
 *   - the structured-log sink.
 *
 * If you're adding new transfer / sanitisation / JWT logic, put it in
 * the relevant `lib/` module — don't grow this file back into a junk
 * drawer.
 */

const fs = require("fs");
const path = require("path");

// Only what runHook + the log sink need. Utilities that used to be re-exported
// through logger (transfer seal/drain, settings writers, repo-scope filters,
// license refresh) are imported directly from their owning lib modules by the
// few consumers that need them — logger is no longer a façade.
const credstore = require("./credstore");
const { getDeviceId, getOrCreateHashSalt } = credstore;
const { hashHmac, sanitizeEventData } = require("./lib/sanitize");
const { atomicWriteJson, readStdinJson, safeReadJson } = require("./lib/io");
const telemetryStore = require("./lib/telemetry-store");
const { repositoryQueuePaths } = require("./lib/paths");
const { getRepoScopeDecision } = require("./lib/repo-scope");
const { resolveTelemetryGate } = require("./lib/telemetry-policy");

// ---------------------------------------------------------------------------
// Structured event log — the per-event NDJSON written to events.jsonl. The
// transport layer in lib/transfer.js handles uploading; this is just the sink.
// ---------------------------------------------------------------------------

function getTranscriptId(transcriptPath) {
  if (!transcriptPath) return "";
  return path.basename(transcriptPath);
}

function logEvent(event, sessionId, data, deviceId, repoKey, hashSalt) {
  if (!deviceId || !repoKey || !hashSalt) return false;
  if (!credstore.isTelemetryTransmissionAllowed(repoKey)) return false;

  const queue = repositoryQueuePaths(repoKey, hashSalt);
  const logFile = queue.eventLog;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const existing = safeReadJson(queue.metadata, null);
    if (existing && existing.repoKey !== repoKey) return false;
    if (!existing) {
      atomicWriteJson(queue.metadata, {
        repoKey,
        org: repoKey.split("/")[1],
        policyRevision: telemetryStore.getPolicyRevision(),
        createdAt: Date.now(),
      });
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      hook_event_name: event,
      session_id: sessionId,
      device_id: deviceId,
      data,
    };

    fs.appendFileSync(logFile, JSON.stringify(logEntry) + "\n");
    return true;
  } catch (err) {
    console.error(`[skillmeter] ${event}: log write failed (${err.message})`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook I/O
// ---------------------------------------------------------------------------

// TTY (no piped input) and empty stdin both resolve to null — the hook runner
// treats a null input as "nothing to do".
const readStdin = () => readStdinJson({ tty: null, empty: null });

// ---------------------------------------------------------------------------
// Hook lifecycle — called by every script under scripts/*.js
// ---------------------------------------------------------------------------

// Default stderr messaging for the resolved gate, used by every hook that
// doesn't supply an onGate reactor.
function defaultGateMessaging(eventName, gate) {
  if (!gate.capture) {
    const reasons = {
      global_disabled: "telemetry globally disabled",
      not_signed_in: "not signed in",
      out_of_scope: "repository outside the licensed org",
      org_consent_required: "organization telemetry choice required",
      org_disabled: "telemetry disabled for this organization",
      project_disabled: "telemetry disabled for this project",
    };
    const reason = reasons[gate.mode] || "telemetry not enabled";
    console.error(`[skillmeter] ${eventName}: skipped (${reason})`);
  }
}

async function runOptionalCallback(
  eventName,
  phase,
  callback,
  input,
  deviceId,
  repository
) {
  if (!callback) return;
  try {
    await callback(input, deviceId, repository);
  } catch (err) {
    console.error(`[skillmeter] ${eventName}: ${phase} failed (${err.message})`);
  }
}

/**
 * Common hook runner — handles all boilerplate shared by every hook script.
 *
 * @param {string} eventName - Hook event name (e.g. "SessionStart")
 * @param {function} buildData - (input, ctx) => object with event-specific fields.
 *   ctx provides { cwd, getTranscriptId }. Returned fields are raw;
 *   runHook scrubs them centrally via sanitizeEventData.
 * @param {object} [options]
 * @param {function} [options.onGate] - Gate reactor: ({ gate, repoScopeDecision, cwd, input, eventName }) => void.
 *   Runs after the gate is resolved (for banners/side-effects). The capture decision stays central —
 *   runHook exits when gate.capture is false regardless. Without it, default stderr messaging is used.
 * @param {function} [options.afterSkip] - Called before exit when the event is skipped after stdin is read.
 * @param {function} [options.afterLog] - Called after the event is logged.
 */
async function runHook(eventName, buildData, options = {}) {
  const deviceId = getDeviceId();
  if (!deviceId) {
    console.error(`[skillmeter] ${eventName}: skipped (no device ID)`);
    process.exit(0);
  }

  const input = await readStdin();
  if (!input) {
    console.error(`[skillmeter] ${eventName}: skipped (no stdin input)`);
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();

  // Resolve repo ownership and the parent org consent before considering the
  // per-project override. Project `true` can never bypass missing org consent.
  const repoScopeDecision = getRepoScopeDecision(cwd);
  const orgConsent = repoScopeDecision.remoteOrg
    ? credstore.getOrgTelemetryConsent(repoScopeDecision.remoteOrg)
    : null;
  const settingsRoot = repoScopeDecision.repoRoot || cwd;
  const gate = resolveTelemetryGate({
    globalDisabled: credstore.getTelemetryDisabled(),
    hasValidLicense: credstore.hasValidLicense(),
    repoOrgOwned: repoScopeDecision.allowed,
    orgConsent,
    projectOptIn: repoScopeDecision.repoKey
      ? telemetryStore.getRepositoryOverride(
          repoScopeDecision.repoKey,
          settingsRoot
        )
      : null,
  });
  if (options.onGate) {
    options.onGate({ gate, repoScopeDecision, orgConsent, cwd, input, eventName });
  } else {
    defaultGateMessaging(eventName, gate);
  }
  if (!gate.capture) {
    await runOptionalCallback(
      eventName,
      "afterSkip",
      options.afterSkip,
      input,
      deviceId,
      {
        repoKey: repoScopeDecision.repoKey,
        org: repoScopeDecision.remoteOrg,
        gate,
      }
    );
    process.exit(0);
  }

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();
  if (!hashSalt) {
    console.error(`[skillmeter] ${eventName}: skipped (no hash salt)`);
    process.exit(0);
  }

  const ctx = { cwd, getTranscriptId };
  const eventData = buildData ? buildData(input, ctx) : {};

  // Central sanitization catch-all: every hook's payload (prompt,
  // last_assistant_message, notification message, tool fields, etc.) passes
  // through the single secret/PII + path-hashing boundary here, so no hook can
  // ship raw content and future hooks are covered automatically. `meta` carries
  // the redaction tally + policy version for downstream visibility.
  const { value: scrubbedEventData, meta } = sanitizeEventData(eventData, hashSalt);

  const data = {
    // Event data first so the authoritative fixed fields below always win a
    // key collision (a hook returning e.g. `cwd` can't clobber the hashed one).
    ...scrubbedEventData,
    // Per-prompt correlation id (Claude Code v2.1.196+): groups every hook event
    // a single user prompt produced into one turn. A random UUID (not PII), so no
    // sanitization needed; undefined on older runtimes → omitted from the JSON.
    prompt_id: input.prompt_id,
    // Reasoning-effort level of the turn (common field `effort.level`:
    // low|medium|high|xhigh|max). An enum, not PII; omitted when absent.
    effort_level: input.effort && input.effort.level,
    // Subagent context (common fields): present on ANY event that fires inside a
    // subagent, so capture centrally to distinguish main-thread from subagent
    // activity on every event. Ids/type names, not PII; omitted on the main thread.
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    transcript_path: getTranscriptId(input.transcript_path),
    cwd: hashHmac(cwd, hashSalt),
    repo_scope: repoScopeDecision.scope,
    repo_classification: repoScopeDecision.classification,
    repo_root: repoScopeDecision.repoRoot
      ? hashHmac(repoScopeDecision.repoRoot, hashSalt)
      : undefined,
    repo_remote_org: repoScopeDecision.remoteOrg
      ? hashHmac(repoScopeDecision.remoteOrg, hashSalt)
      : undefined,
    permission_mode: input.permission_mode,
  };
  if (meta.secrets > 0 || meta.pii > 0) data._sanitization = meta;

  const logged = logEvent(
    eventName,
    sessionId,
    data,
    deviceId,
    repoScopeDecision.repoKey,
    hashSalt
  );
  if (!logged) {
    console.error(`[skillmeter] ${eventName}: skipped (policy changed before write)`);
    process.exit(0);
  }
  console.error(`[skillmeter] ${eventName}: logged (session=${sessionId.slice(0, 8)}…)`);

  await runOptionalCallback(
    eventName,
    "afterLog",
    options.afterLog,
    input,
    deviceId,
    { repoKey: repoScopeDecision.repoKey, org: repoScopeDecision.remoteOrg }
  );
}

// ---------------------------------------------------------------------------
// Public API for hook entrypoints and simple CLI wrappers.
// ---------------------------------------------------------------------------

// logger's only public responsibility is the hook lifecycle. Everything else
// (log sink, gate policy, messaging) is internal; utilities live in lib/*.
module.exports = { runHook };

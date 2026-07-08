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
 *   - the structured-log sink (`logInfo`, `logStructured`),
 *   - a small set of helpers used by hook entrypoints and CLI commands.
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
const { LOG_DIR, LOG_FILE } = require("./lib/paths");
const { hashHmac, sanitizeToolData } = require("./lib/sanitize");
const { getTelemetryOptIn } = require("./lib/settings");
const { getRepoScopeDecision } = require("./lib/repo-scope");

// ---------------------------------------------------------------------------
// Structured event log — the per-event NDJSON written to events.jsonl. The
// transport layer in lib/transfer.js handles uploading; this is just the sink.
// ---------------------------------------------------------------------------

function getTimestamp() {
  return new Date().toISOString();
}

function getTranscriptId(transcriptPath) {
  if (!transcriptPath) return "";
  return path.basename(transcriptPath);
}

function logStructured(level, event, sessionId, data, deviceId) {
  if (!deviceId) return;

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const logEntry = {
    timestamp: getTimestamp(),
    level,
    hook_event_name: event,
    session_id: sessionId,
    device_id: deviceId,
    data,
  };

  fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + "\n");
}

const logInfo = (event, sessionId, data, deviceId) =>
  logStructured("info", event, sessionId, data, deviceId);

// ---------------------------------------------------------------------------
// Hook I/O
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Hook lifecycle — called by every script under scripts/*.js
// ---------------------------------------------------------------------------

/**
 * Resolve the per-project telemetry gate, combining the explicit opt-in
 * setting with org-ownership auto-enable.
 *
 *   - explicit `false` → off  (user opted out; always respected)
 *   - explicit `true`  → on   (subject to the repo-scope gate downstream)
 *   - unset (`null`)   → on **only when the repo is owned by an allowed org**
 *                        ("auto_org"); otherwise off
 *
 * Pure function — no I/O — so the policy can be reasoned about and tested
 * directly (the codebase has no runner; see AGENTS.md).
 *
 * @param {boolean|null} optIn - getTelemetryOptIn(cwd) result
 * @param {boolean} repoOrgOwned - repoScopeDecision.allowed
 * @returns {{capture: boolean, mode: "opted_out"|"opted_in"|"auto_org"|"not_enabled"}}
 */
function resolveTelemetryGate(optIn, repoOrgOwned) {
  if (optIn === false) return { capture: false, mode: "opted_out" };
  if (optIn === true) return { capture: true, mode: "opted_in" };
  if (repoOrgOwned === true) return { capture: true, mode: "auto_org" };
  return { capture: false, mode: "not_enabled" };
}

// Default stderr messaging for the resolved gate, used by every hook that
// doesn't supply an onGate reactor. Kept byte-identical to the historical
// inline branch so hook diagnostics don't drift.
function defaultGateMessaging(eventName, gate) {
  if (!gate.capture) {
    const reason =
      gate.mode === "opted_out"
        ? "telemetry disabled for this project"
        : "telemetry not enabled";
    console.error(`[skillmeter] ${eventName}: skipped (${reason})`);
    return;
  }
  if (gate.mode === "auto_org") {
    console.error(
      `[skillmeter] ${eventName}: telemetry auto-enabled (repo owned by allowed org; run /skillmeter:telemetry disable to opt out)`
    );
  }
}

/**
 * Common hook runner — handles all boilerplate shared by every hook script.
 *
 * @param {string} eventName - Hook event name (e.g. "SessionStart")
 * @param {function} buildData - (input, ctx) => object with event-specific fields.
 *   ctx provides { hashSalt, cwd, sanitizeToolData, getTranscriptId }.
 * @param {object} [options]
 * @param {function} [options.beforeStdin] - Called after deviceId check, before stdin read (e.g. retryFailedLogs)
 * @param {function} [options.onGate] - Gate reactor: ({ gate, repoScopeDecision, cwd, input, eventName }) => void.
 *   Runs after the gate is resolved (for banners/side-effects). The capture decision stays central —
 *   runHook exits when gate.capture is false regardless. Without it, default stderr messaging is used.
 * @param {function} [options.afterSkip] - Called before exit when the event is skipped after stdin is read.
 * @param {function} [options.afterLog] - Called after logInfo for hook-local follow-up work.
 * @param {boolean} [options.awaitAfterSkip=false] - Await afterSkip when it returns a Promise.
 * @param {boolean} [options.awaitAfterLog=false] - Await afterLog when it returns a Promise.
 */
async function runHook(eventName, buildData, options = {}) {
  const deviceId = getDeviceId();
  if (!deviceId) {
    console.error(`[skillmeter] ${eventName}: skipped (no device ID)`);
    process.exit(0);
  }

  if (options.beforeStdin) options.beforeStdin(deviceId);

  const input = await readStdin();
  if (!input) {
    console.error(`[skillmeter] ${eventName}: skipped (no stdin input)`);
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();

  if (credstore.getTelemetryDisabled()) {
    console.error(`[skillmeter] ${eventName}: skipped (telemetry globally disabled)`);
    process.exit(0);
  }

  // Resolve repo ownership up front: it both gates capture (below) and, for
  // projects with no explicit opt-in, decides whether telemetry auto-enables.
  const repoScopeDecision = getRepoScopeDecision(cwd);

  // Single gate: compute once, then let the caller REACT (banners/side-effects)
  // via onGate — the capture decision stays central. Hooks without an onGate get
  // the default stderr messaging. (Replaces the former checkOptIn override +
  // duplicated policy in session_start.js.)
  const gate = resolveTelemetryGate(getTelemetryOptIn(cwd), repoScopeDecision.allowed);
  if (options.onGate) {
    options.onGate({ gate, repoScopeDecision, cwd, input, eventName });
  } else {
    defaultGateMessaging(eventName, gate);
  }
  if (!gate.capture) process.exit(0);

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();
  if (!hashSalt) {
    console.error(`[skillmeter] ${eventName}: skipped (no hash salt)`);
    process.exit(0);
  }

  if (!repoScopeDecision.allowed) {
    console.error(
      `[skillmeter] ${eventName}: skipped (${repoScopeDecision.classification})`
    );
    if (options.afterSkip) {
      try {
        const result = options.afterSkip(input, deviceId);
        if (options.awaitAfterSkip && result && typeof result.then === "function") {
          await result;
        } else if (result && typeof result.catch === "function") {
          result.catch((err) => {
            console.error(`[skillmeter] ${eventName}: afterSkip failed (${err.message})`);
          });
        }
      } catch (err) {
        console.error(`[skillmeter] ${eventName}: afterSkip failed (${err.message})`);
      }
    }
    process.exit(0);
  }

  const ctx = { hashSalt, cwd, sanitizeToolData, getTranscriptId };
  const eventData = buildData ? buildData(input, ctx) : {};

  const data = {
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
    ...eventData,
  };

  logInfo(eventName, sessionId, data, deviceId);
  console.error(`[skillmeter] ${eventName}: logged (session=${sessionId.slice(0, 8)}…)`);

  if (options.afterLog) {
    try {
      const result = options.afterLog(input, deviceId);
      if (options.awaitAfterLog && result && typeof result.then === "function") {
        await result;
      } else if (result && typeof result.catch === "function") {
        result.catch((err) => {
          console.error(`[skillmeter] ${eventName}: afterLog failed (${err.message})`);
        });
      }
    } catch (err) {
      console.error(`[skillmeter] ${eventName}: afterLog failed (${err.message})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API for hook entrypoints and simple CLI wrappers.
// ---------------------------------------------------------------------------

// logger's only public responsibility is the hook lifecycle. Everything else
// (log sink, gate policy, messaging) is internal; utilities live in lib/*.
module.exports = { runHook };

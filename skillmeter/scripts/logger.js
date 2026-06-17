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

const credstore = require("./credstore");
const { getDeviceId, getOrCreateHashSalt, getLicenseToken } = credstore;
const { trySilentGhActivate, refreshExpiredJwt } = require("./lib/license-activation");

const paths = require("./lib/paths");
const { LOG_DIR, LOG_FILE, PLUGIN_VERSION } = paths;

const sanitize = require("./lib/sanitize");
const { hashHmac, sanitizeToolData } = sanitize;

const settings = require("./lib/settings");
const {
  getTelemetryOptIn,
  saveTelemetryOptIn,
} = settings;

const repoScope = require("./lib/repo-scope");
const { getRepoScopeDecision } = repoScope;

const transfer = require("./lib/transfer");
const {
  sealEventLogAndTriggerDrain,
  sealFinalSessionArtifacts,
  sealFinalSessionArtifactsAndDrain,
  sealEventLogAndDrain,
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
} = transfer;

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
// License refresh — try the Lambda's /refresh endpoint first (no GitHub
// round-trip, works for users without gh-cli), fall back to the silent gh
// /activate path on 410 / 404 / network failure.
//
// The /refresh path keeps refresh latency low and decouples us from GitHub
// availability + rate limits. /activate stays as the safety net for users
// whose sliding-refresh-window has elapsed (or whose Lambda environment
// hasn't deployed /refresh yet).
// ---------------------------------------------------------------------------

async function tryRefreshLicense(deviceId) {
  const current = getLicenseToken();
  if (current && !credstore.isLicenseTokenExpired(current)) {
    return current;
  }
  if (!deviceId) return null;
  if (credstore.getSignedOut()) return null;

  // Try /refresh first when we have a token to rotate. refreshExpiredJwt
  // returns null on 410 (sliding window), 404 (endpoint not deployed),
  // 401 (bad signature), or any network/parse error — falling through to
  // the gh fallback in every case.
  if (current) {
    const fresh = await refreshExpiredJwt(current, deviceId);
    if (fresh) return fresh;
  }

  try {
    return await trySilentGhActivate(deviceId);
  } catch {
    return null;
  }
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

/**
 * Common hook runner — handles all boilerplate shared by every hook script.
 *
 * @param {string} eventName - Hook event name (e.g. "SessionStart")
 * @param {function} buildData - (input, ctx) => object with event-specific fields.
 *   ctx provides { hashSalt, cwd, sanitizeToolData, getTranscriptId }.
 * @param {object} [options]
 * @param {function} [options.beforeStdin] - Called after deviceId check, before stdin read (e.g. retryFailedLogs)
 * @param {function} [options.checkOptIn] - Custom opt-in logic: (cwd, input) => boolean. Return false to exit.
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

  if (options.checkOptIn) {
    if (!options.checkOptIn(cwd, input)) process.exit(0);
  } else {
    const gate = resolveTelemetryGate(getTelemetryOptIn(cwd), repoScopeDecision.allowed);
    if (!gate.capture) {
      const reason =
        gate.mode === "opted_out"
          ? "telemetry disabled for this project"
          : "telemetry not enabled";
      console.error(`[skillmeter] ${eventName}: skipped (${reason})`);
      process.exit(0);
    }
    if (gate.mode === "auto_org") {
      console.error(
        `[skillmeter] ${eventName}: telemetry auto-enabled (repo owned by allowed org; run /skillmeter:telemetry disable to opt out)`
      );
    }
  }

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

module.exports = {
  // Core
  runHook,
  resolveTelemetryGate,
  readStdin,
  getTimestamp,
  logStructured,
  logInfo,
  getTranscriptId,

  // Credstore wrappers
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,

  // Paths / metadata
  PLUGIN_VERSION,
  LOG_DIR,
  LOG_FILE,

  // License refresh
  tryRefreshLicense,

  // Re-exports from lib/sanitize
  hashHmac,
  sanitizeToolData,

  // Re-exports from lib/settings
  getTelemetryOptIn,
  saveTelemetryOptIn,

  // Re-exports from lib/repo-scope
  getRepoScopeDecision,

  // Re-exports from lib/transfer
  sealEventLogAndTriggerDrain,
  sealFinalSessionArtifacts,
  sealFinalSessionArtifactsAndDrain,
  sealEventLogAndDrain,
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
};

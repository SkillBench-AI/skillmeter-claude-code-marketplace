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

const paths = require("./lib/paths");
const { LOG_DIR, LOG_FILE, PLUGIN_VERSION } = paths;

const sanitize = require("./lib/sanitize");
const { hashHmac, sanitizeToolData } = sanitize;

const settings = require("./lib/settings");
const {
  getTelemetryOptIn,
  saveTelemetryOptIn,
  getRepoScopeSettings,
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
// License refresh — best-effort gh-fallback call for hooks whose license
// JWT is missing or within the expiry skew.
// ---------------------------------------------------------------------------

async function tryRefreshLicense(deviceId) {
  const current = getLicenseToken();
  if (current && !credstore.isLicenseTokenExpired(current)) {
    return current;
  }
  if (!deviceId) return null;
  try {
    return await credstore.trySilentGhActivate(deviceId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook lifecycle — called by every script under scripts/*.js
// ---------------------------------------------------------------------------

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

  if (options.checkOptIn) {
    if (!options.checkOptIn(cwd, input)) process.exit(0);
  } else if (getTelemetryOptIn(cwd) !== true) {
    console.error(`[skillmeter] ${eventName}: skipped (telemetry not enabled)`);
    process.exit(0);
  }

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();
  if (!hashSalt) {
    console.error(`[skillmeter] ${eventName}: skipped (no hash salt)`);
    process.exit(0);
  }

  const repoScopeDecision = getRepoScopeDecision(cwd);
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
  getRepoScopeSettings,

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

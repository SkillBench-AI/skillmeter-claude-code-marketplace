#!/usr/bin/env node
/**
 * Enhanced structured logging utility for skillmeter hooks
 * Outputs NDJSON (newline-delimited JSON) for easy backend parsing
 */

const crypto = require("crypto");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { sanitizeTranscript } = require("./sanitizer");
const credstore = require("./credstore");

// Configuration
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const LOG_DIR = path.join(PLUGIN_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");
const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
})();

function getDeviceId() {
  return credstore.getDeviceId(LOG_DIR);
}

function getOrCreateHashSalt() {
  return credstore.getOrCreateHashSalt(LOG_DIR);
}

function getLicenseToken() {
  return credstore.getLicenseToken(LOG_DIR);
}

function readSettingsFile(cwd) {
  try {
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    if (!fs.existsSync(settingsPath)) return null;
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

function getRepoScopeSettings(cwd) {
  const skillmeterSettings = readSettingsFile(cwd)?.skillmeter ?? {};
  return {
    enabled: skillmeterSettings.repoScope?.enabled === true,
    allowedGitHubOrgs: Array.isArray(skillmeterSettings.repoScope?.allowedGitHubOrgs)
      ? skillmeterSettings.repoScope.allowedGitHubOrgs
          .map((org) => String(org).trim().toLowerCase())
          .filter(Boolean)
      : [],
    includeUnapprovedRepos:
      skillmeterSettings.repoScope?.includeUnapprovedRepos === true,
  };
}

/**
 * Hash a string using HMAC-SHA256 with salt (first 12 chars)
 * Matches VS Code extension's HashingService.hash()
 * @param {string} str - String to hash
 * @param {string} salt - HMAC salt
 * @returns {string} First 12 characters of HMAC-SHA256 hash
 */
function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

function extractGitHubOrgFromRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return "";

  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/.+?(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1].toLowerCase();

  const httpsMatch = trimmed.match(
    /^(?:ssh:\/\/)?(?:git@)?github\.com[:/]([^/]+)\/.+?(?:\.git)?$/i
  );
  if (httpsMatch) return httpsMatch[1].toLowerCase();

  try {
    const normalized = trimmed.startsWith("http")
      ? trimmed
      : trimmed.replace(/^ssh:\/\//i, "https://");
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== "github.com") return "";
    return (url.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
  } catch {
    return "";
  }
}

function findGitRoot(startPath) {
  if (!startPath || typeof startPath !== "string") return "";

  let currentPath = path.resolve(startPath);
  try {
    if (!fs.statSync(currentPath).isDirectory()) {
      currentPath = path.dirname(currentPath);
    }
  } catch {
    currentPath = path.dirname(currentPath);
  }

  while (true) {
    const gitPath = path.join(currentPath, ".git");
    if (fs.existsSync(gitPath)) return currentPath;

    const parent = path.dirname(currentPath);
    if (parent === currentPath) return "";
    currentPath = parent;
  }
}

function resolveGitDir(repoRoot) {
  if (!repoRoot) return "";

  const gitPath = path.join(repoRoot, ".git");
  try {
    const stats = fs.statSync(gitPath);
    if (stats.isDirectory()) return gitPath;
    if (!stats.isFile()) return "";

    const content = fs.readFileSync(gitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)\s*$/im);
    return match ? path.resolve(repoRoot, match[1]) : "";
  } catch {
    return "";
  }
}

function getRemoteUrlsForRepo(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return [];

  try {
    const configPath = path.join(gitDir, "config");
    const configContent = fs.readFileSync(configPath, "utf8");
    const urls = [];
    let inRemoteSection = false;

    for (const line of configContent.split(/\r?\n/)) {
      if (/^\s*\[remote ".+"\]\s*$/.test(line)) {
        inRemoteSection = true;
        continue;
      }
      if (/^\s*\[.+\]\s*$/.test(line)) {
        inRemoteSection = false;
        continue;
      }
      if (!inRemoteSection) continue;

      const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (urlMatch) urls.push(urlMatch[1]);
    }

    return urls;
  } catch {
    return [];
  }
}

function getRepoScopeDecision(cwd) {
  const repoScope = getRepoScopeSettings(cwd);
  if (!repoScope.enabled) {
    return { allowed: true, scope: "unscoped", classification: "disabled" };
  }

  if (repoScope.allowedGitHubOrgs.length === 0) {
    if (repoScope.includeUnapprovedRepos) {
      return {
        allowed: true,
        scope: "include_unapproved",
        classification: "include_unapproved_repos",
      };
    }
    return {
      allowed: false,
      scope: "unknown",
      classification: "no_allowed_orgs_configured",
    };
  }

  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) {
    return { allowed: false, scope: "unknown", classification: "no_repository" };
  }

  const remoteOrgs = getRemoteUrlsForRepo(repoRoot)
    .map((remoteUrl) => extractGitHubOrgFromRemote(remoteUrl))
    .filter(Boolean);

  if (remoteOrgs.length === 0) {
    return {
      allowed: false,
      scope: "unknown",
      classification: "no_github_remote",
      repoRoot,
    };
  }

  const matchingOrg = remoteOrgs.find((org) =>
    repoScope.allowedGitHubOrgs.includes(org)
  );
  if (matchingOrg) {
    return {
      allowed: true,
      scope: "approved",
      classification: "github_org_match",
      repoRoot,
      remoteOrg: matchingOrg,
    };
  }

  return {
    allowed: repoScope.includeUnapprovedRepos,
    scope: "external",
    classification: repoScope.includeUnapprovedRepos
      ? "github_org_mismatch_opt_in"
      : "github_org_mismatch",
    repoRoot,
    remoteOrg: remoteOrgs[0],
  };
}

// Keys in tool_input/tool_response whose values contain sensitive paths and should be hashed
const PATH_KEYS = new Set(["file_path", "filePath", "path", "command"]);

/**
 * Sanitize a tool object by hashing path values
 * @param {object} obj - tool_input or tool_response object
 * @param {string} hashSalt - HMAC salt
 * @returns {object} Sanitized object
 */
function sanitizeToolData(obj, hashSalt) {
  if (!obj || typeof obj !== "object") return obj;

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (PATH_KEYS.has(key) && typeof val === "string") {
      result[key] = hashHmac(val, hashSalt);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Get ISO 8601 timestamp with milliseconds
 * @returns {string} Timestamp string
 */
function getTimestamp() {
  return new Date().toISOString();
}

// Transfer configuration
const BACKEND_URL = process.env.SKILLMETER_BACKEND_URL || "https://api.meter.skillbench.com/logs/claude";
const EVENT_TIMEOUT = parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
const TRANSCRIPT_TIMEOUT = 30_000;

/**
 * Upload an event log file to the backend via fetch + gzip
 * Returns a Promise that resolves after the fetch completes.
 * On success (2xx), renames the file to .sent
 * @param {string} logFile - Path to the log file
 * @returns {Promise<void>}
 */
function transferEventLog(logFile) {
  if (!logFile || !fs.existsSync(logFile)) return Promise.resolve();

  const fileContent = fs.readFileSync(logFile);
  const compressed = zlib.gzipSync(fileContent);
  const token = getLicenseToken();

  const headers = {
    "Content-Type": "application/x-ndjson",
    "Content-Encoding": "gzip",
    "X-Plugin-Version": PLUGIN_VERSION,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  console.error(`[skillmeter] Transferring event log: ${path.basename(logFile)} (${compressed.length} bytes gzipped)`);

  return fetch(BACKEND_URL, {
    method: "POST",
    headers,
    body: compressed,
    signal: AbortSignal.timeout(EVENT_TIMEOUT),
  }).then((res) => {
    if (res.ok) {
      console.error(`[skillmeter] Event log transferred: ${path.basename(logFile)}`);
      try { fs.renameSync(logFile, `${logFile}.sent`); } catch {}
    } else {
      console.error(`[skillmeter] Event log transfer failed: HTTP ${res.status}`);
    }
  }).catch((err) => {
    console.error(`[skillmeter] Event log transfer error: ${err.message}`);
  });
}

/**
 * Upload a transcript file to the backend via fetch + gzip
 * Fire-and-forget — caller should not await.
 * @param {string} transcriptPath - Path to the JSONL transcript file
 * @param {string} deviceId - Device UUID
 */
function transferTranscript(transcriptPath, deviceId) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const hashSalt = getOrCreateHashSalt();
  const fileContent = hashSalt
    ? sanitizeTranscript(transcriptPath, hashSalt)
    : fs.readFileSync(transcriptPath);
  const compressed = zlib.gzipSync(fileContent);
  const transcriptId = path.basename(transcriptPath);
  const token = getLicenseToken();

  const headers = {
    "Content-Type": "application/x-ndjson",
    "Content-Encoding": "gzip",
    "X-Device-ID": deviceId,
    "X-Transcript-ID": transcriptId,
    "X-Plugin-Version": PLUGIN_VERSION,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  console.error(`[skillmeter] Transferring transcript: ${transcriptId} (${compressed.length} bytes gzipped)`);

  fetch(`${BACKEND_URL}/transcript`, {
    method: "POST",
    headers,
    body: compressed,
    signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT),
  }).then((res) => {
    if (res.ok) {
      console.error(`[skillmeter] Transcript transferred: ${transcriptId}`);
    } else {
      console.error(`[skillmeter] Transcript transfer failed: HTTP ${res.status}`);
    }
  }).catch((err) => {
    console.error(`[skillmeter] Transcript transfer error: ${err.message}`);
  });
}

/**
 * Rotate the current event log and transfer the shared event batch.
 * Returns a Promise that resolves after the transfer completes.
 * @returns {Promise<void>}
 */
function flushEventLog() {
  if (fs.existsSync(LOG_FILE)) {
    try {
      const sendingFile = `${LOG_FILE}.${Date.now()}`;
      fs.renameSync(LOG_FILE, sendingFile);
      console.error(`[skillmeter] Rotated event log: ${path.basename(sendingFile)}`);
      return transferEventLog(sendingFile);
    } catch (err) {
      console.error(`[skillmeter] Event log rotation failed: ${err.message}`);
      return Promise.resolve();
    }
  } else {
    console.error(`[skillmeter] No event log to flush`);
    return Promise.resolve();
  }
}

/**
 * Rotate the current event log and transfer both events and transcript.
 * Shared afterLog handler for Stop and SessionEnd hooks.
 * @param {object} input - Hook input (needs transcript_path)
 * @param {string} deviceId - Device UUID
 * @returns {Promise<void>}
 */
function flushAndTransfer(input, deviceId) {
  const eventLogPromise = flushEventLog();

  // Transfer transcript
  if (input.transcript_path && fs.existsSync(input.transcript_path)) {
    transferTranscript(input.transcript_path, deviceId);
  } else {
    console.error(`[skillmeter] No transcript to transfer`);
  }

  return eventLogPromise;
}

/**
 * Retry failed event log transfers
 * Finds files matching events.jsonl.* and calls transferEventLog for each
 */
function retryFailedLogs() {
  if (!fs.existsSync(LOG_DIR)) return;

  try {
    const files = fs.readdirSync(LOG_DIR);
    let retryCount = 0;

    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);

      // Skip directories
      if (!fs.statSync(filePath).isFile()) continue;

      // Match events.jsonl.{timestamp}
      if (/^events\.jsonl\.\d+$/.test(file)) {
        retryCount++;
        transferEventLog(filePath);
      }
    }

    if (retryCount > 0) {
      console.error(`[skillmeter] Retrying ${retryCount} failed log file(s)`);
    }
  } catch {
    // Ignore errors during retry
  }
}

/**
 * Write structured JSON log entry
 * @param {string} level - Log level (info, error, warn, debug)
 * @param {string} event - Hook event name
 * @param {string} sessionId - Session ID
 * @param {object} data - Event data
 * @param {string} deviceId - Device UUID
 */
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

/**
 * Extract the UUID filename from a transcript path
 * e.g. "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl" -> "00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl"
 * @param {string} transcriptPath - Full transcript path
 * @returns {string} UUID filename or empty string
 */
function getTranscriptId(transcriptPath) {
  if (!transcriptPath) return "";
  return path.basename(transcriptPath);
}

// Convenience logging function
const logInfo = (event, sessionId, data, deviceId) => logStructured("info", event, sessionId, data, deviceId);

/**
 * Read JSON from stdin
 * @returns {Promise<object>} Parsed JSON object
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    // Check if stdin is a TTY (interactive terminal)
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

// ============================================================================
// Telemetry Opt-In Management
// ============================================================================

/**
 * Read the telemetry opt-in preference for a given working directory
 * @param {string} cwd - Working directory
 * @returns {boolean|null} true/false if set, null if not yet configured
 */
function getTelemetryOptIn(cwd) {
  try {
    const content = readSettingsFile(cwd);
    if (!content) return null;
    if (!content.skillmeter || typeof content.skillmeter.telemetry !== "boolean") return null;
    return content.skillmeter.telemetry;
  } catch {
    return null;
  }
}

/**
 * Save the telemetry opt-in preference for a given working directory
 * Merges with existing settings file content
 * @param {string} cwd - Working directory
 * @param {boolean} value - Opt-in value
 */
function saveTelemetryOptIn(cwd, value) {
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  let content = {};
  try {
    if (fs.existsSync(settingsPath)) {
      content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch {
    content = {};
  }
  content.skillmeter = { ...content.skillmeter, telemetry: value };
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(content, null, 2) + "\n");
}

/**
 * Prompt the user for telemetry opt-in via a native macOS dialog.
 * Uses osascript to show a system dialog with Yes/No buttons.
 * Falls back to false on non-macOS or if the dialog is dismissed.
 * @param {string} cwd - Working directory
 * @returns {boolean} User's choice
 */
function promptTelemetryOptIn(cwd) {
  try {
    const result = execSync(
      `osascript -e 'display dialog "Enable telemetry for this project?\\n\\nTelemetry helps improve SkillMeter by collecting anonymous usage data." with title "SkillMeter" buttons {"No", "Yes"} default button "Yes"'`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
    );
    const enabled = result.trim().includes("button returned:Yes");
    saveTelemetryOptIn(cwd, enabled);
    return enabled;
  } catch {
    // Dialog dismissed (Cancel/Escape) or osascript unavailable — don't persist,
    // so the prompt re-appears next session.
    return false;
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
 * @param {function} [options.checkOptIn] - Custom opt-in logic: (cwd, input) => boolean. Return false to exit.
 * @param {function} [options.afterSkip] - Called before exit when the event is skipped after stdin is read.
 * @param {function} [options.afterLog] - Called after logInfo (e.g. force transfer)
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
  } else {
    if (getTelemetryOptIn(cwd) !== true) {
      console.error(`[skillmeter] ${eventName}: skipped (telemetry not enabled)`);
      process.exit(0);
    }
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
      const result = options.afterSkip(input, deviceId);
      if (result && typeof result.then === 'function') {
        await result;
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

  if (options.afterLog) options.afterLog(input, deviceId);
}

module.exports = {
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  hashHmac,
  sanitizeToolData,
  getTimestamp,
  logStructured,
  logInfo,
  readStdin,
  getTranscriptId,
  retryFailedLogs,
  transferEventLog,
  transferTranscript,
  flushEventLog,
  flushAndTransfer,
  getTelemetryOptIn,
  saveTelemetryOptIn,
  promptTelemetryOptIn,
  getRepoScopeSettings,
  getRepoScopeDecision,
  runHook,
  PLUGIN_ROOT,
  PLUGIN_VERSION,
  LOG_DIR,
  LOG_FILE,
};
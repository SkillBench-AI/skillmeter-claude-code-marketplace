#!/usr/bin/env node
/**
 * Enhanced structured logging utility for skillmeter hooks
 * Outputs NDJSON (newline-delimited JSON) for easy backend parsing
 */

const { execSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Configuration
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const LOG_DIR = path.join(PLUGIN_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");
const MAX_EVENTS = 50;
const TRANSFER_EVENT_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "transfer_event.js");
const SERVICE_NAME = "com.skillbench.device-id";
const HASH_SALT_SERVICE = "com.skillbench.hash-salt";
const LICENSE_SERVICE = "com.skillbench.license";

/**
 * Get or create device UUID from macOS Keychain
 * @returns {string|null} Device UUID or null if unavailable
 */
function getDeviceId() {
  const account = process.env.USER || process.env.USERNAME || "";
  if (!account) return null;

  try {
    // Try to retrieve existing UUID from Keychain (macOS)
    const result = execSync(
      `security find-generic-password -a "${account}" -s "${SERVICE_NAME}" -w 2>/dev/null`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    if (result.trim()) {
      return result.trim();
    }
  } catch {
    // UUID not found, try to create one
  }

  try {
    // Generate new UUID
    const newUuid = crypto.randomUUID().toUpperCase();
    execSync(
      `security add-generic-password -a "${account}" -s "${SERVICE_NAME}" -w "${newUuid}" 2>/dev/null`,
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    return newUuid;
  } catch {
    // Keychain not available (Windows/Linux), use fallback
    return getFallbackDeviceId(account);
  }
}

/**
 * Fallback device ID storage for non-macOS systems
 * @param {string} account - User account name
 * @returns {string|null} Device UUID or null
 */
function getFallbackDeviceId(account) {
  const idFile = path.join(LOG_DIR, ".device-id");
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(idFile)) {
      return fs.readFileSync(idFile, "utf8").trim();
    }
    const newUuid = crypto.randomUUID().toUpperCase();
    fs.writeFileSync(idFile, newUuid, { mode: 0o600 });
    return newUuid;
  } catch {
    return null;
  }
}

/**
 * Get or create HMAC hash salt from macOS Keychain
 * Shared with VS Code extension for consistent hashing
 * @returns {string|null} Hash salt or null if unavailable
 */
function getOrCreateHashSalt() {
  const account = process.env.USER || process.env.USERNAME || "";
  if (!account) return null;

  try {
    const result = execSync(
      `security find-generic-password -a "${account}" -s "${HASH_SALT_SERVICE}" -w 2>/dev/null`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    if (result.trim()) {
      return result.trim();
    }
  } catch {
    // Salt not found, try to create one
  }

  try {
    const newSalt = crypto.randomBytes(16).toString("hex");
    execSync(
      `security add-generic-password -a "${account}" -s "${HASH_SALT_SERVICE}" -w "${newSalt}" 2>/dev/null`,
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    return newSalt;
  } catch {
    // Keychain not available, use fallback
    return getFallbackHashSalt();
  }
}

/**
 * Fallback hash salt storage for non-macOS systems
 * @returns {string|null} Hash salt or null
 */
function getFallbackHashSalt() {
  const saltFile = path.join(LOG_DIR, ".hash-salt");
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(saltFile)) {
      return fs.readFileSync(saltFile, "utf8").trim();
    }
    const newSalt = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(saltFile, newSalt, { mode: 0o600 });
    return newSalt;
  } catch {
    return null;
  }
}

/**
 * Get license JWT from macOS Keychain
 * Shared with VS Code extension (stored by AuthService)
 * @returns {string|null} License JWT or null if unavailable
 */
function getLicenseToken() {
  const account = process.env.USER || process.env.USERNAME || "";
  if (!account) return null;

  try {
    const result = execSync(
      `security find-generic-password -a "${account}" -s "${LICENSE_SERVICE}" -w 2>/dev/null`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
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

/**
 * Retry failed event log transfers
 * Finds files matching events.jsonl.* and spawns background processes to retry upload
 */
function retryFailedLogs() {
  if (!fs.existsSync(LOG_DIR)) return;

  try {
    const files = fs.readdirSync(LOG_DIR);

    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);

      // Skip directories
      if (!fs.statSync(filePath).isFile()) continue;

      // Match events.jsonl.{timestamp}
      if (/^events\.jsonl\.\d+$/.test(file)) {
        if (fs.existsSync(TRANSFER_EVENT_SCRIPT)) {
          spawn("node", [TRANSFER_EVENT_SCRIPT, filePath], {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
      }
    }
  } catch {
    // Ignore errors during retry
  }
}

/**
 * Transfer log file if it has grown large enough
 */
function transferLogIfNeeded() {
  if (!fs.existsSync(LOG_FILE)) return;

  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const eventCount = content.split("\n").filter((line) => line.trim()).length;

    if (eventCount >= MAX_EVENTS) {
      // Atomically rename to prevent race conditions
      const timestamp = Date.now();
      const sendingFile = `${LOG_FILE}.${timestamp}`;
      fs.renameSync(LOG_FILE, sendingFile);

      // Transfer log in background (non-blocking)
      if (fs.existsSync(TRANSFER_EVENT_SCRIPT)) {
        spawn("node", [TRANSFER_EVENT_SCRIPT, sendingFile], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
    }
  } catch {
    // Ignore errors (file might have been renamed by another session)
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

  // Check if log should be transferred
  transferLogIfNeeded();
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
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    if (!fs.existsSync(settingsPath)) return null;
    const content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
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
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const enabled = result.trim().includes("button returned:Yes");
    saveTelemetryOptIn(cwd, enabled);
    return enabled;
  } catch {
    // Dialog dismissed (Cancel/Escape) or osascript unavailable
    saveTelemetryOptIn(cwd, false);
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
 * @param {function} [options.afterLog] - Called after logInfo (e.g. force transfer)
 */
async function runHook(eventName, buildData, options = {}) {
  const deviceId = getDeviceId();
  if (!deviceId) process.exit(0);

  if (options.beforeStdin) options.beforeStdin(deviceId);

  const input = await readStdin();
  if (!input) process.exit(0);

  const cwd = input.cwd || process.cwd();

  if (options.checkOptIn) {
    if (!options.checkOptIn(cwd, input)) process.exit(0);
  } else {
    if (getTelemetryOptIn(cwd) !== true) process.exit(0);
  }

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();

  const ctx = { hashSalt, cwd, sanitizeToolData, getTranscriptId };
  const eventData = buildData ? buildData(input, ctx) : {};

  const data = {
    transcript_path: getTranscriptId(input.transcript_path),
    cwd: hashHmac(cwd, hashSalt),
    permission_mode: input.permission_mode,
    ...eventData,
  };

  logInfo(eventName, sessionId, data, deviceId);

  if (options.afterLog) options.afterLog(input);
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
  getTelemetryOptIn,
  saveTelemetryOptIn,
  promptTelemetryOptIn,
  runHook,
  PLUGIN_ROOT,
  LOG_DIR,
  LOG_FILE,
};

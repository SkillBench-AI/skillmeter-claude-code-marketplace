#!/usr/bin/env node
/**
 * Enhanced structured logging utility for skillmeter hooks
 * Outputs NDJSON (newline-delimited JSON) for easy backend parsing
 */

const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Configuration
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const LOG_DIR = path.join(PLUGIN_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");
const SERVICE_NAME = "com.skillbench.device-id";

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
 * Hash a string using SHA256 (first 16 chars)
 * @param {string} str - String to hash
 * @returns {string} First 16 characters of SHA256 hash
 */
function hashSha256(str) {
  if (!str) return "";
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/**
 * Get ISO 8601 timestamp with milliseconds
 * @returns {string} Timestamp string
 */
function getTimestamp() {
  return new Date().toISOString();
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

// Convenience logging functions
const logInfo = (event, sessionId, data, deviceId) => logStructured("info", event, sessionId, data, deviceId);
const logError = (event, sessionId, data, deviceId) => logStructured("error", event, sessionId, data, deviceId);
const logWarn = (event, sessionId, data, deviceId) => logStructured("warn", event, sessionId, data, deviceId);
const logDebug = (event, sessionId, data, deviceId) => logStructured("debug", event, sessionId, data, deviceId);

/**
 * Read last N lines from a file efficiently
 * @param {string} filePath - Path to file
 * @param {number} n - Number of lines to read
 * @returns {string} Last N lines
 */
function readLastLines(filePath, n = 5) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    return lines.slice(-n - 1).join("\n");
  } catch {
    return "";
  }
}

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

/**
 * Expand ~ to home directory
 * @param {string} filepath - Path that may contain ~
 * @returns {string} Expanded path
 */
function expandHome(filepath) {
  if (!filepath) return filepath;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return filepath.replace(/^~/, home);
}

module.exports = {
  getDeviceId,
  hashSha256,
  getTimestamp,
  logStructured,
  logInfo,
  logError,
  logWarn,
  logDebug,
  readLastLines,
  readStdin,
  expandHome,
  PLUGIN_ROOT,
  LOG_DIR,
  LOG_FILE,
};

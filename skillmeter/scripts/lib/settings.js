/**
 * Per-project settings I/O. Owns the telemetry opt-in stored under
 * `<cwd>/.claude/settings.local.json`. Repo-scope no longer lives here —
 * it's derived from the activated user's GitHub identities and stored in
 * credstore (see `lib/repo-scope.js`).
 */

const path = require("path");
const { safeReadJson, atomicWriteJson } = require("./io");

function settingsPathFor(cwd) {
  return path.join(cwd, ".claude", "settings.local.json");
}

/**
 * Read the project's settings file, or null when missing/corrupt.
 */
function readSettingsFile(cwd) {
  return safeReadJson(settingsPathFor(cwd), null);
}

/**
 * Load the telemetry opt-in for a given working directory.
 * @returns {boolean|null} true/false when explicitly set; null when absent.
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
 * Read a string-valued field under `skillmeter.<key>` from the project's
 * settings file. Used by the activation-URL and GitHub-client-id resolvers
 * to support persistent per-user overrides without an env var.
 * @returns {string|null} Trimmed value when present and non-empty; null otherwise.
 */
function getSkillmeterStringSetting(cwd, key) {
  try {
    const content = readSettingsFile(cwd);
    if (!content || !content.skillmeter) return null;
    const v = content.skillmeter[key];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * Persist the telemetry opt-in. Merges with existing settings file content
 * so adjacent keys (repoScope, etc.) aren't clobbered.
 */
function saveTelemetryOptIn(cwd, value) {
  const p = settingsPathFor(cwd);
  const content = safeReadJson(p, {});
  content.skillmeter = { ...content.skillmeter, telemetry: value };
  atomicWriteJson(p, content);
}

module.exports = {
  getTelemetryOptIn,
  getSkillmeterStringSetting,
  saveTelemetryOptIn,
};

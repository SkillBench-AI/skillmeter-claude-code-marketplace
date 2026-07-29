/**
 * Per-project settings I/O. Telemetry consent lives exclusively in the machine
 * policy SSOT (lib/telemetry-store.js) and is never read from here; only
 * string-valued dev overrides are local to a project.
 */

const path = require("path");
const { safeReadJson } = require("./io");

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

module.exports = {
  getSkillmeterStringSetting,
};

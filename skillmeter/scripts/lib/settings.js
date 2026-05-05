/**
 * Per-project settings I/O. Owns the telemetry opt-in stored under
 * `<cwd>/.claude/settings.local.json`. Repo-scope no longer lives here —
 * it's derived from the activated user's GitHub identities and stored in
 * credstore (see `lib/repo-scope.js`).
 */

const fs = require("fs");
const path = require("path");

function settingsPathFor(cwd) {
  return path.join(cwd, ".claude", "settings.local.json");
}

/**
 * Read the project's settings file, or null when missing/corrupt.
 */
function readSettingsFile(cwd) {
  try {
    const p = settingsPathFor(cwd);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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
 * Persist the telemetry opt-in. Merges with existing settings file content
 * so adjacent keys (repoScope, etc.) aren't clobbered.
 */
function saveTelemetryOptIn(cwd, value) {
  const p = settingsPathFor(cwd);
  let content = {};
  try {
    if (fs.existsSync(p)) {
      content = JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch {
    content = {};
  }
  content.skillmeter = { ...content.skillmeter, telemetry: value };
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(content, null, 2) + "\n");
}

module.exports = {
  readSettingsFile,
  getTelemetryOptIn,
  saveTelemetryOptIn,
};

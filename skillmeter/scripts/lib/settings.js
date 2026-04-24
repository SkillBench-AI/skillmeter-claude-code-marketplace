/**
 * Per-project settings I/O. Single owner of `.claude/settings.local.json` —
 * both the telemetry opt-in and the repo-scope config live there, so this
 * module centralises the read/write path to keep them in sync.
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
 * Read the repo-scope config block. Returns a shape that's always safe to
 * consume (never throws on missing keys; arrays always iterable; org names
 * always trimmed + lowercased for case-insensitive match).
 */
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
  getRepoScopeSettings,
  getTelemetryOptIn,
  saveTelemetryOptIn,
};

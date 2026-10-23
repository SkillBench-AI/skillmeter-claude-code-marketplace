/**
 * Read skillmeter settings from <cwd>/.codex/settings.local.json: the local
 * telemetry restriction and repository scope narrowing.
 */

const fs = require("fs");
const path = require("path");

const SETTINGS_RELATIVE = path.join(".codex", "settings.local.json");

function readSettingsFile(cwd) {
  try {
    const p = path.join(cwd, SETTINGS_RELATIVE);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// A missing choice is distinct from malformed or unreadable settings: the
// consent record grants capture only when the local choice is not a restriction.
function readTelemetryChoice(directory) {
  const file = path.join(directory, SETTINGS_RELATIVE);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  try {
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!object(settings) || (settings.skillmeter !== undefined && !object(settings.skillmeter))) return "invalid";
    const choice = settings.skillmeter?.telemetry;
    return choice === true ? "on" : choice === false ? "off" : choice === undefined ? "unset" : "invalid";
  } catch (error) {
    const { policyPathIsAbsent } = require("./consent-policy");
    return error.code === "ENOENT" && policyPathIsAbsent(file) ? "unset" : "invalid";
  }
}

module.exports = {
  SETTINGS_RELATIVE,
  readTelemetryChoice,
  readSettingsFile,
};

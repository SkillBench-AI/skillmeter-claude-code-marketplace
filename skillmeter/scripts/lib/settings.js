/**
 * Per-project settings I/O. Telemetry is read here only for one-time migration
 * into the machine policy SSOT; string-valued dev settings remain local.
 */

const fs = require("fs");
const crypto = require("crypto");
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

function getTelemetryOptInSnapshot(cwd) {
  try {
    const raw = fs.readFileSync(settingsPathFor(cwd), "utf8");
    const content = JSON.parse(raw);
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return null;
    }
    if (!content.skillmeter || typeof content.skillmeter.telemetry !== "boolean") {
      return null;
    }
    return {
      value: content.skillmeter.telemetry,
      fingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
    };
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
 * Remove only the legacy telemetry key after it has been imported into the
 * machine policy store. Adjacent Claude and SkillMeter settings are preserved.
 * A file that contained no other settings is removed instead of leaving `{}`.
 */
function removeTelemetryOptIn(cwd, expectedValue, expectedFingerprint = "") {
  const p = settingsPathFor(cwd);
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return false;
  }
  if (
    expectedFingerprint &&
    crypto.createHash("sha256").update(raw).digest("hex") !== expectedFingerprint
  ) {
    return false;
  }
  let content;
  try {
    content = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return false;
  }
  if (
    !content.skillmeter ||
    content.skillmeter.telemetry !== expectedValue
  ) {
    return false;
  }

  const nextSkillmeter = { ...content.skillmeter };
  delete nextSkillmeter.telemetry;
  const next = { ...content };
  if (Object.keys(nextSkillmeter).length === 0) delete next.skillmeter;
  else next.skillmeter = nextSkillmeter;

  if (Object.keys(next).length === 0) {
    try {
      fs.unlinkSync(p);
      return true;
    } catch (err) {
      if (err && err.code === "ENOENT") return true;
      return false;
    }
  }

  try {
    atomicWriteJson(p, next);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getTelemetryOptInSnapshot,
  getSkillmeterStringSetting,
  removeTelemetryOptIn,
  settingsPathFor,
};

#!/usr/bin/env node
/**
 * Manage SkillMeter telemetry — both the per-project opt-in (stored in
 * `<cwd>/.claude/settings.local.json`) and the machine-global kill-switch
 * (stored in `~/.skillbench/credentials.json`).
 *
 * Usage:
 *   node telemetry.js enable          # opt this project in
 *   node telemetry.js disable         # opt this project out
 *   node telemetry.js enable-global   # clear the global kill-switch
 *   node telemetry.js disable-global  # set the global kill-switch
 *   node telemetry.js status          # show global + per-project + sign-in state
 */

const {
  getTelemetryOptIn,
  saveTelemetryOptIn,
} = require("./lib/settings");
const {
  getAllowedGitHubOrgs,
  getLicenseToken,
  isLicenseTokenExpired,
  getSignedOut,
  getTelemetryDisabled,
  setTelemetryDisabled,
} = require("./credstore.js");

const cwd = process.cwd();
const action = process.argv[2];

function projectLine() {
  const optIn = getTelemetryOptIn(cwd);
  if (optIn === true) return "enabled";
  if (optIn === false) return "disabled";
  return "not configured";
}

function globalLine() {
  return getTelemetryDisabled() ? "disabled" : "enabled";
}

function licenseLine() {
  if (getSignedOut()) return "signed out — run /skillmeter:signin";
  const token = getLicenseToken();
  if (!token) return "not signed in — run /skillmeter:signin";
  if (isLicenseTokenExpired(token)) return "license expired — run /skillmeter:signin";
  const orgs = getAllowedGitHubOrgs();
  if (orgs.length === 0) return "signed in (no orgs cached)";
  return `signed in as ${orgs.join(", ")}`;
}

function printStatus() {
  process.stderr.write(
    "SkillMeter telemetry:\n" +
    `  global:       ${globalLine()}\n` +
    `  this project: ${projectLine()}\n` +
    `  license:      ${licenseLine()}\n`
  );
}

switch (action) {
  case "enable":
    saveTelemetryOptIn(cwd, true);
    process.stderr.write(`SkillMeter: telemetry enabled for ${cwd}\n`);
    if (getTelemetryDisabled()) {
      process.stderr.write(
        "Note: the global kill-switch is on, so telemetry still won't fire. " +
        "Run `/skillmeter:telemetry enable-global` to clear it.\n"
      );
    }
    printStatus();
    break;
  case "disable":
    saveTelemetryOptIn(cwd, false);
    process.stderr.write(`SkillMeter: telemetry disabled for ${cwd}\n`);
    printStatus();
    break;
  case "enable-global":
    setTelemetryDisabled(false);
    process.stderr.write("SkillMeter: global telemetry kill-switch cleared.\n");
    printStatus();
    break;
  case "disable-global":
    setTelemetryDisabled(true);
    process.stderr.write(
      "SkillMeter: global telemetry kill-switch ON. " +
      "No events will be transmitted from any project until you run " +
      "`/skillmeter:telemetry enable-global`.\n"
    );
    printStatus();
    break;
  case "status":
    printStatus();
    break;
  default:
    process.stderr.write(
      "Usage: node telemetry.js <enable|disable|enable-global|disable-global|status>\n"
    );
    process.exit(1);
}

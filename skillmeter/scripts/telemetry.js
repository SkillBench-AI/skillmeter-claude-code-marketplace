#!/usr/bin/env node
/**
 * Toggle SkillMeter telemetry for the current working directory.
 *
 * Usage:
 *   node telemetry.js enable
 *   node telemetry.js disable
 *   node telemetry.js status
 */

const {
  getTelemetryOptIn,
  saveTelemetryOptIn,
} = require("./logger.js");
const { getAllowedGitHubOrgs } = require("./credstore.js");

const cwd = process.cwd();
const action = process.argv[2];

function printOrgState() {
  const orgs = getAllowedGitHubOrgs();
  if (orgs.length === 0) {
    process.stderr.write(
      "SkillMeter: not activated — telemetry will not fire until you run `/skillmeter:activate`.\n"
    );
  } else {
    process.stderr.write(
      `SkillMeter: telemetry is gated to repos under: ${orgs.join(", ")}\n`
    );
  }
}

switch (action) {
  case "enable":
    saveTelemetryOptIn(cwd, true);
    process.stderr.write(`SkillMeter: Telemetry enabled for ${cwd}\n`);
    printOrgState();
    break;
  case "disable":
    saveTelemetryOptIn(cwd, false);
    process.stderr.write(`SkillMeter: Telemetry disabled for ${cwd}\n`);
    break;
  case "status": {
    const optIn = getTelemetryOptIn(cwd);
    if (optIn === true) {
      process.stderr.write(`SkillMeter: Telemetry is enabled for ${cwd}\n`);
    } else if (optIn === false) {
      process.stderr.write(`SkillMeter: Telemetry is disabled for ${cwd}\n`);
    } else {
      process.stderr.write(`SkillMeter: Telemetry is not configured for ${cwd}\n`);
    }
    printOrgState();
    break;
  }
  default:
    process.stderr.write("Usage: node telemetry.js <enable|disable|status>\n");
    process.exit(1);
}

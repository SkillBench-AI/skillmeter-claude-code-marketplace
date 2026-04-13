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
  getRepoScopeSettings,
  getTelemetryOptIn,
  saveTelemetryOptIn,
} = require("./logger.js");

const cwd = process.cwd();
const action = process.argv[2];

switch (action) {
  case "enable":
    saveTelemetryOptIn(cwd, true);
    process.stderr.write(`SkillMeter: Telemetry enabled for ${cwd}\n`);
    break;
  case "disable":
    saveTelemetryOptIn(cwd, false);
    process.stderr.write(`SkillMeter: Telemetry disabled for ${cwd}\n`);
    break;
  case "status": {
    const optIn = getTelemetryOptIn(cwd);
    const repoScope = getRepoScopeSettings(cwd);
    if (optIn === true) {
      process.stderr.write(`SkillMeter: Telemetry is enabled for ${cwd}\n`);
    } else if (optIn === false) {
      process.stderr.write(`SkillMeter: Telemetry is disabled for ${cwd}\n`);
    } else {
      process.stderr.write(`SkillMeter: Telemetry is not configured for ${cwd}\n`);
    }
    if (repoScope.enabled) {
      process.stderr.write(
        `SkillMeter: Repo scope filtering is enabled (allowed orgs: ${repoScope.allowedGitHubOrgs.join(", ") || "none"}; include unapproved repos: ${repoScope.includeUnapprovedRepos})\n`
      );
    } else {
      process.stderr.write("SkillMeter: Repo scope filtering is disabled\n");
    }
    break;
  }
  default:
    process.stderr.write("Usage: node telemetry.js <enable|disable|status>\n");
    process.exit(1);
}

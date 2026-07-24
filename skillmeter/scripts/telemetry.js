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
const credstore = require("./credstore.js");
const {
  getAllowedGitHubOrgs,
  getLicenseToken,
  isLicenseTokenExpired,
  getSignedOut,
  getTelemetryDisabled,
  setTelemetryDisabled,
} = credstore;
const { getRepoScopeDecision } = require("./lib/repo-scope");
const { resolveTelemetryGate } = require("./lib/telemetry-policy");

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

function orgLine() {
  const orgs = getAllowedGitHubOrgs();
  if (orgs.length === 0) return "not available";
  return orgs.map((org) => {
    const consent = credstore.getOrgTelemetryConsent(org);
    const state = consent === true ? "enabled" : consent === false ? "disabled" : "choice required";
    return `@${org} ${state}`;
  }).join(", ");
}

function effectiveLine() {
  const scope = getRepoScopeDecision(cwd);
  const orgConsent = scope.remoteOrg
    ? credstore.getOrgTelemetryConsent(scope.remoteOrg)
    : null;
  const gate = resolveTelemetryGate({
    globalDisabled: getTelemetryDisabled(),
    hasValidLicense: credstore.hasValidLicense(),
    repoOrgOwned: scope.allowed,
    orgConsent,
    projectOptIn: getTelemetryOptIn(cwd),
  });
  return gate.capture ? `enabled (${gate.mode})` : `disabled (${gate.mode})`;
}

function printStatus() {
  process.stderr.write(
    "SkillMeter telemetry:\n" +
    `  global:       ${globalLine()}\n` +
    `  organization: ${orgLine()}\n` +
    `  this project: ${projectLine()}\n` +
    `  effective:    ${effectiveLine()}\n` +
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
    const scope = getRepoScopeDecision(cwd);
    if (
      scope.allowed &&
      credstore.getOrgTelemetryConsent(scope.remoteOrg) !== true
    ) {
      process.stderr.write(
        `Note: telemetry is not enabled for @${scope.remoteOrg}. ` +
        "Run `/skillmeter:signin` to choose the organization setting.\n"
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
    if (!credstore.isTelemetryTransmissionAllowed()) {
      process.stderr.write(
        "Note: organization telemetry is still disabled or awaiting a choice. " +
        "Run `/skillmeter:signin` to review it.\n"
      );
    }
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

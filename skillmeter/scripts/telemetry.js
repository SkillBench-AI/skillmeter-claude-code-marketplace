#!/usr/bin/env node
/**
 * Manage SkillMeter telemetry through the machine policy SSOT.
 *
 * Usage:
 *   node telemetry.js enable          # opt this project in
 *   node telemetry.js disable         # opt this project out
 *   node telemetry.js enable-global   # clear the global kill-switch
 *   node telemetry.js disable-global  # set the global kill-switch
 *   node telemetry.js status          # show global + per-project + sign-in state
 */

const telemetryStore = require("./lib/telemetry-store");
const { purgeRepositoryQueue } = require("./lib/repository-queue");
const credstore = require("./credstore.js");
const {
  getAllowedGitHubOrgs,
  getLicenseToken,
  isLicenseTokenExpired,
  getSignedOut,
} = credstore;
const { getRepoScopeDecision } = require("./lib/repo-scope");
const { resolveTelemetryGate } = require("./lib/telemetry-policy");

const cwd = process.cwd();
const action = process.argv[2];
const repoScopeDecision = getRepoScopeDecision(cwd);
// Display only — the telemetry decision itself is keyed by canonical GitHub
// repository identity, not by this path.
const projectRoot = repoScopeDecision.repoRoot || cwd;

function projectLine() {
  const optIn = repoScopeDecision.repoKey
    ? telemetryStore.getRepositoryOverride(repoScopeDecision.repoKey)
    : null;
  if (optIn === true) return "enabled";
  if (optIn === false) return "disabled";
  return "not configured";
}

function globalLine() {
  return telemetryStore.getGlobalDisabled() ? "disabled" : "enabled";
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
    const consent = telemetryStore.getOrganizationConsent(org);
    const state = consent === true ? "authorized" : consent === false ? "disabled" : "choice required";
    return `@${org} ${state}`;
  }).join(", ");
}

function effectiveLine() {
  const orgConsent = repoScopeDecision.remoteOrg
    ? telemetryStore.getOrganizationConsent(repoScopeDecision.remoteOrg)
    : null;
  const gate = resolveTelemetryGate({
    globalDisabled: telemetryStore.getGlobalDisabled(),
    hasValidLicense: credstore.hasValidLicense(),
    repoOrgOwned: repoScopeDecision.allowed,
    orgConsent,
    projectOptIn: repoScopeDecision.repoKey
      ? telemetryStore.getRepositoryOverride(repoScopeDecision.repoKey)
      : null,
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
    if (!repoScopeDecision.repoKey) {
      process.stderr.write("SkillMeter: this directory has no unambiguous licensed GitHub repository.\n");
      process.exit(1);
    }
    telemetryStore.setRepositoryOverride(repoScopeDecision.repoKey, true);
    process.stderr.write(`SkillMeter: telemetry enabled for ${projectRoot}\n`);
    if (telemetryStore.getGlobalDisabled()) {
      process.stderr.write(
        "Note: the global kill-switch is on, so telemetry still won't fire. " +
        "Run `/skillmeter:telemetry enable-global` to clear it.\n"
      );
    }
    if (
      repoScopeDecision.allowed &&
      telemetryStore.getOrganizationConsent(repoScopeDecision.remoteOrg) !== true
    ) {
      process.stderr.write(
        `Note: telemetry is not enabled for @${repoScopeDecision.remoteOrg}. ` +
        "Run `/skillmeter:signin` to choose the organization setting.\n"
      );
    }
    printStatus();
    break;
  case "disable":
    if (!repoScopeDecision.repoKey) {
      process.stderr.write("SkillMeter: this directory has no unambiguous licensed GitHub repository.\n");
      process.exit(1);
    }
    telemetryStore.setRepositoryOverride(repoScopeDecision.repoKey, false);
    purgeRepositoryQueue(repoScopeDecision.repoKey);
    process.stderr.write(`SkillMeter: telemetry disabled for ${projectRoot}\n`);
    printStatus();
    break;
  case "enable-global":
    telemetryStore.setGlobalEnabled(true);
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
    telemetryStore.setGlobalEnabled(false);
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

#!/usr/bin/env node

const credstore = require("./credstore");

function currentStatus() {
  const orgs = credstore.getAllowedGitHubOrgs();
  return {
    signedIn: credstore.hasValidLicense(),
    orgs: orgs.map((org) => ({
      org,
      consent: credstore.getOrgTelemetryConsent(org),
    })),
  };
}

function fail(message) {
  process.stderr.write(`SkillMeter: ${message}\n`);
  process.exit(1);
}

function main() {
  const [action, orgArg, valueArg] = process.argv.slice(2);

  if (action === "status") {
    process.stdout.write(JSON.stringify(currentStatus()) + "\n");
    return;
  }

  if (action !== "set") {
    fail("usage: org_telemetry_consent.js <status|set ORG enabled|disabled>");
  }

  const org = typeof orgArg === "string" ? orgArg.trim().toLowerCase() : "";
  const allowedOrgs = credstore.getAllowedGitHubOrgs();
  if (!credstore.hasValidLicense() || !org || !allowedOrgs.includes(org)) {
    fail("the requested organization is not present in the current valid license.");
  }
  if (valueArg !== "enabled" && valueArg !== "disabled") {
    fail("consent must be `enabled` or `disabled`.");
  }

  const enabled = valueArg === "enabled";
  credstore.setOrgTelemetryConsent(org, enabled);
  process.stdout.write(
    `SkillMeter: telemetry ${enabled ? "enabled" : "disabled"} for @${org}.\n`
  );
}

try {
  main();
} catch (err) {
  fail(err.message);
}

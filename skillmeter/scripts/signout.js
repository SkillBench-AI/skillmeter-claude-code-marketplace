#!/usr/bin/env node
/**
 * Remove the shared license and mark the device signed out. Preserve device ID,
 * hash salt and telemetry policy. Explicit sign-in clears the sentinel.
 */

const credstore = require("./credstore.js");
const {
  purgeOrganizationAuditQueues,
} = require("./lib/organization-audit-queue");

function main() {
  const hadLicense = credstore.getLicenseToken() !== null;

  credstore.signOut();
  purgeOrganizationAuditQueues();

  if (hadLicense) {
    process.stdout.write("SkillMeter: signed out. Run /skillmeter:signin to re-enable.\n");
  } else {
    process.stdout.write("SkillMeter: already signed out.\n");
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`Sign-out failed: ${err.message}\n`);
  process.exit(1);
}

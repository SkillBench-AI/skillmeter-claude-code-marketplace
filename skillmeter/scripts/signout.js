#!/usr/bin/env node
/**
 * Remove this plugin's license and mark its session signed out. Preserve device ID,
 * hash salt and telemetry policy. Explicit sign-in clears the sentinel.
 */

const credstore = require("./credstore.js");
const {
  purgeOrganizationAuditQueues,
} = require("./lib/organization-audit-queue");
const { purgeAllRepositoryQueues } = require("./lib/repository-queue");

function main() {
  const hadLicense = credstore.getLicenseToken() !== null;

  credstore.signOut();
  purgeOrganizationAuditQueues();
  // Capture no longer waits for a fresh token, so sign-out is what ends it
  // and removes what was recorded but not yet sent.
  purgeAllRepositoryQueues();

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

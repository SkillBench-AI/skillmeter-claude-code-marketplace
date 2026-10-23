#!/usr/bin/env node
/**
 * Remove this plugin's license and mark its session signed out. Preserve device ID,
 * hash salt and telemetry policy. Explicit sign-in clears the sentinel.
 * Then revoke the broker refresh token (ADR 005), so a copy of the session
 * cannot renew anywhere else.
 */

const credstore = require("./credstore.js");
const broker = require("./lib/broker");
const {
  purgeOrganizationAuditQueues,
} = require("./lib/organization-audit-queue");
const { purgeAllRepositoryQueues } = require("./lib/repository-queue");

async function main() {
  const hadLicense = credstore.getLicenseToken() !== null;
  const { refreshToken } = credstore.recoverySnapshot();

  // Local first: sign-out takes effect at once, whatever the network does.
  credstore.signOut();
  purgeOrganizationAuditQueues();
  // Capture no longer waits for a fresh token, so sign-out is what ends it
  // and removes what was recorded but not yet sent.
  purgeAllRepositoryQueues();

  const revoked = refreshToken ? await broker.revoke(refreshToken) : false;

  if (hadLicense) {
    process.stdout.write("SkillMeter: signed out. Run /skillmeter:signin to re-enable.\n");
  } else {
    process.stdout.write("SkillMeter: already signed out.\n");
  }
  if (refreshToken && !revoked) {
    process.stdout.write(
      "SkillMeter: could not reach the sign-in service to end the session there; it expires on its own.\n"
    );
  }
}

main().catch((err) => {
  process.stderr.write(`Sign-out failed: ${err.message}\n`);
  process.exit(1);
});

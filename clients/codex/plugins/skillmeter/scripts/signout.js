#!/usr/bin/env node
/**
 * Sign out of this plugin: end its session locally, delete event batches that
 * were recorded but not sent, then revoke the sign-in service's refresh token
 * (ADR 005). The device identity and consent choices are kept. Other SkillMeter
 * clients on the machine stay signed in.
 * Usage: node scripts/signout.js.
 */

const credstore = require("./credstore.js");
const broker = require("./lib/broker");
const { purgeEventLogs } = require("./logger.js");

async function main() {
  const hadLicense = credstore.getLicenseToken() !== null;
  const { refreshToken } = credstore.recoverySnapshot();

  // Local first: sign-out takes effect at once, whatever the network does.
  credstore.signOut();
  purgeEventLogs();

  const revoked = refreshToken ? await broker.revoke(refreshToken) : false;

  process.stdout.write(hadLicense
    ? "SkillMeter: signed out. Run $skillmeter:signin to record again.\n"
    : "SkillMeter: already signed out.\n");
  if (refreshToken && !revoked) {
    process.stdout.write("SkillMeter: could not reach the sign-in service to end the session there; it expires on its own.\n");
  }
}

main().catch(err => {
  process.stderr.write(`Sign-out failed: ${err.message}\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Sign in to SkillMeter for Codex: the shared flow in lib/signin-flow.js
 * (ADR 005), then the cards and the state line the signin skill reads to start
 * onboarding. Usage: node scripts/signin.js [--restart].
 */

const path = require("path");
const credstore = require("./credstore.js");
const config = require("./lib/config");
const licenseActivation = require("./lib/license-activation");
const { signinBanner } = require("./lib/banner.js");
const signinFlow = require("./lib/signin-flow");

const say = (msg) => process.stdout.write(msg + "\n");

// Cards showing each organization's telemetry state and its local
// repositories, then the line the signin skill reads to start onboarding.
// That line carries organizations and their Codex consent only; the skill
// lists repositories again right before asking.
function sayWelcome() {
  let inventory = null, currentKey = null, error = null;
  try {
    const { loadInventory } = require("./lib/repository-inventory");
    const loaded = loadInventory();
    inventory = loaded.inventory;
    currentKey = loaded.logger.getRepoScopeDecision(process.cwd()).repoKey || null;
  } catch (err) {
    error = err.code || "POLICY_UNAVAILABLE";
  }
  say(signinBanner({ inventory, currentKey, error }));
  const state = error
    ? { status: "signed_in", consentRecordError: error }
    : { status: "signed_in", globalPaused: inventory.globalPaused, orgs: inventory.orgs };
  say(`SkillMeter sign-in state JSON:\n${JSON.stringify(state)}`);
}

// A valid license whose session the sign-in service already ended is not a
// sign-in to keep.
const sessionEnded = () => Boolean(credstore.getLicenseToken()) && Boolean(licenseActivation.readStatus().terminal);

const pending = signinFlow.filePending(
  () => path.join(config.sessionDir(), "signin-pending.json"),
  () => credstore.getAuthGeneration(),
);

signinFlow.main({
  script: __filename,
  signinCommand: config.SIGNIN_COMMAND,
  restartCommand: `node "${__filename}" --restart`,
  confirmHint: "confirm and choose telemetry",
  backgroundLog: () => path.join(config.sessionDir(), "signin-poll.log"),
  prepare: () => {
    const { prepareSession, CUTOVER_HOLD } = require("./session_start");
    if (!prepareSession()) throw new Error(CUTOVER_HOLD);
  },
  currentSignin: () => {
    const token = credstore.getLicenseToken();
    return token && !sessionEnded() && !credstore.isLicenseTokenExpired(token) ? token : null;
  },
  sessionEnded,
  showSignedIn: sayWelcome,
  pending,
  commit: ({ jwt, refreshToken, expected }) => credstore.commitSignin({ jwt, refreshToken, generation: expected.generation }),
});

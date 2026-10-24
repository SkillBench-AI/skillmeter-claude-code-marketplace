#!/usr/bin/env node
/**
 * Sign in to SkillMeter for Claude Code: the shared flow in lib/signin-flow.js
 * (ADR 005). In Claude Code's `!` runner, which buffers output until exit, the
 * poll runs in the background; the FileChanged notifier and the next
 * /skillmeter:signin report its result.
 */

const path = require("path");
const credstore = require("./credstore.js");
const { signinStatusBanner } = require("./lib/banner.js");
const { getRepoScopeDecision } = require("./lib/scope-decision");
const telemetryStore = require("./lib/telemetry-store");
const { clearLicenseStatus, isSessionEnded, recordSignin } = require("./lib/license-status");
const { STATE_DIR, SIGNIN_COMMAND } = require("./lib/config");
const signinFlow = require("./lib/signin-flow");

const say = (msg) => process.stdout.write(msg + "\n");

function showSigninStatus(cwd = process.cwd()) {
  const org = credstore.getAllowedGitHubOrgs()[0] || "";
  const consent = org ? telemetryStore.getOrganizationConsent(org) : null;
  const scope = getRepoScopeDecision(cwd);
  const repositoryEnabled =
    !telemetryStore.getGlobalDisabled() &&
    scope.allowed &&
    scope.remoteOrg === org &&
    telemetryStore.getRepositoryOverride(scope.repoKey) === true;
  say(signinStatusBanner(org, consent, repositoryEnabled));
  if (org && consent === null) {
    say(`Run /skillmeter:signin to choose whether to enable telemetry for @${org}.`);
  }
}

// A session the broker or the server ended can leave a license that is still
// valid for up to one lifetime; that license is not a sign-in to keep. A
// sign-out keeps the ended session's reason but no license.
const sessionEnded = () => Boolean(credstore.getLicenseToken()) && isSessionEnded();

signinFlow.main({
  script: __filename,
  signinCommand: SIGNIN_COMMAND,
  restartCommand: `${path.join(__dirname, "..", "bin", "signin")} --restart`,
  confirmHint: "confirm",
  backgroundLog: () => path.join(STATE_DIR, "activate-poll.log"),
  currentSignin: () => {
    const token = credstore.getLicenseToken();
    return token && !sessionEnded() && !credstore.isLicenseTokenExpired(token) ? token : null;
  },
  sessionEnded,
  onEngaged: () => clearLicenseStatus({ source: "signin" }),
  showSignedIn: () => showSigninStatus(),
  // The waiting sign-in lives in the sign-in result the FileChanged notifier
  // reads; a success or failure result replaces it.
  pending: {
    isPending: () => credstore.isSigninPending(),
    mark: (lifetimeMs, expected) => credstore.writeSigninPending(lifetimeMs, expected),
  },
  commit: ({ jwt, refreshToken, expected }) => credstore.commitSignin({
    jwt, refreshToken, expected,
    onCommit: () => {
      recordSignin({ source: "signin" });
      credstore.writeSigninResult({ status: "success" });
    },
  }),
  recordFailure: (message, expected) => credstore.writeSigninResult({ status: "failure", error: message }, expected),
});

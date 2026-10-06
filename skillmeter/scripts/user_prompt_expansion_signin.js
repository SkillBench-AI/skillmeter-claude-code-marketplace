#!/usr/bin/env node
/**
 * Observe direct `/skillmeter:signin` invocation before it expands into a
 * Claude prompt. Nothing signs in here: the device grant needs a browser and a
 * terminal, so it belongs in the `signin` shell command. What this hook does
 * is report the current state — already licensed, or how to start.
 *
 * UserPromptExpansion can only block expansion or add context. Blocking makes
 * Claude Code render "operation blocked by hook", so this hook never blocks.
 */

const credstore = require("./credstore.js");
const telemetryStore = require("./lib/telemetry-store");
const { clearLicenseStatus, isSessionEnded } = require("./lib/license-status");
const { readStdinJson } = require("./lib/io");
const {
  loadRepositoryTelemetryState,
  publicRepositoryState,
} = require("./lib/repository-telemetry");
const path = require("path");
const {
  initializeBackfillLifecycle,
  publicBackfillState,
} = require("./lib/backfill-state");

const SIGNIN_COMMAND = path.join(__dirname, "..", "bin", "signin");

// `!`-prefixed instruction the LLM relays to the user. Pasting this into the
// next prompt makes Claude Code execute the binary in the user's own shell,
// preserving the interactive TTY the device flow needs.
const RUN_INSTRUCTION =
  `Tell the user to:\n` +
  `1. Paste the following into their NEXT prompt verbatim (the leading \`!\` ` +
  `is required — it makes Claude Code run the command in their shell):\n\n` +
  `    ! ${SIGNIN_COMMAND}\n\n` +
  `2. Open the URL it prints, and approve the code shown.\n` +
  `3. Once the browser shows the success page, run \`/skillmeter:signin\` ` +
  `again to confirm the license and see the welcome banner.`;

// A sign-in waits for approval. Starting over cancels it, so the command is
// offered only for when that sign-in cannot finish: the page was closed, the
// code expired, or its poller stopped, which is not detected here.
const IN_PROGRESS =
  `SkillMeter sign-in in progress. A sign-in code is waiting for approval in ` +
  `the browser. Tell the user to approve it there, then run ` +
  `\`/skillmeter:signin\` again to confirm.\n` +
  `Only if the browser page was closed, the code expired, or the user already ` +
  `approved and keeps getting this message, they can start over by pasting ` +
  `this into their NEXT prompt. It cancels the sign-in in progress:\n\n` +
  `    ! ${SIGNIN_COMMAND} --restart`;

// This hook has no TTY guard and defaults empty input to {} (its isSigninCommand
// check tolerates an empty object).
const readStdin = () => readStdinJson({ tty: {}, empty: {} });

function addContext(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptExpansion",
      additionalContext: [
        "SkillMeter sign-in status:",
        message,
      ].join("\n"),
    },
  }) + "\n");
}

function isSigninCommand(input) {
  if (input.command_name === "skillmeter:signin") return true;
  return input.command_name === "signin" && input.command_source === "plugin";
}

async function signedInContext(cwd = process.cwd(), activeSessionId = "") {
  let repositoryTelemetry;
  try {
    repositoryTelemetry = publicRepositoryState(
      await loadRepositoryTelemetryState({ currentCwd: cwd })
    );
  } catch {
    repositoryTelemetry = {
      scanFailed: true,
      repositories: [],
    };
  }
  const state = {
    status: "signed_in",
    globalTelemetryDisabled: telemetryStore.getGlobalDisabled(),
    orgs: credstore.getAllowedGitHubOrgs().map((org) => ({
      org,
      consent: telemetryStore.getOrganizationConsent(org),
    })),
    repositoryTelemetry,
    backfill: {
      ...backfillStateForSignin(),
      activeSessionId:
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          activeSessionId
        )
          ? activeSessionId
          : "",
    },
  };
  return `SkillMeter sign-in state JSON:\n${JSON.stringify(state)}`;
}

// A backfill problem must never block sign-in: report it as unavailable and
// the skill simply shows no History question.
function backfillStateForSignin() {
  try {
    return publicBackfillState();
  } catch {
    return { eligible: false, status: "unavailable", reason: "state_unreadable" };
  }
}

async function main() {
  const input = await readStdin();
  if (!isSigninCommand(input)) return;

  // Existing and new users receive the same one-time backfill lifecycle.
  try { initializeBackfillLifecycle(); } catch {}

  // A device flow is waiting for browser approval. A new intent here would
  // discard it, and the license on disk says nothing about it yet.
  if (credstore.isSigninPending()) {
    addContext(IN_PROGRESS);
    return;
  }

  // A session the broker ended can leave a license that is still valid. It is
  // not a sign-in to report, and the sign-in command must still find the
  // ended session, so nothing is reset here.
  if (credstore.getLicenseToken() && isSessionEnded()) {
    addContext(`Your SkillMeter session ended. Sign-in is required.\n${RUN_INSTRUCTION}`);
    return;
  }

  // Explicit sign-in starts a new intent and resets refresh status. A
  // sign-out stays recorded until the sign-in commits.
  credstore.markEngaged();
  clearLicenseStatus({ source: "signin" });

  const existingToken = credstore.getLicenseToken();
  if (existingToken && !credstore.isLicenseTokenExpired(existingToken)) {
    addContext(await signedInContext(
      input.cwd || process.cwd(),
      input.session_id || ""
    ));
    return;
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    addContext(`Sign-in failed: unable to determine device ID.\n${RUN_INSTRUCTION}`);
    return;
  }

  // Without a current license, direct the user to the browser-based device flow.
  addContext(`Sign-in is required.\n${RUN_INSTRUCTION}`);
}

main().catch((err) => {
  addContext(`Sign-in failed: ${err.message}.\n${RUN_INSTRUCTION}`);
});

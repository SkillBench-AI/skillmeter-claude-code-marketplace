#!/usr/bin/env node
/**
 * Observe direct `/skillmeter:signin` invocation before it expands into a
 * Claude prompt. Only silent gh-based sign-in runs here; the interactive
 * GitHub device flow belongs in the `signin` shell command.
 *
 * UserPromptExpansion can only block expansion or add context. Blocking makes
 * Claude Code render "operation blocked by hook", so this hook never blocks.
 */

const credstore = require("./credstore.js");
const telemetryStore = require("./lib/telemetry-store");
const { trySilentGhActivate } = require("./lib/license-activation");
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
// preserving the interactive TTY the GitHub device flow needs.
const RUN_INSTRUCTION =
  `Tell the user to:\n` +
  `1. Paste the following into their NEXT prompt verbatim (the leading \`!\` ` +
  `is required — it makes Claude Code run the command in their shell):\n\n` +
  `    ! ${SIGNIN_COMMAND}\n\n` +
  `2. Complete the GitHub device-flow authorization in their browser.\n` +
  `3. Once GitHub shows the success page, run \`/skillmeter:signin\` again ` +
  `to confirm the license and see the welcome banner.`;

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
      ...publicBackfillState(),
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

async function main() {
  const input = await readStdin();
  if (!isSigninCommand(input)) return;

  // Existing and new users receive the same one-time backfill lifecycle.
  initializeBackfillLifecycle();

  // Re-running signin re-arms the gh fallback and clears any signed-out
  // sentinel left by /skillmeter:signout — one atomic write.
  credstore.markEngaged();

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

  const jwt = await trySilentGhActivate(deviceId);
  if (jwt) {
    addContext(await signedInContext(
      input.cwd || process.cwd(),
      input.session_id || ""
    ));
    return;
  }

  addContext(`Interactive GitHub login is required.\n${RUN_INSTRUCTION}`);
}

main().catch((err) => {
  addContext(`Sign-in failed: ${err.message}.\n${RUN_INSTRUCTION}`);
});

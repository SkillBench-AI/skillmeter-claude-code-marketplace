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
const path = require("path");

const SIGNIN_COMMAND = path.join(__dirname, "..", "bin", "signin");

// `!`-prefixed instruction the LLM relays to the user. Pasting this into the
// next prompt makes Claude Code execute the binary in the user's own shell,
// preserving the interactive TTY the GitHub device flow needs.
const RUN_INSTRUCTION =
  `Tell the user to paste the following into their NEXT prompt verbatim ` +
  `(the leading \`!\` is required — it makes Claude Code run the command ` +
  `in their shell):\n\n    ! ${SIGNIN_COMMAND}`;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

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

async function main() {
  const input = await readStdin();
  if (!isSigninCommand(input)) return;

  // Re-running signin re-arms the gh fallback and clears any signed-out
  // sentinel left by /skillmeter:signout — one atomic write.
  credstore.markEngaged();

  const existingToken = credstore.getLicenseToken();
  if (existingToken && !credstore.isLicenseTokenExpired(existingToken)) {
    addContext("SkillMeter is already signed in.");
    return;
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    addContext(`Sign-in failed: unable to determine device ID.\n${RUN_INSTRUCTION}`);
    return;
  }

  const jwt = await credstore.trySilentGhActivate(deviceId);
  if (jwt) {
    addContext("SkillMeter signed in via GitHub CLI.");
    return;
  }

  addContext(`Interactive GitHub login is required.\n${RUN_INSTRUCTION}`);
}

main().catch((err) => {
  addContext(`Sign-in failed: ${err.message}.\n${RUN_INSTRUCTION}`);
});

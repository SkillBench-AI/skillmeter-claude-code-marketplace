#!/usr/bin/env node
/**
 * Observe direct `/skillmeter:activate` invocation before it expands into
 * a Claude prompt. Only silent gh-based activation runs here; interactive
 * GitHub device flow belongs in the `activate` shell command.
 *
 * UserPromptExpansion can only block expansion or add context. Blocking makes
 * Claude Code render "operation blocked by hook", so this hook never blocks.
 */

const credstore = require("./credstore.js");
const path = require("path");

const ACTIVATE_COMMAND = path.join(__dirname, "..", "bin", "activate");

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
        "SkillMeter activation status:",
        message,
      ].join("\n"),
    },
  }) + "\n");
}

function isActivateCommand(input) {
  if (input.command_name === "skillmeter:activate") return true;
  return input.command_name === "activate" && input.command_source === "plugin";
}

async function main() {
  const input = await readStdin();
  if (!isActivateCommand(input)) return;

  const existingToken = credstore.getLicenseToken();
  if (existingToken && !credstore.isLicenseTokenExpired(existingToken)) {
    addContext("SkillMeter is already activated.");
    return;
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    addContext(`Activation failed: unable to determine device ID. Run \`${ACTIVATE_COMMAND}\` in your terminal.`);
    return;
  }

  credstore.setGhFallbackRetryAfter(0);
  const jwt = await credstore.trySilentGhActivate(deviceId);
  if (jwt) {
    addContext("SkillMeter activated via GitHub CLI.");
    return;
  }

  addContext(`Interactive GitHub login is required. Run \`${ACTIVATE_COMMAND}\` in your terminal.`);
}

main().catch((err) => {
  addContext(`Activation failed: ${err.message}. Run \`${ACTIVATE_COMMAND}\` in your terminal.`);
});

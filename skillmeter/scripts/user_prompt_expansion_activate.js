#!/usr/bin/env node
/**
 * Intercept direct `/skillmeter:activate` invocation before it expands into
 * a Claude prompt. Only silent gh-based activation runs here; interactive
 * GitHub device flow belongs in the `activate` shell command.
 */

const credstore = require("./credstore.js");

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

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
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
    block("SkillMeter is already activated.");
    return;
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    block("SkillMeter activation failed: unable to determine device ID. Run `activate` in your terminal.");
    return;
  }

  credstore.setGhFallbackRetryAfter(0);
  const jwt = await credstore.trySilentGhActivate(deviceId);
  if (jwt) {
    block("SkillMeter activated via GitHub CLI.");
    return;
  }

  block("Interactive GitHub login is required. Run `activate` in your terminal.");
}

main().catch((err) => {
  block(`SkillMeter activation failed: ${err.message}. Run \`activate\` in your terminal.`);
});

#!/usr/bin/env node
/**
 * Organization and repository choices for sign-in onboarding and the
 * telemetry list picker, with the same commands as the Claude Code plugin.
 * Output is JSON on stdout; errors go to stderr as `SkillMeter: CODE: message`
 * with exit code 1.
 * Usage: node scripts/repository_telemetry.js list
 *        node scripts/repository_telemetry.js toggle REVISION KEY... [--acknowledge-machine-scope]
 *        node scripts/repository_telemetry.js onboard REVISION ORG enabled|disabled [KEY...] [--acknowledge-machine-scope]
 *        node scripts/repository_telemetry.js org REVISION ORG enabled|disabled [--acknowledge-machine-scope]
 * REVISION is the `revision` from the latest list (`absent` before the first choice).
 */

const USAGE = "usage: repository_telemetry.js list | toggle REVISION KEY... [--acknowledge-machine-scope] | onboard REVISION ORG enabled|disabled [KEY...] [--acknowledge-machine-scope] | org REVISION ORG enabled|disabled [--acknowledge-machine-scope]";
const error = (code, message) => Object.assign(new Error(message), { code });

function parseWrite(action, args) {
  const acknowledged = args.includes("--acknowledge-machine-scope");
  const rest = args.filter(arg => arg !== "--acknowledge-machine-scope");
  const revisionArg = rest.shift();
  if (revisionArg !== "absent" && !/^(0|[1-9][0-9]*)$/.test(revisionArg || "")) throw error("INVALID_ARGUMENTS", USAGE);
  const expectedRevision = revisionArg === "absent" ? null : Number(revisionArg);
  if (action === "toggle") {
    if (!rest.length) throw error("INVALID_ARGUMENTS", USAGE);
    return { action, expectedRevision, keys: rest, acknowledged };
  }
  const [organization, setting, ...keys] = rest;
  if (!organization || !["enabled", "disabled"].includes(setting)) throw error("INVALID_ARGUMENTS", USAGE);
  if (action === "org" && keys.length) throw error("INVALID_ARGUMENTS", USAGE);
  return { action, expectedRevision, organization, enabled: setting === "enabled", keys, acknowledged };
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!["list", "toggle", "onboard", "org"].includes(action)) throw error("INVALID_ARGUMENTS", USAGE);
  if (action === "list") {
    if (args.length) throw error("INVALID_ARGUMENTS", USAGE);
    const { loadInventory } = require("./lib/repository-inventory");
    process.stdout.write(JSON.stringify(loadInventory().inventory) + "\n");
    return;
  }
  const { runConsentAction } = require("./lib/consent-actions");
  process.stdout.write(JSON.stringify(runConsentAction(parseWrite(action, args))) + "\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(`SkillMeter: ${err.code || "REPOSITORY_TELEMETRY_FAILED"}: ${err.message}\n`);
  process.exitCode = 1;
}

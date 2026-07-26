#!/usr/bin/env node

const {
  applyOnboardingSelection,
  applyRepositoryToggles,
  loadRepositoryTelemetryState,
  publicRepositoryState,
} = require("./lib/repository-telemetry");

function fail(message) {
  process.stderr.write(`SkillMeter: ${message}\n`);
  process.exit(1);
}

async function main() {
  const [action, ...args] = process.argv.slice(2);

  if (!["list", "toggle", "onboard"].includes(action)) {
    fail("usage: repository_telemetry.js <list|toggle|onboard> ...");
  }

  const state = await loadRepositoryTelemetryState();

  if (action === "list") {
    process.stdout.write(JSON.stringify(publicRepositoryState(state)) + "\n");
    return;
  }

  const [revisionArg, secondArg, thirdArg, ...remainingArgs] = args;
  const settingArg = action === "onboard" ? thirdArg : "";
  const orgArg = action === "onboard"
    ? String(secondArg || "").trim().toLowerCase()
    : "";
  const ids = action === "toggle"
    ? [secondArg, thirdArg, ...remainingArgs].filter(Boolean)
    : remainingArgs;
  const revision = Number(revisionArg);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (action === "toggle" && ids.length === 0) ||
    ids.some((id) => !/^[0-9a-f]{12}$/.test(id))
  ) {
    fail(`${action} requires a policy revision and one or more valid repository IDs.`);
  }
  if (
    action === "onboard" &&
    settingArg !== "enabled" &&
    settingArg !== "disabled"
  ) {
    fail(`${action} requires \`enabled\` or \`disabled\`.`);
  }
  if (action === "onboard") {
    const allowedOrgs = require("./credstore").getAllowedGitHubOrgs();
    if (!orgArg || !allowedOrgs.includes(orgArg)) {
      fail("onboarding organization is not present in the current valid license.");
    }
  }
  if (revision !== state.revision) {
    process.stdout.write(JSON.stringify({
      revision: state.revision,
      changed: 0,
      stale: true,
      results: [],
    }) + "\n");
    return;
  }

  const result = action === "onboard"
    ? applyOnboardingSelection(
        orgArg,
        ids,
        settingArg === "enabled",
        state
      )
    : applyRepositoryToggles(ids, state);
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch(() => fail("unable to manage repository telemetry."));

#!/usr/bin/env node

const {
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

  if (action !== "list" && action !== "toggle") {
    fail("usage: repository_telemetry.js <list|toggle REPOSITORY_ID...>");
  }

  const state = await loadRepositoryTelemetryState();

  if (action === "list") {
    process.stdout.write(JSON.stringify(publicRepositoryState(state)) + "\n");
    return;
  }

  if (args.length === 0 || args.some((id) => !/^[0-9a-f]{12}$/.test(id))) {
    fail("toggle requires one or more valid repository IDs.");
  }

  const result = applyRepositoryToggles(args, state);
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch(() => fail("unable to manage repository telemetry."));

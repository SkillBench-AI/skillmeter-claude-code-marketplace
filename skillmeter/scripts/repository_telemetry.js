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
    fail("usage: repository_telemetry.js <list|toggle REVISION REPOSITORY_ID...>");
  }

  const state = await loadRepositoryTelemetryState();

  if (action === "list") {
    process.stdout.write(JSON.stringify(publicRepositoryState(state)) + "\n");
    return;
  }

  const [revisionArg, ...ids] = args;
  const revision = Number(revisionArg);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    ids.length === 0 ||
    ids.some((id) => !/^[0-9a-f]{12}$/.test(id))
  ) {
    fail("toggle requires a policy revision and one or more valid repository IDs.");
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

  const result = applyRepositoryToggles(ids, state);
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch(() => fail("unable to manage repository telemetry."));

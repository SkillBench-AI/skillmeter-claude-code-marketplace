#!/usr/bin/env node

const path = require("path");
const { spawn } = require("child_process");

const {
  bindBackfillDataRoot,
} = require("./lib/backfill-data-root");

function loadRuntime() {
  return {
    credstore: require("./credstore"),
    backfillState: require("./lib/backfill-state"),
    loadRepositoryTelemetryState:
      require("./lib/repository-telemetry").loadRepositoryTelemetryState,
    appendBackfillLog: require("./lib/backfill-log").appendBackfillLog,
    transcriptReport: require("./lib/backfill-report").transcriptReport,
    pluginRoot: require("./lib/paths").PLUGIN_ROOT,
  };
}

function fail(message) {
  process.stderr.write(`SkillMeter: ${message}\n`);
  process.exit(1);
}

function spawnWorker(pluginRoot, offerId) {
  const script = path.join(pluginRoot, "scripts", "backfill_worker.js");
  const child = spawn(process.execPath, [script, offerId], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function validRepositoryIds(ids) {
  return ids.length > 0 && ids.every((id) => /^[0-9a-f]{12}$/.test(id));
}

async function accept(args, runtime) {
  const [offerId, revisionArg, orgArg, ...ids] = args;
  const revision = Number(revisionArg);
  const org = String(orgArg || "").trim().toLowerCase();
  if (
    !offerId ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !validRepositoryIds(ids)
  ) {
    fail(
      "accept requires OFFER_ID REVISION ORG and repository IDs."
    );
  }
  if (
    !runtime.credstore.hasValidLicense() ||
    !runtime.credstore.getAllowedGitHubOrgs().includes(org)
  ) {
    fail("the requested organization is not present in the current valid license.");
  }

  const repositoryState = await runtime.loadRepositoryTelemetryState();
  if (revision !== repositoryState.revision) {
    process.stdout.write(JSON.stringify({
      revision: repositoryState.revision,
      started: false,
      stale: true,
      results: [],
    }) + "\n");
    return;
  }

  const repositoriesById = new Map(
    repositoryState.repositories.map((repository) => [
      repository.id,
      repository,
    ])
  );
  const selected = [...new Set(ids)].map((id) => repositoriesById.get(id));
  if (selected.some((repository) => !repository || repository.org !== org)) {
    fail("one or more repositories are not eligible for this backfill action.");
  }

  const started = runtime.backfillState.beginBackfill(offerId, {
    org,
    repositoryIds: [...new Set(ids)],
    repositoryKeys: selected.map((repository) => repository.repoKey),
  });
  if (!started.started) fail("the backfill offer is no longer available.");

  const policyResult = {
    revision: repositoryState.revision,
    changed: 0,
    results: selected.map((repository) => ({
      id: repository.id,
      displayName: repository.displayName,
      changed: false,
      effective: repository.effective,
      reason: "historical_only",
    })),
  };
  try {
    const workerPid = spawnWorker(runtime.pluginRoot, offerId);
    runtime.appendBackfillLog("worker_spawned", {
      offerId,
      workerPid,
      org,
      repositoryCount: selected.length,
    });
    process.stdout.write(JSON.stringify({
      ...policyResult,
      started: true,
      status: "running",
      workerPid,
    }) + "\n");
  } catch (err) {
    runtime.backfillState.finishBackfill(offerId, "failed", {
      error: String(err?.message || err).slice(0, 240),
    });
    throw err;
  }
}

async function main() {
  const [action, lifecycleId, ...args] = process.argv.slice(2);
  if (
    !["claim", "manual-claim", "decline", "accept", "status"].includes(action) ||
    !bindBackfillDataRoot(lifecycleId || "")
  ) {
    fail("a valid backfill lifecycle ID is required.");
  }
  const runtime = loadRuntime();
  if (action === "claim" || action === "manual-claim") {
    const claimed = runtime.backfillState.claimBackfillOffer(args[0] || "", {
      manual: action === "manual-claim",
    });
    process.stdout.write(JSON.stringify({
      claimed: claimed.claimed,
      offerId: claimed.claimed ? claimed.state.offer_id : null,
      cutoffAt: claimed.claimed ? claimed.state.cutoff_at : null,
      status: claimed.state.status,
      reason: claimed.state.reason,
      lifecycleId: claimed.state.lifecycle_id,
    }) + "\n");
    return;
  }
  if (action === "decline") {
    const state = runtime.backfillState.markBackfillDeclined(args[0] || "");
    process.stdout.write(JSON.stringify({ status: state.status }) + "\n");
    return;
  }
  if (action === "accept") {
    await accept(args, runtime);
    return;
  }
  if (action === "status") {
    const state = runtime.backfillState.readBackfillState();
    process.stdout.write(JSON.stringify({
      lifecycleId: state.lifecycle_id,
      status: state.status,
      reason: state.reason,
      offerId: state.offer_id || null,
      transcripts: runtime.transcriptReport(state),
    }) + "\n");
    return;
  }
}

main().catch((err) => fail(err.message));

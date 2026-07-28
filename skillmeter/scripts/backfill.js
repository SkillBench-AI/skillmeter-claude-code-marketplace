#!/usr/bin/env node

const path = require("path");
const { spawn } = require("child_process");

const credstore = require("./credstore");
const {
  beginBackfill,
  claimBackfillOffer,
  finishBackfill,
  markBackfillDeclined,
  restoreClaimedOffer,
} = require("./lib/backfill-state");
const {
  applyOnboardingSelection,
  loadRepositoryTelemetryState,
} = require("./lib/repository-telemetry");
const { appendBackfillLog } = require("./lib/backfill-log");
const { PLUGIN_ROOT } = require("./lib/paths");
const telemetryStore = require("./lib/telemetry-store");

function fail(message) {
  process.stderr.write(`SkillMeter: ${message}\n`);
  process.exit(1);
}

function spawnWorker(offerId) {
  const script = path.join(PLUGIN_ROOT, "scripts", "backfill_worker.js");
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

async function accept(args) {
  const [offerId, revisionArg, orgArg, policyAction, ...ids] = args;
  const revision = Number(revisionArg);
  const org = String(orgArg || "").trim().toLowerCase();
  if (
    !offerId ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !["onboard", "preserve", "reauthorize"].includes(policyAction) ||
    !validRepositoryIds(ids)
  ) {
    fail(
      "accept requires OFFER_ID REVISION ORG " +
      "<onboard|preserve|reauthorize> and repository IDs."
    );
  }
  if (
    !credstore.hasValidLicense() ||
    !credstore.getAllowedGitHubOrgs().includes(org)
  ) {
    fail("the requested organization is not present in the current valid license.");
  }

  const repositoryState = await loadRepositoryTelemetryState();
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
  if (
    selected.some((repository) => !repository || repository.org !== org) ||
    (
      policyAction === "preserve" &&
      selected.some((repository) => repository.projectSetting !== "enabled")
    ) ||
    (
      policyAction === "reauthorize" &&
      selected.some((repository) => repository.projectSetting !== "enabled")
    )
  ) {
    fail("one or more repositories are not eligible for this backfill action.");
  }

  const started = beginBackfill(offerId, {
    org,
    repositoryIds: [...new Set(ids)],
  });
  if (!started.started) fail("the backfill offer is no longer available.");

  let policyResult = {
    revision: repositoryState.revision,
    changed: 0,
    results: selected.map((repository) => ({
      id: repository.id,
      displayName: repository.displayName,
      changed: false,
      effective: "enabled",
      reason: "preserved",
    })),
  };
  try {
    if (policyAction === "onboard") {
      policyResult = applyOnboardingSelection(org, ids, true, repositoryState);
      if (policyResult.stale) {
        restoreClaimedOffer(offerId);
        process.stdout.write(JSON.stringify({
          ...policyResult,
          started: false,
        }) + "\n");
        return;
      }
      if (!policyResult.organizationAuthorized) {
        throw new Error("Unable to apply onboarding selection.");
      }
    } else if (policyAction === "reauthorize") {
      credstore.setOrgTelemetryConsent(org, true);
      policyResult.revision = telemetryStore.getPolicyRevision();
    }

    const workerPid = spawnWorker(offerId);
    appendBackfillLog("worker_spawned", {
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
    finishBackfill(offerId, "failed", {
      error: String(err?.message || err).slice(0, 240),
    });
    throw err;
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === "claim") {
    const claimed = claimBackfillOffer(args[0] || "");
    process.stdout.write(JSON.stringify({
      claimed: claimed.claimed,
      offerId: claimed.claimed ? claimed.state.offer_id : null,
      cutoffAt: claimed.claimed ? claimed.state.cutoff_at : null,
      status: claimed.state.status,
    }) + "\n");
    return;
  }
  if (action === "decline") {
    const state = markBackfillDeclined(args[0] || "");
    process.stdout.write(JSON.stringify({ status: state.status }) + "\n");
    return;
  }
  if (action === "accept") {
    await accept(args);
    return;
  }
  fail("usage: backfill.js <claim [SESSION_ID]|decline OFFER_ID|accept ...>");
}

main().catch((err) => fail(err.message));

#!/usr/bin/env node

const {
  finishBackfill,
  readBackfillState,
  updateBackfillProgress,
} = require("./lib/backfill-state");
const { scanHistoricalSessions } = require("./lib/backfill-scan");
const { prepareHistoricalRecords } = require("./lib/backfill-snapshot");
const {
  loadRepositoryTelemetryState,
} = require("./lib/repository-telemetry");
const {
  spawnDetachedDrain,
  stageTranscriptSnapshot,
} = require("./lib/transfer");
const credstore = require("./credstore");

async function main() {
  const offerId = process.argv[2] || "";
  const state = readBackfillState();
  if (
    !offerId ||
    !state ||
    state.status !== "running" ||
    state.offer_id !== offerId
  ) {
    return;
  }

  const repositoryState = await loadRepositoryTelemetryState();
  const repositoriesById = new Map(
    repositoryState.repositories.map((repository) => [
      repository.id,
      repository,
    ])
  );
  const selected = (state.repository_ids || [])
    .map((id) => repositoriesById.get(id))
    .filter((repository) =>
      repository &&
      repository.org === state.org &&
      repository.projectSetting === "enabled" &&
      credstore.getOrgTelemetryConsent(repository.org) === true
    );
  if (selected.length !== (state.repository_ids || []).length) {
    throw new Error("Backfill repository scope changed before snapshotting.");
  }

  const repositoriesByKey = new Map(
    selected.map((repository) => [repository.repoKey, repository])
  );
  const scan = scanHistoricalSessions({
    allowedRepoKeys: new Set(repositoriesByKey.keys()),
    cutoffAt: state.cutoff_at,
    excludeSessionId: state.active_session_id || "",
  });

  let processed = 0;
  let queuedChunks = 0;
  let skipped = scan.skipped.length;
  const errors = [];

  for (const session of scan.included) {
    const repository = repositoriesByKey.get(session.repoKey);
    const result = stageTranscriptSnapshot(
      session.sessionFile,
      {
        repoKey: repository.repoKey,
        org: repository.org,
      },
      {
        transformRecords: prepareHistoricalRecords,
        cutoffAt: state.cutoff_at,
      }
    );
    if (result.failed) errors.push(result.reason || "snapshot_failed");
    else if (result.skipped) skipped++;
    else {
      processed++;
      queuedChunks += result.chunks;
    }
    updateBackfillProgress(offerId, {
      processed_transcripts: processed,
      queued_chunks: queuedChunks,
      skipped_transcripts: skipped,
    });
  }

  if (queuedChunks > 0) spawnDetachedDrain();
  finishBackfill(offerId, errors.length > 0 ? "failed" : "completed", {
    processed_transcripts: processed,
    queued_chunks: queuedChunks,
    skipped_transcripts: skipped,
    error: errors[0],
  });
}

const offerId = process.argv[2] || "";
main().catch((err) => {
  if (offerId) {
    try {
      finishBackfill(offerId, "failed", {
        error: "Backfill worker failed.",
      });
    } catch {}
  }
  process.exitCode = 1;
});

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
const { appendBackfillLog } = require("./lib/backfill-log");
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
  appendBackfillLog("worker_started", {
    offerId,
    org: state.org,
    repositoryCount: (state.repository_ids || []).length,
  });

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
  appendBackfillLog("scan_completed", {
    offerId,
    projectsScanned: scan.summary.projectsScanned,
    sessionsIncluded: scan.summary.sessionsIncluded,
    sessionsSkipped: scan.summary.sessionsSkipped,
    skippedByReason: scan.summary.skippedByReason,
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
        backfillOfferId: offerId,
      }
    );
    if (result.failed) errors.push(result.reason || "snapshot_failed");
    else if (result.skipped) skipped++;
    else {
      processed++;
      queuedChunks += result.chunks;
    }
    appendBackfillLog("snapshot_progress", {
      offerId,
      repository: repository.repoKey,
      transcriptId: session.sessionId,
      outcome: result.failed
        ? "failed"
        : result.skipped
          ? "skipped"
          : "queued",
      reason: result.reason,
      chunks: result.chunks || 0,
      processedTranscripts: processed,
      totalTranscripts: scan.included.length,
      queuedChunks,
      skippedTranscripts: skipped,
    });
    updateBackfillProgress(offerId, {
      processed_transcripts: processed,
      queued_chunks: queuedChunks,
      skipped_transcripts: skipped,
    });
  }

  const drainSpawned = queuedChunks > 0 ? spawnDetachedDrain() : false;
  appendBackfillLog("drain_requested", {
    offerId,
    queuedChunks,
    spawned: drainSpawned,
  });
  finishBackfill(offerId, errors.length > 0 ? "failed" : "completed", {
    processed_transcripts: processed,
    queued_chunks: queuedChunks,
    skipped_transcripts: skipped,
    error: errors[0],
  });
  appendBackfillLog(
    errors.length > 0 ? "worker_failed" : "snapshot_completed",
    {
      offerId,
      processedTranscripts: processed,
      queuedChunks,
      skippedTranscripts: skipped,
      error: errors[0],
    }
  );
}

const offerId = process.argv[2] || "";
main().catch((err) => {
  if (offerId) {
    appendBackfillLog("worker_failed", {
      offerId,
      error: String(err?.message || err),
    });
    try {
      finishBackfill(offerId, "failed", {
        error: "Backfill worker failed.",
      });
    } catch {}
  }
  process.exitCode = 1;
});

#!/usr/bin/env node

const fs = require("fs");

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
  announceBackfillFailure,
  settleBackfillDelivery,
} = require("./lib/backfill-delivery");
const {
  spawnDetachedDrain,
  stageTranscriptSnapshot,
} = require("./lib/transfer");

// The snapshot reads a transcript into memory whole; past this size it is
// skipped rather than risking the worker. One oversized or vanished file must
// not fail the whole run.
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

function snapshotGuard(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    return err?.code === "ENOENT"
      ? { skipped: true, reason: "missing", chunks: 0 }
      : null;
  }
  return size > MAX_SNAPSHOT_BYTES
    ? { skipped: true, reason: "too_large", chunks: 0 }
    : null;
}

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
  // Lets isBackfillRunning tell a dead worker from a slow one.
  updateBackfillProgress(offerId, { worker_pid: process.pid });

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
      (state.repository_keys || []).includes(repository.repoKey)
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
    const result = snapshotGuard(session.sessionFile) || stageTranscriptSnapshot(
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
  // The drain was spawned before the snapshot was marked finished, so it can
  // empty the queue while the state still says running and settle nothing.
  // Settling here too covers that ordering.
  try { settleBackfillDelivery(); } catch {}
  // A no-op unless the snapshot failed with nothing queued.
  try { announceBackfillFailure(offerId); } catch {}
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
    try { announceBackfillFailure(offerId); } catch {}
  }
  process.exitCode = 1;
});

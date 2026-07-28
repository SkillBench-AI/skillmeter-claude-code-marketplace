#!/usr/bin/env node
/**
 * Claude Code plugin monitor for the detached historical-backfill pipeline.
 *
 * The worker and HTTP drain remain detached. This process tails their shared
 * structured log and emits only meaningful lifecycle summaries to stdout,
 * where Claude Code delivers them as monitor notifications. The complete
 * event stream remains in logs/backfill.ndjson for detailed diagnostics.
 */

const fs = require("fs");
const path = require("path");

const {
  BACKFILL_LOG_FILE,
} = require("../lib/backfill-log");
const { readBackfillState } = require("../lib/backfill-state");

const POLL_INTERVAL_MS = 500;

function pendingBackfillChunks() {
  const logRoot = path.join(require("../lib/paths").LOG_DIR, "repositories");
  let count = 0;
  let repositoryDirs = [];
  try {
    repositoryDirs = fs.readdirSync(logRoot);
  } catch {
    return 0;
  }
  for (const repositoryDir of repositoryDirs) {
    const chunksDir = path.join(
      logRoot,
      repositoryDir,
      "transcripts",
      "chunks"
    );
    let files = [];
    try {
      files = fs.readdirSync(chunksDir)
        .filter((file) => file.endsWith(".meta.json"));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(chunksDir, file), "utf8")
        );
        if (meta.promptId === "backfill") count++;
      } catch {}
    }
  }
  return count;
}

function formatNotification(record) {
  if (!record || typeof record !== "object") return "";
  switch (record.event) {
    case "worker_spawned":
      return (
        `SkillMeter backfill worker started: pid ${record.workerPid}, ` +
        `${record.repositoryCount} repositories.`
      );
    case "scan_completed":
      return (
        `SkillMeter backfill scan: ${record.sessionsIncluded} sessions selected, ` +
        `${record.sessionsSkipped} skipped.`
      );
    case "snapshot_completed":
      return (
        `SkillMeter backfill snapshot complete: ${record.processedTranscripts} ` +
        `sessions, ${record.queuedChunks} upload chunks queued, ` +
        `${record.skippedTranscripts} skipped.`
      );
    case "upload_batch_completed":
      if ((record.uploaded || 0) === 0 && (record.failed || 0) === 0) {
        return "";
      }
      return (
        `SkillMeter backfill upload pass complete: ${record.uploaded} sent, ` +
        `${record.failed} failed, ${record.deferred} deferred.`
      );
    case "upload_failed":
      return (
        `SkillMeter backfill upload failed: ${record.repository || "repository"} ` +
        `${record.transcriptId || "transcript"} seq ${record.seq || 0}, ` +
        `${record.error || `HTTP ${record.httpStatus || "error"}`}.`
      );
    case "worker_failed":
      return `SkillMeter backfill worker failed: ${record.error || "unknown error"}.`;
    default:
      return "";
  }
}

function emit(message) {
  if (message) process.stdout.write(message + "\n");
}

function fileSize() {
  try {
    return fs.statSync(BACKFILL_LOG_FILE).size;
  } catch {
    return 0;
  }
}

function readFrom(offset) {
  let fd;
  try {
    const size = fileSize();
    if (size <= offset) return { offset: size, records: [] };
    fd = fs.openSync(BACKFILL_LOG_FILE, "r");
    const buffer = Buffer.alloc(size - offset);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const records = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    return { offset: size, records };
  } catch {
    return { offset, records: [] };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let offset = fileSize();
  const state = readBackfillState();
  const pending = pendingBackfillChunks();
  if (state?.status === "running") {
    emit(
      `SkillMeter backfill monitor attached: snapshot running, ${pending} upload chunks pending.`
    );
  } else if (pending > 0) {
    emit(`SkillMeter backfill monitor attached: ${pending} upload chunks pending.`);
  }

  while (true) {
    await sleep(POLL_INTERVAL_MS);
    const next = readFrom(offset);
    offset = next.offset;
    for (const record of next.records) {
      emit(formatNotification(record));
    }
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(
      `[skillmeter-backfill-monitor] ${err?.message || err}\n`
    );
    process.exit(1);
  });
}

module.exports = {
  formatNotification,
  pendingBackfillChunks,
  readFrom,
};

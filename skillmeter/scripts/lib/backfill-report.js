"use strict";

const fs = require("fs");

const { BACKFILL_LOG_FILE } = require("./backfill-log");

function readRecords() {
  try {
    return fs.readFileSync(BACKFILL_LOG_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function transcriptReport(state) {
  const transcripts = new Map();
  const offerId = state?.offer_id || "";

  for (const record of readRecords()) {
    if (
      record.offerId !== offerId ||
      typeof record.transcriptId !== "string" ||
      typeof record.repository !== "string"
    ) {
      continue;
    }
    const key = `${record.repository}\0${record.transcriptId}`;
    const transcript = transcripts.get(key) || {
      repository: record.repository,
      transcriptId: record.transcriptId,
      snapshot: "unknown",
      queuedChunks: 0,
      sentChunks: 0,
      failedAttempts: 0,
      deferredAttempts: 0,
    };
    if (record.event === "snapshot_progress") {
      transcript.snapshot = record.outcome || "unknown";
      transcript.queuedChunks = record.chunks || 0;
    } else if (record.event === "upload_succeeded") {
      transcript.sentChunks++;
    } else if (record.event === "upload_failed") {
      transcript.failedAttempts++;
    } else if (record.event === "upload_deferred") {
      transcript.deferredAttempts++;
    }
    transcripts.set(key, transcript);
  }

  return [...transcripts.values()]
    .map((transcript) => ({
      ...transcript,
      status:
        transcript.queuedChunks > 0 &&
        transcript.sentChunks >= transcript.queuedChunks
          ? "sent"
          : transcript.snapshot,
    }))
    .sort((left, right) =>
      left.repository.localeCompare(right.repository) ||
      left.transcriptId.localeCompare(right.transcriptId)
    );
}

module.exports = {
  transcriptReport,
};

#!/usr/bin/env node
/**
 * Tail detached backfill diagnostics. Each stdout line becomes a Claude
 * notification, so stdout carries only a worker failure; progress stays quiet
 * and the finished import is announced once through the backfill-result.json
 * FileChanged hook. Upload detail goes to stderr, which also avoids
 * notification-driven Stop/upload retry loops. The full local event stream
 * remains in logs/backfill.ndjson.
 */

const fs = require("fs");

const {
  BACKFILL_LOG_FILE,
} = require("../lib/backfill-log");

const POLL_INTERVAL_MS = 500;

function formatNotification(record) {
  if (!record || typeof record !== "object") return "";
  if (record.event === "worker_failed") {
    const error = String(record.error || "unknown error").replace(/\.$/, "");
    return `SkillMeter history import failed: ${error}.`;
  }
  return "";
}

/**
 * The stderr counterpart: repeating, per-attempt detail that is useful when
 * diagnosing a stuck queue but must never reach the session as a notification.
 */
function formatDiagnostic(record) {
  if (!record || typeof record !== "object") return "";
  switch (record.event) {
    case "upload_failed":
      return (
        `upload failed: ${record.repository || "repository"} ` +
        `${record.transcriptId || "transcript"} seq ${record.seq || 0}` +
        (record.attempts ? ` attempt ${record.attempts}` : "") +
        `, ${record.error || `HTTP ${record.httpStatus || "error"}`}`
      );
    case "upload_deferred":
      return (
        `upload deferred: ${record.repository || "repository"} ` +
        `seq ${record.seq || 0}, ${record.reason || "unknown reason"}`
      );
    case "upload_abandoned":
      return (
        `upload set aside: ${record.repository || "repository"} ` +
        `seq ${record.seq || 0} after ${record.attempts || 0} attempts, ` +
        `${record.error || `HTTP ${record.httpStatus || "error"}`}`
      );
    default:
      return "";
  }
}

function emit(message) {
  if (message) process.stdout.write(message + "\n");
}

function emitDiagnostic(message) {
  if (message) process.stderr.write(`[skillmeter-backfill-monitor] ${message}\n`);
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

  while (true) {
    await sleep(POLL_INTERVAL_MS);
    const next = readFrom(offset);
    offset = next.offset;
    for (const record of next.records) {
      emit(formatNotification(record));
      emitDiagnostic(formatDiagnostic(record));
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
  formatDiagnostic,
  formatNotification,
};

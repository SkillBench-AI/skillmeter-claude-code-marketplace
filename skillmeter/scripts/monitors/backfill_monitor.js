#!/usr/bin/env node
/**
 * Tail detached backfill diagnostics. Emit bounded lifecycle and quarantine
 * notices on stdout; each line becomes a Claude notification. Send per-attempt
 * errors to stderr to avoid notification-driven Stop/upload retry loops.
 * The full local event stream remains in logs/backfill.ndjson.
 *
 * The process lives only as long as there is a backfill to report on, so the
 * task panel lists it when one is happening and not otherwise. `monitors.json`
 * arms it at session start for a backfill already in progress, and on
 * `/skillmeter:signin` and `/skillmeter:backfill` for one about to start.
 */

const fs = require("fs");
const path = require("path");

const {
  BACKFILL_LOG_FILE,
} = require("../lib/backfill-log");
const {
  RUNNING_STALE_MS,
  readBackfillState,
} = require("../lib/backfill-state");
const { getBackfillOfferGraceMs } = require("../lib/config");
const { LOG_DIR } = require("../lib/paths");
const credstore = require("../credstore");

const POLL_INTERVAL_MS = 500;
// A skill arms its monitors the moment it is dispatched, but the offer only
// exists once the model has run `backfill.js claim` and the user has answered
// the question. Nothing is in flight in between, so an instance armed by a
// skill waits this long for a backfill to appear before concluding that the
// skill run was not one (`/skillmeter:backfill status`, a declined sign-in).
const OFFER_GRACE_MS = getBackfillOfferGraceMs();
// A chunk is deleted on its 2xx before the batch it belonged to is logged.
// Settling over a few polls keeps the exit from landing between the two and
// swallowing the last upload notification.
const IDLE_SETTLE_MS = 3_000;
// Only one instance tails the log: the others would repeat every notification,
// and a repeated notification re-invokes the session, whose Stop hook spawns
// another drain. The holder is identified by the pid inside the file.
const LOCK_FILE = path.join(LOG_DIR, ".backfill-monitor.lock");

/**
 * Backfill chunks still queued for upload. `limit` stops the sweep as soon as
 * that many are found: the in-flight check runs on the 500 ms poll, against
 * the directory the drain is writing, and only needs to know whether any exist.
 */
function pendingBackfillChunks(limit = Infinity) {
  const logRoot = path.join(LOG_DIR, "repositories");
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
        if (meta.promptId === "backfill" && ++count >= limit) return count;
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
    // Terminal, and therefore safe to announce: a chunk reports this once, when
    // its retry budget runs out and it is set aside. `upload_failed` is the
    // per-attempt event and belongs on stderr (see formatDiagnostic).
    case "upload_abandoned":
      return (
        `SkillMeter backfill gave up on 1 upload chunk after ` +
        `${record.attempts || 0} attempts ` +
        `(${record.repository || "repository"} seq ${record.seq || 0}, ` +
        `${record.error || `HTTP ${record.httpStatus || "error"}`}); ` +
        `it is set aside, not lost.`
      );
    case "worker_failed":
      return `SkillMeter backfill worker failed: ${record.error || "unknown error"}.`;
    default:
      return "";
  }
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

/**
 * Whether the queue could drain at all. Three of the four ways an upload
 * defers without recording an attempt are this one local read — the global
 * kill-switch, a missing license, an org not authorized — and sign-out is the
 * fourth. A backend that is merely failing needs no gate: those attempts are
 * recorded, and the retry budget quarantines the chunk.
 */
function queueCanDrain() {
  try {
    return !credstore.getSignedOut() &&
      credstore.isTelemetryTransmissionAllowed("");
  } catch {
    return true;
  }
}

/**
 * Whether any part of a backfill is still outstanding. Neither the lifecycle
 * status nor the queue answers this alone: `claim` parks the lifecycle in
 * declined/offer_consumed while the user decides, and the detached drain keeps
 * uploading after the worker has already marked the snapshot complete.
 */
function backfillInFlight() {
  const state = readBackfillState();
  // Compared here rather than through isBackfillRunning(), which marks a stale
  // worker failed. Polling twice a second, this process would be the first to
  // cross that threshold and would fail a worker still in its pre-heartbeat
  // scan, then exit on the strength of its own write.
  const fresh = !!state && Date.now() - state.updated_at < RUNNING_STALE_MS;
  if (state?.status === "running" && fresh) return true;
  if (state?.status === "declined" && state.reason === "offer_consumed" && fresh) {
    return true;
  }
  return pendingBackfillChunks(1) > 0 && queueCanDrain();
}

// The file descriptor while this process owns LOCK_FILE; null when it does not,
// which includes running deliberately without one.
let monitorLock = null;

function lockOwnerPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function ownsMonitorLock() {
  return lockOwnerPid() === process.pid;
}

function lockOwnerAlive() {
  const pid = lockOwnerPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else.
    return err?.code === "EPERM";
  }
}

/** True to go on tailing: either this process took the lock, or there is none
 *  to take and running without it beats not running at all. */
function acquireMonitorLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      monitorLock = fs.openSync(LOCK_FILE, "wx", 0o600);
      fs.writeSync(monitorLock, `${process.pid}\n`);
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        // Not contention. EACCES or ENOSPC must not read as "someone else is
        // reporting" and retire the monitor in silence.
        emitDiagnostic(
          `lock unavailable (${err?.code || err?.message}); tailing without one`
        );
        return true;
      }
      // Stand down only while the recorded holder is alive, whatever the
      // file's age says: a holder stalled by machine sleep still owns it. A
      // dead holder's lock is reclaimed now rather than after a timeout.
      if (lockOwnerAlive()) return false;
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }
  return false;
}

function releaseMonitorLock() {
  if (monitorLock === null) return;
  try { fs.closeSync(monitorLock); } catch {}
  // Never unlink a lock this process no longer owns: it belongs to whoever
  // took over, and removing it would let a third instance in.
  if (ownsMonitorLock()) {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
  monitorLock = null;
}

/**
 * Known limitation: the host arms an `on-skill-invoke` monitor only the FIRST
 * time that skill is dispatched in a session, and re-arming is deduped by name
 * for the session's lifetime whether or not the process is still alive. Now
 * that this one exits, a second invoke of the same skill in the same session
 * arms nothing — so a backfill accepted on that second invoke runs unmonitored
 * until the next session. Its uploads are unaffected; only the notifications
 * are missed. Starting a monitor from `backfill.js accept`, the way that path
 * already spawns its drain, would close it.
 */
async function main(argv = process.argv.slice(2)) {
  const awaitOffer = argv.includes("--await-offer");
  // Armed at session start with nothing happening: leave before the task panel
  // can advertise a backfill that does not exist.
  if (!awaitOffer && !backfillInFlight()) return;

  // Another live instance is already tailing the same log for this backfill.
  if (!acquireMonitorLock()) return;

  try {
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

    const startedAt = Date.now();
    let sawBackfill = false;
    let idleSince = 0;
    while (true) {
      await sleep(POLL_INTERVAL_MS);
      // Taken over while this process was stalled: stop before emitting a line
      // the new holder is emitting too.
      if (monitorLock !== null && !ownsMonitorLock()) break;
      const next = readFrom(offset);
      offset = next.offset;
      for (const record of next.records) {
        emit(formatNotification(record));
        emitDiagnostic(formatDiagnostic(record));
      }
      if (backfillInFlight()) {
        sawBackfill = true;
        idleSince = 0;
        continue;
      }
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince < IDLE_SETTLE_MS) continue;
      // Finished or declined; or, for an instance still waiting on an offer
      // that never arrived, the skill run was not a backfill after all.
      if (sawBackfill || !awaitOffer) break;
      if (Date.now() - startedAt >= OFFER_GRACE_MS) break;
    }
  } finally {
    releaseMonitorLock();
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    releaseMonitorLock();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    releaseMonitorLock();
    process.stderr.write(
      `[skillmeter-backfill-monitor] ${err?.message || err}\n`
    );
    process.exit(1);
  });
}

module.exports = {
  backfillInFlight,
  formatDiagnostic,
  formatNotification,
  pendingBackfillChunks,
};

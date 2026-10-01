/**
 * Decide when an accepted historical backfill has finished uploading and
 * announce it once.
 *
 * Completion is read from the queue on disk rather than from counters: a
 * process that dies between an acknowledged upload and a counter update would
 * otherwise leave the import unfinished forever. A chunk is settled when it
 * leaves the queue or exhausts its retries (the pair carries the quarantine
 * suffix). Leaving the queue does not mean it was sent: a chunk whose offer is
 * no longer authorized, or that aged out, is deleted unsent. So the notice
 * counts sent chunks from the backend acknowledgements in the backfill log.
 */

const fs = require("fs");
const path = require("path");

const { atomicWriteJson, safeReadJson } = require("./io");
const { BACKFILL_RESULT_FILE, REPOSITORIES_LOG_DIR } = require("./paths");
const { QUARANTINE_SUFFIX } = require("./chunk-retry");
const { appendBackfillLog } = require("./backfill-log");
const { sentChunkCount } = require("./backfill-report");
const {
  markBackfillDelivered,
  readBackfillState,
} = require("./backfill-state");

const META_SUFFIX = ".meta.json";
const SET_ASIDE_SUFFIX = `${META_SUFFIX}${QUARANTINE_SUFFIX}`;
// Kept beside the sentinel and never watched, so writing it cannot re-fire
// the FileChanged hook.
const NOTIFIED_MARKER = path.join(
  path.dirname(BACKFILL_RESULT_FILE),
  ".backfill-notified"
);

function countBackfillChunks(offerId) {
  const counts = { pending: 0, setAside: 0 };
  let repositoryDirs = [];
  try {
    repositoryDirs = fs.readdirSync(REPOSITORIES_LOG_DIR);
  } catch {
    return counts;
  }
  for (const repositoryDir of repositoryDirs) {
    const chunksDir = path.join(
      REPOSITORIES_LOG_DIR,
      repositoryDir,
      "transcripts",
      "chunks"
    );
    let files = [];
    try {
      files = fs.readdirSync(chunksDir);
    } catch {
      continue;
    }
    for (const file of files) {
      let bucket;
      if (file.endsWith(SET_ASIDE_SUFFIX)) {
        bucket = "setAside";
      } else if (file.endsWith(META_SUFFIX)) {
        // The drain ignores a sidecar without its body; so does completion.
        const body = file.slice(0, -META_SUFFIX.length) + ".jsonl";
        if (!fs.existsSync(path.join(chunksDir, body))) continue;
        bucket = "pending";
      } else {
        continue;
      }
      const meta = safeReadJson(path.join(chunksDir, file), null);
      if (meta?.promptId === "backfill" && meta.backfillOfferId === offerId) {
        counts[bucket]++;
      }
    }
  }
  return counts;
}

/**
 * Record delivery and write the sentinel when the snapshot has finished and no
 * chunk of the offer is still queued. Returns the result on the one call that
 * settles, otherwise null. Callers treat it as best-effort.
 */
function settleBackfillDelivery() {
  const state = readBackfillState();
  if (
    !state ||
    !["completed", "failed"].includes(state.status) ||
    !state.completed_at ||
    state.delivered_at ||
    !state.offer_id ||
    !(state.queued_chunks > 0)
  ) {
    return null;
  }
  // After the snapshot finishes no chunk is added for this offer, so the
  // pending count can only fall; a zero read cannot be undone by a later write.
  const counts = countBackfillChunks(state.offer_id);
  if (counts.pending > 0) return null;

  const marked = markBackfillDelivered(state.offer_id, {
    set_aside_chunks: counts.setAside,
  });
  if (!marked.delivered) return null;

  const queuedChunks = marked.state.queued_chunks || 0;
  const sentChunks = Math.min(sentChunkCount(state.offer_id), queuedChunks);
  const result = {
    status: "delivered",
    offerId: state.offer_id,
    sessions: marked.state.processed_transcripts || 0,
    queuedChunks,
    sentChunks,
    // Set aside after exhausting retries, or deleted unsent.
    unsentChunks: queuedChunks - sentChunks,
    setAsideChunks: counts.setAside,
    ts: marked.state.delivered_at,
  };
  atomicWriteJson(BACKFILL_RESULT_FILE, result);
  appendBackfillLog("delivery_completed", {
    offerId: result.offerId,
    sessions: result.sessions,
    queuedChunks: result.queuedChunks,
    sentChunks: result.sentChunks,
    unsentChunks: result.unsentChunks,
    setAsideChunks: result.setAsideChunks,
  });
  return result;
}

/**
 * Announce a failed import, but only one that queued nothing. When chunks were
 * queued they still upload, and the delivery notice reports the result; a
 * failure notice first would contradict it.
 */
function announceBackfillFailure(offerId) {
  const state = readBackfillState();
  if (
    !state ||
    state.status !== "failed" ||
    state.offer_id !== offerId ||
    state.queued_chunks > 0 ||
    safeReadJson(BACKFILL_RESULT_FILE, null)?.offerId === offerId
  ) {
    return null;
  }
  const result = { status: "failed", offerId, ts: Date.now() };
  atomicWriteJson(BACKFILL_RESULT_FILE, result);
  return result;
}

// SessionStart registers the sentinel in watchPaths, which needs it to exist.
function ensureBackfillResultFile() {
  if (fs.existsSync(BACKFILL_RESULT_FILE)) return;
  try {
    atomicWriteJson(BACKFILL_RESULT_FILE, { status: "none" });
  } catch {}
}

/**
 * The tenant dashboard shares the meter host minus its `meter` label:
 * `https://acme.meter.skillbench.ai` -> `https://acme.skillbench.ai`. Anything
 * else gets no link rather than a guessed one.
 */
function dashboardUrlFromAudiences(audiences) {
  for (const audience of audiences || []) {
    let url;
    try {
      url = new URL(audience);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const labels = url.hostname.split(".");
    if (labels.length < 4 || labels[1] !== "meter") continue;
    return `https://${[labels[0], ...labels.slice(2)].join(".")}`;
  }
  return null;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function formatBackfillNotice(result, dashboardUrl) {
  // The stored error text can carry local paths, so it is never shown here.
  if (result?.status === "failed") {
    return {
      message:
        "SkillMeter: history import failed before anything was sent. " +
        "Run /skillmeter:backfill to try again.",
      desktop: "History import failed",
    };
  }
  if (!result || result.status !== "delivered") return null;
  const sessions = result.sessions || 0;
  // A result written before sent chunks were counted knows only set-aside ones.
  const unsent = Number.isFinite(result.unsentChunks)
    ? result.unsentChunks
    : result.setAsideChunks || 0;
  if (unsent > 0) {
    return {
      message:
        `SkillMeter: history import finished: ${plural(sessions, "session")} processed, ` +
        `${plural(unsent, "upload chunk")} could not be sent. ` +
        "Run /skillmeter:backfill status for details.",
      desktop: `History import finished: ${plural(unsent, "upload chunk")} could not be sent`,
    };
  }
  const summary = `history import complete: ${plural(sessions, "session")} sent`;
  return {
    message:
      `SkillMeter: ${summary}.` +
      (dashboardUrl ? ` Open SkillMeter: ${dashboardUrl}` : ""),
    desktop: `History import complete: ${plural(sessions, "session")} sent`,
  };
}

/**
 * Return the notice for a settled import that has not been shown yet, and mark
 * it shown. Both the FileChanged hook and SessionStart call this, so an import
 * that finished while no session was open is announced at the next start.
 */
function takeBackfillNotice({ audiences = [] } = {}) {
  const result = safeReadJson(BACKFILL_RESULT_FILE, null);
  const notice = formatBackfillNotice(result, dashboardUrlFromAudiences(audiences));
  if (!notice) return null;
  let lastTs = null;
  try {
    lastTs = Number(fs.readFileSync(NOTIFIED_MARKER, "utf8")) || null;
  } catch {}
  if (result.ts && result.ts === lastTs) return null;
  try {
    fs.writeFileSync(NOTIFIED_MARKER, String(result.ts || ""), { mode: 0o600 });
  } catch {}
  return notice;
}

module.exports = {
  BACKFILL_RESULT_FILE,
  announceBackfillFailure,
  countBackfillChunks,
  dashboardUrlFromAudiences,
  ensureBackfillResultFile,
  formatBackfillNotice,
  settleBackfillDelivery,
  takeBackfillNotice,
};

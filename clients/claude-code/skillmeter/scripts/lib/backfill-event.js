/**
 * The BackfillCompleted event: one per accepted history import, telling the
 * backend how the import ended once nothing is left to send.
 *
 * It carries counts and identifiers only, never transcript content, local
 * paths or error text. It is queued here and sent by the drain under the
 * import's own consent and tenant, like the import's chunks.
 */

const fs = require("fs");
const path = require("path");

const { safeReadJson } = require("./io");
const { LOG_DIR } = require("./paths");

const EVENT_NAME = "BackfillCompleted";
const BACKFILL_EVENT_DIR = path.join(LOG_DIR, "backfill-events");
const OFFER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const OUTCOMES = Object.freeze({
  // Every queued chunk was acknowledged, or there was nothing to import.
  SUCCESS: "success",
  // Some chunks were acknowledged, but not all, or some sessions could not
  // be snapshotted.
  PARTIAL_SUCCESS: "partial_success",
  // Nothing was acknowledged.
  FAILED: "failed",
});

function classifyBackfillOutcome({
  snapshotFailed = false,
  queuedChunks = 0,
  sentChunks = 0,
} = {}) {
  if (queuedChunks === 0) {
    return snapshotFailed ? OUTCOMES.FAILED : OUTCOMES.SUCCESS;
  }
  if (sentChunks === 0) return OUTCOMES.FAILED;
  if (sentChunks < queuedChunks || snapshotFailed) return OUTCOMES.PARTIAL_SUCCESS;
  return OUTCOMES.SUCCESS;
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function eventPath(offerId) {
  return path.join(BACKFILL_EVENT_DIR, `${offerId}.json`);
}

/**
 * Queue the event for a settled import, once per offer: a second call for the
 * same offer is a no-op. `counts` comes from the delivery result when chunks
 * were queued; without it nothing was queued.
 */
function queueBackfillCompleted(state, deviceId, counts = {}) {
  const offerId = state?.offer_id;
  if (!OFFER_ID_RE.test(offerId || "") || !deviceId) return null;
  const file = eventPath(offerId);
  if (fs.existsSync(file)) return null;

  const snapshotFailed = state.status === "failed";
  const queuedChunks = counts.queuedChunks ?? state.queued_chunks ?? 0;
  const sentChunks = Math.min(counts.sentChunks ?? 0, queuedChunks);
  const outcome = classifyBackfillOutcome({ snapshotFailed, queuedChunks, sentChunks });
  const event = {
    timestamp: new Date().toISOString(),
    level: outcome === OUTCOMES.SUCCESS ? "info" : "warn",
    hook_event_name: EVENT_NAME,
    // The import is the unit the backend groups by.
    session_id: offerId,
    device_id: deviceId,
    data: {
      offer_id: offerId,
      outcome,
      // A category, never the stored error text, which can carry local paths.
      reason: outcome === OUTCOMES.SUCCESS
        ? null
        : snapshotFailed
          ? "snapshot_failed"
          : "chunks_unsent",
      sessions: state.processed_transcripts || 0,
      skipped_sessions: state.skipped_transcripts || 0,
      repositories: Array.isArray(state.repository_keys) ? state.repository_keys.length : 0,
      queued_chunks: queuedChunks,
      sent_chunks: sentChunks,
      unsent_chunks: queuedChunks - sentChunks,
      set_aside_chunks: counts.setAsideChunks || 0,
      manual: state.manual_trigger === true,
      cutoff_at: iso(state.cutoff_at),
      completed_at: iso(state.completed_at),
    },
  };
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(BACKFILL_EVENT_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ offerId, org: state.org || "", event }), { mode: 0o600 });
    // A hard link fails when the name exists, so two settling processes cannot
    // both queue it, and the drain never sees a half-written file.
    fs.linkSync(tmp, file);
    return event;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function listBackfillEvents() {
  try {
    return fs.readdirSync(BACKFILL_EVENT_DIR)
      .filter((name) => /\.json$/.test(name))
      .map((name) => path.join(BACKFILL_EVENT_DIR, name));
  } catch {
    return [];
  }
}

function readBackfillEvent(file) {
  const entry = safeReadJson(file, null);
  if (!entry?.event || !OFFER_ID_RE.test(entry.offerId || "")) return null;
  return entry;
}

module.exports = {
  BACKFILL_EVENT_DIR,
  EVENT_NAME,
  OUTCOMES,
  classifyBackfillOutcome,
  listBackfillEvents,
  queueBackfillCompleted,
  readBackfillEvent,
};

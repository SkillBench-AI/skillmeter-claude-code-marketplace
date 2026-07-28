/**
 * Small installation-lifecycle state machine for the one-time transcript
 * backfill offer. The lifecycle file lives in CLAUDE_PLUGIN_DATA, so updates
 * preserve it while a normal final-scope uninstall removes it.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { STATE_DIR } = require("./config");
const { atomicWriteJson, safeReadJson } = require("./io");
const {
  BACKFILL_STATE_FILE: PLUGIN_DATA_BACKFILL_STATE_FILE,
} = require("./paths");

const SCHEMA_VERSION = 1;
// Direct Node runs and older Claude Code versions do not provide
// CLAUDE_PLUGIN_DATA. Keep their state out of the plugin source/cache tree.
const BACKFILL_STATE_FILE = process.env.CLAUDE_PLUGIN_DATA
  ? PLUGIN_DATA_BACKFILL_STATE_FILE
  : path.join(STATE_DIR, "backfill-state.json");
const LOCK_FILE = `${BACKFILL_STATE_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
const RUNNING_STALE_MS = 30 * 60_000;
const VALID_STATUSES = new Set([
  "pending",
  "declined",
  "running",
  "completed",
  "failed",
]);
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nowMs() {
  return Date.now();
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.schema_version !== SCHEMA_VERSION) return null;
  if (!VALID_STATUSES.has(raw.status)) return null;
  return raw;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return fs.openSync(LOCK_FILE, "wx", 0o600);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        if (nowMs() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {}
      sleepSync(10);
    }
  }
  throw new Error("Backfill state is busy.");
}

function withLock(callback) {
  const fd = acquireLock();
  try {
    return callback();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

function createLifecycleState() {
  const state = {
    schema_version: SCHEMA_VERSION,
    lifecycle_id: crypto.randomUUID(),
    status: "pending",
    reason: "one_time_offer",
    created_at: nowMs(),
    updated_at: nowMs(),
  };
  fs.mkdirSync(path.dirname(BACKFILL_STATE_FILE), {
    recursive: true,
    mode: 0o700,
  });
  try {
    const fd = fs.openSync(BACKFILL_STATE_FILE, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return state;
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    return normalizeState(safeReadJson(BACKFILL_STATE_FILE, null));
  }
}

function initializeBackfillLifecycle() {
  return withLock(() => {
    let state = normalizeState(safeReadJson(BACKFILL_STATE_FILE, null));
    if (!state) state = createLifecycleState();
    if (!state) throw new Error("Unable to initialize backfill lifecycle.");
    return state;
  });
}

function readBackfillState() {
  return normalizeState(safeReadJson(BACKFILL_STATE_FILE, null));
}

function mutateBackfillState(mutator) {
  initializeBackfillLifecycle();
  return withLock(() => {
    const current = normalizeState(safeReadJson(BACKFILL_STATE_FILE, null));
    if (!current) throw new Error("Backfill lifecycle is unavailable.");
    const next = mutator({ ...current });
    if (!next) return current;
    next.schema_version = SCHEMA_VERSION;
    next.updated_at = nowMs();
    atomicWriteJson(BACKFILL_STATE_FILE, next);
    return next;
  });
}

function publicBackfillState() {
  const state = initializeBackfillLifecycle();
  return {
    eligible: state.status === "pending",
    status: state.status,
  };
}

function claimBackfillOffer(activeSessionId = "") {
  let claimed = false;
  const state = mutateBackfillState((state) => {
    if (state.status !== "pending") return null;
    claimed = true;
    return {
      ...state,
      status: "declined",
      reason: "offer_consumed",
      offer_id: crypto.randomUUID(),
      cutoff_at: nowMs(),
      active_session_id: SESSION_ID_RE.test(activeSessionId)
        ? activeSessionId
        : "",
    };
  });
  return { claimed, state };
}

function markBackfillDeclined(offerId, reason = "user_declined") {
  return mutateBackfillState((state) => {
    if (state.status !== "declined" || state.offer_id !== offerId) return null;
    return { ...state, reason };
  });
}

function beginBackfill(offerId, {
  org,
  repositoryIds,
} = {}) {
  let started = false;
  const state = mutateBackfillState((current) => {
    if (
      current.status !== "declined" ||
      current.reason !== "offer_consumed" ||
      current.offer_id !== offerId
    ) {
      return null;
    }
    started = true;
    return {
      ...current,
      status: "running",
      reason: "snapshotting",
      org,
      repository_ids: [...new Set(repositoryIds || [])],
      processed_transcripts: 0,
      queued_chunks: 0,
      skipped_transcripts: 0,
    };
  });
  return { started, state };
}

function restoreClaimedOffer(offerId, reason = "offer_consumed") {
  return mutateBackfillState((state) => {
    if (state.status !== "running" || state.offer_id !== offerId) return null;
    return {
      ...state,
      status: "declined",
      reason,
      error: undefined,
    };
  });
}

function updateBackfillProgress(offerId, progress) {
  return mutateBackfillState((state) => {
    if (state.status !== "running" || state.offer_id !== offerId) return null;
    return { ...state, ...progress };
  });
}

function finishBackfill(offerId, status, details = {}) {
  if (!["completed", "failed"].includes(status)) {
    throw new Error("Invalid terminal backfill status.");
  }
  return mutateBackfillState((state) => {
    if (state.status !== "running" || state.offer_id !== offerId) return null;
    return {
      ...state,
      ...details,
      status,
      reason: status === "completed" ? "snapshot_queued" : "snapshot_failed",
      completed_at: nowMs(),
    };
  });
}

function isBackfillRunning() {
  const state = readBackfillState();
  if (!state || state.status !== "running") return false;
  if (nowMs() - state.updated_at <= RUNNING_STALE_MS) return true;
  finishBackfill(state.offer_id, "failed", {
    error: "Backfill worker became stale.",
  });
  return false;
}

module.exports = {
  BACKFILL_STATE_FILE,
  RUNNING_STALE_MS,
  initializeBackfillLifecycle,
  readBackfillState,
  publicBackfillState,
  claimBackfillOffer,
  markBackfillDeclined,
  beginBackfill,
  restoreClaimedOffer,
  updateBackfillProgress,
  finishBackfill,
  isBackfillRunning,
};

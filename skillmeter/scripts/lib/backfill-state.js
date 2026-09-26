/**
 * Small installation-lifecycle state machine for the one-time transcript
 * backfill offer. The lifecycle file lives in CLAUDE_PLUGIN_DATA, so updates
 * preserve it while a normal final-scope uninstall removes it.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { atomicWriteJson, safeReadJson } = require("./io");
const { BACKFILL_STATE_FILE } = require("./paths");

const SCHEMA_VERSION = 1;
const LOCK_FILE = `${BACKFILL_STATE_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
const RUNNING_STALE_MS = 30 * 60_000;
// Earlier accepted offers whose queued chunks may still be uploading.
const MAX_PRIOR_OFFERS = 5;
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

// A present-but-unusable file (truncated by a crash, hand-edited) is moved
// aside and replaced; without this every sign-in and SessionStart fails on it.
// The replacement is `declined`, not a fresh one-time offer, but the manual
// backfill can still claim it. A file from a newer schema is left alone.
function recoverUnreadableState() {
  const raw = safeReadJson(BACKFILL_STATE_FILE, null);
  if (raw && Number(raw.schema_version) > SCHEMA_VERSION) {
    throw new Error("Backfill state was written by a newer SkillMeter version.");
  }
  try {
    fs.renameSync(BACKFILL_STATE_FILE, `${BACKFILL_STATE_FILE}.corrupt-${nowMs()}`);
  } catch {}
  const state = {
    schema_version: SCHEMA_VERSION,
    lifecycle_id: crypto.randomUUID(),
    status: "declined",
    reason: "state_recovered",
    created_at: nowMs(),
    updated_at: nowMs(),
  };
  atomicWriteJson(BACKFILL_STATE_FILE, state);
  return state;
}

function initializeBackfillLifecycle() {
  return withLock(() => {
    let state = normalizeState(safeReadJson(BACKFILL_STATE_FILE, null));
    if (state) return state;
    if (fs.existsSync(BACKFILL_STATE_FILE)) return recoverUnreadableState();
    state = createLifecycleState();
    if (!state) return recoverUnreadableState();
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
  initializeBackfillLifecycle();
  isBackfillRunning(); // demotes a dead or stale run before reporting it
  const state = readBackfillState() || initializeBackfillLifecycle();
  return {
    eligible: state.status === "pending",
    status: state.status,
    reason: state.reason,
    lifecycleId: state.lifecycle_id,
  };
}

function priorOffersOf(state) {
  const prior = Array.isArray(state.prior_offers) ? state.prior_offers : [];
  if (!state.upload_authorized || !state.offer_id) return prior;
  return [
    {
      offer_id: state.offer_id,
      org: state.org,
      repository_keys: state.repository_keys || [],
    },
    ...prior,
  ].slice(0, MAX_PRIOR_OFFERS);
}

function claimBackfillOffer(activeSessionId = "", { manual = false } = {}) {
  let claimed = false;
  isBackfillRunning(); // a dead run must not block the manual retry
  const state = mutateBackfillState((state) => {
    const manuallyRetryable =
      manual &&
      (
        state.status === "failed" ||
        state.status === "declined"
      );
    if (state.status !== "pending" && !manuallyRetryable) return null;
    claimed = true;
    return {
      ...state,
      status: "declined",
      reason: "offer_consumed",
      // Chunks the user already approved keep uploading under their offer;
      // the new offer is not authorized until it is accepted.
      prior_offers: priorOffersOf(state),
      upload_authorized: false,
      offer_id: crypto.randomUUID(),
      cutoff_at: nowMs(),
      active_session_id: SESSION_ID_RE.test(activeSessionId)
        ? activeSessionId
        : "",
      manual_trigger: manual,
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
  repositoryKeys,
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
      repository_keys: [...new Set(repositoryKeys || [])],
      upload_authorized: true,
      processed_transcripts: 0,
      queued_chunks: 0,
      skipped_transcripts: 0,
      // Otherwise settle sees the previous run's delivered_at and never
      // announces this one.
      completed_at: undefined,
      delivered_at: undefined,
      set_aside_chunks: undefined,
      error: undefined,
      worker_pid: undefined,
    };
  });
  return { started, state };
}

function isBackfillUploadAuthorized({
  offerId,
  org,
  repoKey,
} = {}) {
  const state = readBackfillState();
  if (!state || !offerId) return false;
  const current =
    state.upload_authorized === true &&
    state.offer_id === offerId &&
    state.org === org &&
    Array.isArray(state.repository_keys) &&
    state.repository_keys.includes(repoKey);
  if (current) return true;
  return (Array.isArray(state.prior_offers) ? state.prior_offers : []).some(
    (prior) =>
      prior &&
      prior.offer_id === offerId &&
      prior.org === org &&
      Array.isArray(prior.repository_keys) &&
      prior.repository_keys.includes(repoKey)
  );
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

// One-way transition, taken once, after the snapshot finished and no chunk of
// this offer is still waiting to upload. `status` keeps its snapshot meaning.
function markBackfillDelivered(offerId, details = {}) {
  let delivered = false;
  const state = mutateBackfillState((current) => {
    if (
      !["completed", "failed"].includes(current.status) ||
      current.offer_id !== offerId ||
      current.delivered_at
    ) {
      return null;
    }
    delivered = true;
    return { ...current, ...details, delivered_at: nowMs() };
  });
  return { delivered, state };
}

// A recorded worker pid that no longer exists means the worker died
// (OOM, SIGKILL, reboot); waiting out RUNNING_STALE_MS would only delay that.
function workerIsGone(state) {
  if (!Number.isInteger(state.worker_pid) || state.worker_pid <= 0) return false;
  try {
    process.kill(state.worker_pid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}

function isBackfillRunning() {
  const state = readBackfillState();
  if (!state || state.status !== "running") return false;
  const gone = workerIsGone(state);
  if (!gone && nowMs() - state.updated_at <= RUNNING_STALE_MS) return true;
  finishBackfill(state.offer_id, "failed", {
    error: gone ? "Backfill worker exited." : "Backfill worker became stale.",
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
  updateBackfillProgress,
  finishBackfill,
  markBackfillDelivered,
  isBackfillRunning,
  isBackfillUploadAuthorized,
};

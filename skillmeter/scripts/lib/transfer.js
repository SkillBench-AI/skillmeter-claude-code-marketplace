/**
 * Transport layer: repository-bound durable event/transcript queues, upload
 * retries, policy revalidation, and delivered-artifact cleanup.
 *
 * The filesystem is the source of truth. Hooks append to the active
 * `events.jsonl`, final-session hooks seal it to `events.jsonl.<ts>`, and a
 * detached drain (spawned by Stop, SessionEnd and SessionStart) uploads sealed
 * event logs plus queued transcript delta chunks, refreshing the license just
 * before it sends. Whatever a drain cannot send waits for the next one.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { spawn } = require("child_process");

const credstore = require("../credstore");
const { getEndpointFromTokenAllowExpired, isJwtExpired } = require("./jwt");
const { ensureFreshLicense } = require("./license-activation");
const { getEventTimeoutMs, getTranscriptChunkMaxBytes } = require("./config");
const { atomicWriteJson, safeReadJson } = require("./io");
const { appendBackfillLog } = require("./backfill-log");
const { settleBackfillDelivery } = require("./backfill-delivery");
const {
  MAX_UPLOAD_ATTEMPTS,
  QUARANTINE_SUFFIX,
  isChunkEligible,
  isChunkExhausted,
  quarantinePathFor,
  recordUploadFailure,
} = require("./chunk-retry");
const {
  parseJsonl,
  lastContentUuid,
  turnNumbers,
  turnDestinations,
  buildChunkPlan,
} = require("./transcript-delta");
const { getRepoScopeDecision } = require("./repo-scope");
const { hashHmac } = require("./sanitize");
const {
  PLUGIN_ROOT,
  LOG_DIR,
  PLUGIN_VERSION,
  repositoryQueuePaths,
  repositoryStorageId,
} = require("./paths");
const telemetryStore = require("./telemetry-store");
const {
  queueContextForRepository,
  listRepositoryQueueContexts,
  queueContextForPath,
  queueDisposition,
  purgeRepositoryQueue,
  purgeOrganizationQueues,
  purgeDisallowedQueues,
} = require("./repository-queue");
const {
  listOrganizationAuditQueueContexts,
  organizationAuditContextForPath,
  organizationAuditDisposition,
  clearOrganizationAuditPayloads,
  currentOrganizationAuditContext,
  purgeOrganizationAuditQueues,
  purgeDisallowedOrganizationAuditQueues,
} = require("./organization-audit-queue");
const { cleanupStaleSessionContexts } = require("./cwd-context");
const {
  backfillOfferTenant,
  isBackfillOfferAccepted,
  isBackfillRunning,
  isBackfillUploadAuthorized,
} = require("./backfill-state");
const { listBackfillEvents, readBackfillEvent } = require("./backfill-event");
const { currentTenantFingerprint, tenantFingerprint } = require("./tenant");

// Async gzip for transcript uploads — keeps the hook's event loop responsive
// while compressing multi-MB transcripts. Sync variants are still used for
// small event-log payloads where the latency is negligible.
const gzipAsync = promisify(zlib.gzip);

const EVENT_TIMEOUT = getEventTimeoutMs();
const TRANSCRIPT_TIMEOUT = 30_000;

// Delivered `.sent` event logs are retained briefly for diagnostics. A chunk
// still awaiting delivery is never age-deleted; policy OFF or a successful
// acknowledgement is required to remove it. The one exception is a chunk that
// spent its retry budget and was quarantined — it is no longer awaiting
// anything, and at a whole transcript slice each it cannot be kept forever.
const CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Unsent telemetry older than the license's 7-day refresh window is deleted
// (ADR 001, decision 3). Capture does not wait for a fresh token, so without
// this a device that can no longer sign in would keep it indefinitely; by
// then the token chain is dead and a new sign-in is required anyway.
const UNSENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DRAIN_ONCE_LOCK_FILE = path.join(LOG_DIR, ".drain-once.lock");
const DRAIN_ONCE_LOCK_STALE_MS = 30_000;
const QUEUE_DRAIN_LOCK_STALE_MS = 2 * 60_000;

function acquireQueueDrainLock(name) {
  const lockPath = path.join(LOG_DIR, `.${name}-drain.lock`);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > QUEUE_DRAIN_LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
    return { fd, lockPath };
  } catch {
    return null;
  }
}

// Uploads run a few at a time: a large historical import would otherwise
// start every chunk at once, share the bandwidth until they all time out, and
// spend every chunk's retry budget together.
const DRAIN_CONCURRENCY = 4;

// Run `fn` over `items` with at most `limit` in flight; results keep input
// order and have Promise.allSettled's shape. `onEach` runs after every item.
async function settleWithLimit(items, limit, fn, onEach = () => {}) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      onEach();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

// A drain longer than QUEUE_DRAIN_LOCK_STALE_MS would otherwise look
// abandoned, and a second drain would upload the same chunks again.
function touchQueueDrainLock(lock) {
  if (!lock) return;
  const now = new Date();
  try { fs.utimesSync(lock.lockPath, now, now); } catch {}
}

function releaseQueueDrainLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.lockPath); } catch {}
}

function idempotencyKey(repoKey, body) {
  return crypto.createHash("sha256")
    .update(repoKey)
    .update("\0")
    .update(body)
    .digest("hex");
}

/**
 * Upload an event log file to the backend via fetch + gzip.
 * On success (2xx), renames the file to `.sent`; on failure, leaves it for
 * the next drain.
 * @returns {Promise<void>}
 */
// Returns { ok } on success, { ok:false, error } on a real transmission failure
// (HTTP status / network), or { ok:false } for a precondition skip (no file,
// no token, no endpoint) — precondition skips carry no `error` so they aren't
// reported as send failures (the not-signed-in banner already covers those).
async function transferEventLog(logFile, timeoutMs = EVENT_TIMEOUT) {
  if (!logFile || !fs.existsSync(logFile)) return { ok: false };
  const repositoryContext = queueContextForPath(logFile);
  const organizationContext = repositoryContext
    ? null
    : organizationAuditContextForPath(logFile);
  const context = repositoryContext || organizationContext;
  if (!context) {
    try { fs.unlinkSync(logFile); } catch {}
    return { ok: false };
  }
  const organizationScoped = !!organizationContext;
  const disposition = organizationScoped
    ? organizationAuditDisposition(context)
    : queueDisposition(context);
  if (disposition === "delete") {
    if (organizationScoped) clearOrganizationAuditPayloads(context);
    else purgeRepositoryQueue(context.repoKey);
    return { ok: false };
  }
  const authorizationKey = organizationScoped ? "" : context.repoKey;
  if (
    disposition === "pause" ||
    !credstore.isTelemetryTransmissionAllowed(authorizationKey)
  ) {
    const scope = organizationScoped ? "organization" : "repository";
    console.error(
      `[skillmeter] Event log: telemetry not authorized for this ${scope} — leaving for retry`
    );
    return { ok: false };
  }

  // A valid (non-expired) license JWT is REQUIRED — the backend does not accept
  // unauthenticated telemetry. No valid token → leave the file for retry; the
  // drain refreshes before each batch, the one place refresh happens. Uncached
  // read so the long-lived daemon sees a token refreshed by another process.
  const token = credstore.getLicenseTokenUncached();
  if (!token || isJwtExpired(token)) {
    console.error(`[skillmeter] Event log: no valid license JWT — leaving for retry`);
    return { ok: false };
  }

  const endpoint = getEndpointFromTokenAllowExpired(token);
  if (!endpoint) {
    console.error(`[skillmeter] Event log: no telemetry endpoint resolvable from license JWT — leaving for retry`);
    return { ok: false };
  }

  const fileContent = fs.readFileSync(logFile);
  const compressed = zlib.gzipSync(fileContent);
  const baseName = path.basename(logFile);

  const markSent = () => {
    try { fs.renameSync(logFile, `${logFile}.sent`); } catch {}
  };

  console.error(`[skillmeter] Transferring event log: ${baseName} (${compressed.length} bytes gzipped)`);

  try {
    if (
      (
        organizationScoped
          ? organizationAuditDisposition(context)
          : queueDisposition(context)
      ) !== "send" ||
      !credstore.isTelemetryTransmissionAllowed(authorizationKey)
    ) {
      return { ok: false };
    }
    const res = await fetch(`${endpoint}/logs/claude`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "X-Plugin-Version": PLUGIN_VERSION,
        "X-Idempotency-Key": idempotencyKey(
          organizationScoped
            ? `organization:${context.tenantFingerprint}`
            : context.repoKey,
          fileContent
        ),
        ...(organizationScoped
          ? { "X-Telemetry-Scope": "organization" }
          : {}),
        "Authorization": `Bearer ${token}`,
      },
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      console.error(`[skillmeter] Event log transferred: ${baseName}`);
      markSent();
      return { ok: true };
    }
    console.error(`[skillmeter] Event log transfer failed: HTTP ${res.status}`);
    if (res.status === 401) return { ok: false, unauthorized: true, error: "HTTP 401" };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    console.error(`[skillmeter] Event log transfer error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Seal the active event log into a retryable batch. This is a local durable
 * queue transition only; network upload is handled by drainFailedLogs().
 * @returns {string|null} sealed file path when a log was rotated.
 */
function sealEventLog(repository) {
  const logFile = repository?.repoKey
    ? repositoryQueuePaths(
        repository.repoKey,
        credstore.getOrCreateHashSalt()
      ).eventLog
    : "";
  if (!logFile || !fs.existsSync(logFile)) {
    console.error(`[skillmeter] No event log to seal`);
    return null;
  }

  const baseTimestamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = `${baseTimestamp + attempt}`;
    const sealedFile = `${logFile}.${suffix}`;
    if (fs.existsSync(sealedFile)) continue;

    try {
      fs.renameSync(logFile, sealedFile);
      console.error(`[skillmeter] Sealed event log: ${path.basename(sealedFile)}`);
      return sealedFile;
    } catch (err) {
      if (err && err.code === "ENOENT") {
        console.error(`[skillmeter] No event log to seal`);
        return null;
      }
      if (err && err.code === "EEXIST") continue;
      console.error(`[skillmeter] Event log seal failed: ${err.message}`);
      return null;
    }
  }

  console.error(`[skillmeter] Event log seal failed: no unique batch name`);
  return null;
}

function sealOrganizationAuditEventLog() {
  const logFile = currentOrganizationAuditContext()?.eventLog || "";
  if (!logFile || !fs.existsSync(logFile)) return null;

  const baseTimestamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const sealedFile = `${logFile}.${baseTimestamp + attempt}`;
    if (fs.existsSync(sealedFile)) continue;
    try {
      fs.renameSync(logFile, sealedFile);
      console.error(
        `[skillmeter] Sealed organization audit log: ${path.basename(sealedFile)}`
      );
      return sealedFile;
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      if (err && err.code === "EEXIST") continue;
      console.error(
        `[skillmeter] Organization audit log seal failed: ${err.message}`
      );
      return null;
    }
  }
  return null;
}

function shouldSpawnDrainOnce() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const st = fs.statSync(DRAIN_ONCE_LOCK_FILE);
    if (Date.now() - st.mtimeMs < DRAIN_ONCE_LOCK_STALE_MS) {
      console.error(`[skillmeter] Drain trigger skipped: recent drain already requested`);
      return false;
    }
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.error(`[skillmeter] Drain lock check failed: ${err.message}`);
    }
  }

  try {
    fs.writeFileSync(DRAIN_ONCE_LOCK_FILE, `${process.pid} ${Date.now()}\n`);
    return true;
  } catch (err) {
    console.error(`[skillmeter] Drain lock write failed: ${err.message}`);
    return false;
  }
}

function clearDrainOnceLock() {
  try { fs.unlinkSync(DRAIN_ONCE_LOCK_FILE); } catch {}
}

// One hook process asks for at most one drain: a Stop that records and then
// requests license recovery would otherwise spawn two, relying only on the
// file debounce below to collapse them.
let drainSpawnedInProcess = false;

function spawnDetachedDrain() {
  if (drainSpawnedInProcess) return false;
  if (!shouldSpawnDrainOnce()) return false;

  const script = path.join(PLUGIN_ROOT, "scripts", "drain_once.js");
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    drainSpawnedInProcess = true;
    console.error(`[skillmeter] Drain trigger spawned: pid=${child.pid}`);
    return true;
  } catch (err) {
    clearDrainOnceLock();
    console.error(`[skillmeter] Drain trigger spawn failed: ${err.message}`);
    return false;
  }
}

// Stage lines after the last durable cursor UUID into independent chunks.
// Pure planning lives in lib/transcript-delta.js.

function cursorPath(transcriptId, repository) {
  if (!repository?.repoKey) return "";
  const context = repository?.repoKey
    ? queueContextForRepository(repository.repoKey, repository.org)
    : null;
  return context ? path.join(context.cursors, `${transcriptId}.json`) : "";
}

// Uncached (direct disk) read so a cursor advanced by one process is seen by
// another (Stop vs detached drain), matching getLicenseTokenUncached.
function readCursor(transcriptId, repository) {
  return safeReadJson(cursorPath(transcriptId, repository), null);
}

// Persist the delta cursor atomically. Best-effort: a failed write just means
// the next Stop recomputes from the old cursor (chunks are idempotent by uuid).
function writeCursor(cursor, repository) {
  try {
    atomicWriteJson(cursorPath(cursor.transcriptId, repository), cursor);
    return true;
  } catch (err) {
    console.error(`[skillmeter] Transcript cursor write failed: ${err.message}`);
    return false;
  }
}

// Seal one delta chunk as a durable body (.jsonl) + sidecar (.meta.json). The
// meta is written (durable) BEFORE the body is atomically published, so
// listDeltaChunks (which keys off the body) never yields a body without meta.
// Returns the body path, or null on failure.
function sealDeltaChunk(transcriptId, lines, meta, repository) {
  if (!repository?.repoKey) return null;
  const context = repository?.repoKey
    ? queueContextForRepository(repository.repoKey, repository.org)
    : null;
  if (!context) return null;
  const chunksDir = context.chunks;
  try {
    fs.mkdirSync(chunksDir, { recursive: true });
  } catch (err) {
    console.error(`[skillmeter] Delta chunk seal failed (mkdir): ${err.message}`);
    return null;
  }

  const body = lines.join("\n") + "\n";
  const baseTs = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = `${baseTs + attempt}-${process.pid}`;
    const bodyPath = path.join(chunksDir, `${base}.jsonl`);
    const metaPath = path.join(chunksDir, `${base}.meta.json`);
    if (fs.existsSync(bodyPath) || fs.existsSync(metaPath)) continue;

    const tmpPath = `${bodyPath}.tmp.${process.pid}.${baseTs}`;
    try {
      const fd = fs.openSync(tmpPath, "w", 0o600);
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      atomicWriteJson(metaPath, {
        transcriptId,
        ...meta,
        repoKey: repository?.repoKey,
        org: repository?.org,
        policyRevision: telemetryStore.getPolicyRevision(),
        createdAt: baseTs,
      });
      fs.renameSync(tmpPath, bodyPath); // publish body last
      return bodyPath;
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(metaPath); } catch {}
      console.error(`[skillmeter] Delta chunk seal failed: ${err.message}`);
      return null;
    }
  }
  console.error(`[skillmeter] Delta chunk seal failed: no unique chunk name`);
  return null;
}

// List delta chunk bodies that have a durable sidecar meta (bodies without a
// meta are half-written and skipped until complete or swept).
function listDeltaChunks() {
  const directories = listRepositoryQueueContexts().map((context) => context.chunks);
  const files = [];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    try {
      files.push(...fs.readdirSync(directory)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(directory, f))
      .filter((bodyPath) => {
        try {
          return (
            fs.statSync(bodyPath).isFile() &&
            fs.existsSync(bodyPath.replace(/\.jsonl$/, ".meta.json"))
          );
        } catch {
          return false;
        }
      }));
    } catch {}
  }
  return files;
}

// Build the HTTP headers for a delta chunk upload. Pure (no fs/network) so the
// X-Chunk-Reset / X-Prompt-ID logic is unit-testable.
function buildChunkHeaders(meta, deviceId, token, rawBody = null) {
  const headers = {
    "Content-Type": "application/x-ndjson",
    "Content-Encoding": "gzip",
    "X-Device-ID": deviceId,
    "X-Transcript-ID": meta.transcriptId,
    "X-Chunk-Seq": String(meta.seq),
    // >0 => server truncates rows with seq < baseline for this transcript
    // (order-independent under parallel drain); "0" => plain append.
    "X-Chunk-Reset": String(meta.reset ? meta.resetBaselineSeq : 0),
    "X-Plugin-Version": PLUGIN_VERSION,
    "Authorization": `Bearer ${token}`,
  };
  if (meta.promptId) headers["X-Prompt-ID"] = meta.promptId;
  if (meta.repoKey && rawBody) {
    headers["X-Idempotency-Key"] = idempotencyKey(meta.repoKey, rawBody);
  }
  return headers;
}

function logBackfillChunk(meta, event, details = {}) {
  if (meta?.promptId !== "backfill") return;
  appendBackfillLog(event, {
    offerId: meta.backfillOfferId,
    repository: meta.repoKey,
    transcriptId: meta.transcriptId,
    seq: meta.seq,
    ...details,
  });
}

function isBackfillChunkAuthorized(meta, context) {
  return !!(
    meta?.promptId === "backfill" &&
    meta.backfillOfferId &&
    isBackfillUploadAuthorized({
      offerId: meta.backfillOfferId,
      org: context?.org,
      repoKey: context?.repoKey,
    })
  );
}

// A backfill chunk belongs to the tenant its offer was accepted under. Signed
// out, it waits; signed in to any other tenant, including one that lists the
// same org, it is never sent there. An offer accepted before tenants were
// recorded has no tenant and so matches none.
function backfillTenantMatches(meta, token) {
  const expected = backfillOfferTenant(meta.backfillOfferId);
  return !!expected &&
    tenantFingerprint(token, credstore.getHashSalt()) === expected;
}

function chunkDisposition(meta, context) {
  if (telemetryStore.getGlobalDisabled()) return "pause";
  if (meta?.promptId === "backfill" && meta.backfillOfferId) {
    if (!isBackfillChunkAuthorized(meta, context)) return "delete";
    const current = currentTenantFingerprint();
    if (current && current !== backfillOfferTenant(meta.backfillOfferId)) {
      return "delete";
    }
    return "send";
  }
  return queueDisposition(context);
}

function chunkTransmissionAllowed(meta, context) {
  if (telemetryStore.getGlobalDisabled()) return false;
  if (meta?.promptId === "backfill" && meta.backfillOfferId) {
    return (
      isBackfillChunkAuthorized(meta, context) &&
      credstore.getAllowedGitHubOrgs().includes(context.org)
    );
  }
  return credstore.isTelemetryTransmissionAllowed(context.repoKey);
}

/**
 * Persist failure count and next-attempt time in the chunk sidecar so all drains
 * share one budget. Exhausted body/metadata pairs get a .quarantined suffix and
 * remain subject to cleanup. A sidecar write failure leaves the prior retry state.
 */
function noteChunkUploadFailure(bodyPath, metaPath, meta, error) {
  const updated = recordUploadFailure(meta, { now: Date.now(), error });
  try {
    atomicWriteJson(metaPath, updated);
  } catch {
    return { abandoned: false, attempts: updated.uploadAttempts };
  }
  if (!isChunkExhausted(updated)) {
    return { abandoned: false, attempts: updated.uploadAttempts };
  }
  try {
    fs.renameSync(metaPath, quarantinePathFor(metaPath));
    fs.renameSync(bodyPath, quarantinePathFor(bodyPath));
  } catch (err) {
    console.error(
      `[skillmeter] Transcript chunk quarantine failed: ${err.message}`
    );
    return { abandoned: false, attempts: updated.uploadAttempts };
  }
  console.error(
    `[skillmeter] Transcript chunk given up on after ${updated.uploadAttempts} ` +
      `attempts (${error}) — set aside, not deleted`
  );
  logBackfillChunk(meta, "upload_abandoned", {
    attempts: updated.uploadAttempts,
    maxAttempts: MAX_UPLOAD_ATTEMPTS,
    error: String(error),
  });
  return { abandoned: true, attempts: updated.uploadAttempts };
}

// Upload one delta chunk. On 2xx, deletes the body then the meta; otherwise
// leaves both for retry. Result shape matches drainFailedLogs entries.
async function uploadDeltaChunk(bodyPath, deviceId, timeoutMs = TRANSCRIPT_TIMEOUT) {
  if (!bodyPath || !fs.existsSync(bodyPath)) return { ok: false };
  const metaPath = bodyPath.replace(/\.jsonl$/, ".meta.json");
  const meta = safeReadJson(metaPath, null);
  if (!meta) {
    console.error(`[skillmeter] Transcript chunk: missing meta for ${path.basename(bodyPath)}`);
    return { ok: false };
  }
  const context = queueContextForPath(bodyPath);
  if (!context || !meta.repoKey || meta.repoKey !== context.repoKey) {
    logBackfillChunk(meta, "upload_failed", {
      error: "invalid_queue_context",
    });
    try { fs.unlinkSync(bodyPath); } catch {}
    try { fs.unlinkSync(metaPath); } catch {}
    return { ok: false, error: "invalid_queue_context" };
  }
  const disposition = chunkDisposition(meta, context);
  if (disposition === "delete" && meta.promptId === "backfill") {
    // Backfill consent is separate from repository policy: an offer that is
    // no longer authorized removes only its own chunk. Purging the queue
    // here would also drop the repository's live telemetry.
    logBackfillChunk(meta, "upload_failed", {
      error: "backfill_offer_not_authorized",
    });
    try { fs.unlinkSync(bodyPath); } catch {}
    try { fs.unlinkSync(metaPath); } catch {}
    return { ok: false, error: "backfill_offer_not_authorized" };
  }
  if (disposition === "delete") {
    logBackfillChunk(meta, "upload_failed", {
      error: "repository_policy_deleted_queue",
    });
    purgeRepositoryQueue(context.repoKey);
    return { ok: false, error: "repository_policy_deleted_queue" };
  }
  if (
    disposition === "pause" ||
    !chunkTransmissionAllowed(meta, context)
  ) {
    console.error(`[skillmeter] Transcript chunk: telemetry not authorized for this repository — kept for retry`);
    logBackfillChunk(meta, "upload_deferred", {
      reason: "telemetry_not_authorized",
    });
    return { ok: false, deferred: true };
  }

  const token = credstore.getLicenseTokenUncached();
  if (!token || isJwtExpired(token)) {
    console.error(`[skillmeter] Transcript chunk: no valid license JWT — kept for retry`);
    logBackfillChunk(meta, "upload_deferred", {
      reason: "license_unavailable",
    });
    return { ok: false, deferred: true };
  }
  const endpoint = getEndpointFromTokenAllowExpired(token);
  if (!endpoint) {
    console.error(`[skillmeter] Transcript chunk: no telemetry endpoint resolvable — kept for retry`);
    logBackfillChunk(meta, "upload_deferred", {
      reason: "endpoint_unavailable",
    });
    return { ok: false, deferred: true };
  }

  let compressed;
  let raw;
  try {
    raw = await fsp.readFile(bodyPath);
    compressed = await gzipAsync(raw);
  } catch (err) {
    console.error(`[skillmeter] Transcript chunk gzip failed: ${err.message}`);
    const budget = noteChunkUploadFailure(bodyPath, metaPath, meta, "gzip_failed");
    logBackfillChunk(meta, "upload_failed", {
      error: "gzip_failed",
      attempts: budget.attempts,
    });
    return { ok: false, error: err.message, abandoned: budget.abandoned };
  }

  const removeChunk = () => {
    try { fs.unlinkSync(bodyPath); } catch {}
    try { fs.unlinkSync(metaPath); } catch {}
  };

  console.error(
    `[skillmeter] Transferring transcript chunk: ${meta.transcriptId} seq=${meta.seq} (${compressed.length} bytes gzipped)`
  );
  const startedAt = Date.now();
  logBackfillChunk(meta, "upload_attempt", {
    rawBytes: raw.length,
    gzipBytes: compressed.length,
  });

  try {
    if (
      chunkDisposition(meta, context) !== "send" ||
      !chunkTransmissionAllowed(meta, context) ||
      // Check the token this request carries, not a later re-read of it.
      (meta.promptId === "backfill" && meta.backfillOfferId &&
        !backfillTenantMatches(meta, token))
    ) {
      logBackfillChunk(meta, "upload_deferred", {
        reason: "policy_changed_before_request",
      });
      return { ok: false, deferred: true };
    }
    const res = await fetch(`${endpoint}/logs/claude/transcript`, {
      method: "POST",
      headers: buildChunkHeaders(meta, deviceId, token, raw),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      console.error(`[skillmeter] Transcript chunk transferred: ${meta.transcriptId} seq=${meta.seq}`);
      logBackfillChunk(meta, "upload_succeeded", {
        httpStatus: res.status,
        durationMs: Date.now() - startedAt,
        rawBytes: raw.length,
        gzipBytes: compressed.length,
      });
      removeChunk();
      return { ok: true };
    }
    if (res.status === 401) {
      // The token, not the chunk: no retry budget is spent. The drain refreshes
      // once and resends.
      console.error("[skillmeter] Transcript chunk rejected: license not accepted (HTTP 401) — kept for retry");
      logBackfillChunk(meta, "upload_deferred", { reason: "license_rejected", httpStatus: 401 });
      return { ok: false, unauthorized: true, error: "HTTP 401" };
    }
    const budget = noteChunkUploadFailure(
      bodyPath,
      metaPath,
      meta,
      `HTTP ${res.status}`
    );
    console.error(
      `[skillmeter] Transcript chunk transfer failed: HTTP ${res.status} — ` +
        (budget.abandoned
          ? "retry budget spent, set aside"
          : `kept for retry (attempt ${budget.attempts}/${MAX_UPLOAD_ATTEMPTS})`)
    );
    logBackfillChunk(meta, "upload_failed", {
      httpStatus: res.status,
      durationMs: Date.now() - startedAt,
      error: `HTTP ${res.status}`,
      attempts: budget.attempts,
    });
    return {
      ok: false,
      error: `HTTP ${res.status}`,
      abandoned: budget.abandoned,
    };
  } catch (err) {
    const budget = noteChunkUploadFailure(
      bodyPath,
      metaPath,
      meta,
      String(err?.message || err)
    );
    console.error(
      `[skillmeter] Transcript chunk transfer error: ${err.message} — ` +
        (budget.abandoned
          ? "retry budget spent, set aside"
          : `kept for retry (attempt ${budget.attempts}/${MAX_UPLOAD_ATTEMPTS})`)
    );
    logBackfillChunk(meta, "upload_failed", {
      durationMs: Date.now() - startedAt,
      error: String(err?.message || err),
      attempts: budget.attempts,
    });
    return { ok: false, error: err.message, abandoned: budget.abandoned };
  }
}

// Returns { ok: <#uploaded>, errors: [...] } for this batch.
async function drainDeltaChunks(timeoutMs) {
  const lock = acquireQueueDrainLock("transcripts");
  if (!lock) return { ok: 0, errors: [] };
  try {
    purgeDisallowedQueues();
    const queued = listDeltaChunks();
    if (queued.length === 0) return { ok: 0, errors: [] };
    // Chunks that failed recently are waiting out their per-chunk backoff.
    // Skipping them here is what bounds the retry rate: the Stop hook spawns a
    // drain at the end of every turn, so without this a chunk the backend
    // always rejects is re-sent at whatever rate turns end.
    const now = Date.now();
    const files = queued.filter((file) =>
      isChunkEligible(
        safeReadJson(file.replace(/\.jsonl$/, ".meta.json"), null),
        now
      )
    );
    // Nothing eligible: return before the batch log, so a backed-off queue
    // stays quiet instead of announcing an empty pass on every drain.
    if (files.length === 0) return { ok: 0, errors: [] };
    const backfillEntries = files.flatMap((file) => {
      const meta = safeReadJson(file.replace(/\.jsonl$/, ".meta.json"), null);
      return meta?.promptId === "backfill" ? [{ file, meta }] : [];
    });
    if (telemetryStore.getGlobalDisabled()) {
      if (backfillEntries.length > 0) {
        appendBackfillLog("upload_batch_completed", {
          offerId: backfillEntries[0].meta.backfillOfferId,
          chunkCount: backfillEntries.length,
          uploaded: 0,
          failed: 0,
          deferred: backfillEntries.length,
          reason: "global_telemetry_disabled",
        });
      }
      return { ok: 0, errors: [] };
    }

    const deviceId = credstore.getDeviceId();
    if (!deviceId) return { ok: 0, errors: [] };

    if (backfillEntries.length > 0) {
      appendBackfillLog("upload_batch_started", {
        offerId: backfillEntries[0].meta.backfillOfferId,
        chunkCount: backfillEntries.length,
        totalQueueCount: files.length,
      });
    }
    console.error(`[skillmeter] Draining ${files.length} transcript chunk(s)`);
    // Best-effort, single-flight refresh once per batch (see drainFailedLogs).
    await ensureFreshLicense(deviceId);
    const upload = (batch) => settleWithLimit(
      batch,
      DRAIN_CONCURRENCY,
      (file) => uploadDeltaChunk(file, deviceId, timeoutMs),
      () => touchQueueDrainLock(lock)
    );
    const results = await retryUnauthorizedOnce(files, await upload(files), upload);
    if (backfillEntries.length > 0) {
      const backfillFiles = new Set(
        backfillEntries.map((entry) => entry.file)
      );
      let uploaded = 0;
      let failed = 0;
      let deferred = 0;
      let abandoned = 0;
      files.forEach((file, index) => {
        if (!backfillFiles.has(file)) return;
        const result = results[index];
        if (result.status === "rejected") {
          failed++;
        } else if (result.value?.ok) {
          uploaded++;
        } else if (result.value?.error) {
          failed++;
          if (result.value.abandoned) abandoned++;
        } else {
          deferred++;
        }
      });
      appendBackfillLog("upload_batch_completed", {
        offerId: backfillEntries[0].meta.backfillOfferId,
        chunkCount: backfillEntries.length,
        uploaded,
        failed,
        deferred,
        abandoned,
      });
      try { settleBackfillDelivery(); } catch {}
    }
    return tally(results);
  } finally {
    releaseQueueDrainLock(lock);
  }
}

/**
 * Stage a transcript delta: seal the lines added since the cursor's uuid as
 * durable chunks, then advance the cursor. Only the turns that belong to this
 * repository are sealed (turnDestinations); the cursor moves past the rest.
 * The cursor advances only after every chunk seals, so a partial failure
 * re-sends the full delta next Stop (chunks are idempotent by uuid). Returns
 * { chunks: <#sealed> }.
 */
function stageTranscriptDelta(transcriptPath, promptId, deviceId, repository) {
  if (!repository?.repoKey) return { chunks: 0 };
  const transcriptId = path.basename(transcriptPath);
  // The snapshot skips any transcript with a live cursor, so only transcripts
  // without one (or with a discarded one) can race it and must wait. Deferring
  // every session would lose the final turns of sessions that end meanwhile.
  const existingCursor = readCursor(transcriptId, repository);
  if ((!existingCursor || existingCursor.discarded) && isBackfillRunning()) {
    return { chunks: 0, deferred: true };
  }

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (err) {
    console.error(`[skillmeter] Transcript delta read failed: ${err.message}`);
    return { chunks: 0 };
  }

  const { objs } = parseJsonl(raw);
  const places = transcriptPlaces();
  const destinations = turnDestinations(objs, places.of, unrecordedTurns(transcriptId));
  let chunks = stageRepositoryTurns(objs, destinations, transcriptId, promptId, repository);
  // A turn's own Stop may not stage it: the turn ended outside any repository,
  // or its last lines were written after that Stop read the transcript. Every
  // other repository already recording this transcript takes its turns here.
  // One no longer recording is closed like any period that is not recorded.
  for (const place of places.repositories()) {
    const other = place.repository;
    if (other.repoKey === repository.repoKey) continue;
    const cursor = readCursor(transcriptId, other);
    if (!cursor || cursor.discarded) continue;
    if (place.recording) {
      // The triggering turn is not this repository's, so no prompt id.
      chunks += stageRepositoryTurns(objs, destinations, transcriptId, null, other);
    } else {
      advanceCursorToTranscriptTail(transcriptPath, other);
    }
  }
  return { chunks };
}

// Stage, for one repository, the turns after its cursor that belong to it.
function stageRepositoryTurns(objs, destinations, transcriptId, promptId, repository) {
  const cursor = readCursor(transcriptId, repository);
  // A recorded hook with a prompt id gives the repository a cursor
  // (startTranscriptAtTurn), so without one nothing here was recorded for it.
  // Staging without a turn, at session end, then sends nothing.
  const neverRecorded = !cursor && !promptId &&
    objs.some((record) => typeof record?.promptId === "string");
  const delta = neverRecorded ? { hold: true } : liveDeltaStart(objs, cursor, transcriptId, repository);
  if (delta.hold) {
    // Where an unrecorded period ended is unknown, so it ends here: nothing
    // before this point is sent.
    const lastUuid = lastContentUuid(objs);
    if (lastUuid) {
      writeCursor({
        transcriptId,
        lastUuid,
        seq: (cursor && cursor.seq) || 0,
        updatedAt: Date.now(),
        discarded: true,
      }, repository);
    }
    return 0;
  }
  const plan = buildChunkPlan(objs, delta.start, credstore.getOrCreateHashSalt(), {
    seqStart: (cursor && cursor.seq) || 0,
    maxUncompressedBytes: getTranscriptChunkMaxBytes(),
    keep: (index) =>
      destinations[index] === undefined || destinations[index] === repository.repoKey,
  });

  if (!plan.newCursor) return 0; // empty delta — cursor untouched

  let sealed = 0;
  for (const chunk of plan.chunks) {
    const bodyPath = sealDeltaChunk(transcriptId, chunk.lines, {
      seq: chunk.seq,
      reset: chunk.reset,
      resetBaselineSeq: chunk.resetBaselineSeq,
      promptId,
    }, repository);
    if (bodyPath) sealed++;
  }

  // Advance only when the whole delta durably sealed; otherwise leave the cursor
  // so the next Stop re-seals the full delta (dedup by uuid on the server).
  if (sealed === plan.chunks.length) {
    writeCursor({
      transcriptId,
      lastUuid: plan.newCursor.lastUuid,
      seq: plan.newCursor.seq,
      updatedAt: Date.now(),
    }, repository);
  }
  return sealed;
}

// Working directories as transcript staging sees them, each resolved once:
// the repository and whether it records, null outside any repository, or
// undefined for a directory that no longer exists.
function transcriptPlaces() {
  const cache = new Map();
  const of = (cwd) => {
    if (!cache.has(cwd)) cache.set(cwd, transcriptPlace(cwd));
    return cache.get(cwd);
  };
  // Each licensed repository the transcript was written in, once.
  const repositories = () => [...new Map([...cache.values()]
    .filter((place) => place?.repository)
    .map((place) => [place.key, place])).values()];
  return { of, repositories };
}

function transcriptPlace(cwd) {
  let decision;
  try {
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) return undefined;
    decision = getRepoScopeDecision(cwd);
  } catch {
    return undefined;
  }
  if (!decision?.repoRoot) return null;
  // A repository outside the license's organizations, or without a GitHub
  // identity, is still a repository: it never records.
  if (!decision.repoKey) return { key: `root:${decision.repoRoot}`, recording: false };
  return {
    key: decision.repoKey,
    repository: { repoKey: decision.repoKey, org: decision.remoteOrg },
    // The rule every recorded event passes; it includes the capture gate.
    recording: credstore.isTelemetryTransmissionAllowed(decision.repoKey),
  };
}

/**
 * Seal one immutable historical snapshot through its final UUID. A discarded
 * privacy cursor is intentionally ignored; a real upload cursor means this
 * transcript already participated in live telemetry and is skipped.
 */
function stageTranscriptSnapshot(transcriptPath, repository, {
  transformRecords = (records) => records,
  cutoffAt = Infinity,
  backfillOfferId = "",
} = {}) {
  if (!repository?.repoKey) {
    return { chunks: 0, skipped: true, reason: "missing_repository" };
  }
  const transcriptId = path.basename(transcriptPath);
  const cursor = readCursor(transcriptId, repository);
  if (cursor && cursor.discarded !== true) {
    return { chunks: 0, skipped: true, reason: "existing_cursor" };
  }

  let raw;
  try {
    if (fs.statSync(transcriptPath).mtimeMs > cutoffAt) {
      return { chunks: 0, skipped: true, reason: "modified_after_cutoff" };
    }
    raw = fs.readFileSync(transcriptPath, "utf8");
    if (fs.statSync(transcriptPath).mtimeMs > cutoffAt) {
      return { chunks: 0, skipped: true, reason: "modified_after_cutoff" };
    }
  } catch {
    return { chunks: 0, failed: true, reason: "read_failed" };
  }

  const { objs } = parseJsonl(raw);
  let boundaryIndex = -1;
  for (let index = objs.length - 1; index >= 0; index--) {
    if (typeof objs[index]?.uuid === "string" && objs[index].uuid) {
      boundaryIndex = index;
      break;
    }
  }
  if (boundaryIndex < 0) {
    return { chunks: 0, skipped: true, reason: "missing_uuid" };
  }

  const snapshot = transformRecords(objs.slice(0, boundaryIndex + 1));
  const plan = buildChunkPlan(
    snapshot,
    null,
    credstore.getOrCreateHashSalt(),
    {
      seqStart: (cursor && cursor.seq) || 0,
      maxUncompressedBytes: getTranscriptChunkMaxBytes(),
    }
  );
  if (!plan.newCursor?.lastUuid || plan.chunks.length === 0) {
    return { chunks: 0, skipped: true, reason: "empty_snapshot" };
  }

  let sealed = 0;
  for (const chunk of plan.chunks) {
    const bodyPath = sealDeltaChunk(transcriptId, chunk.lines, {
      seq: chunk.seq,
      reset: chunk.reset,
      resetBaselineSeq: chunk.resetBaselineSeq,
      promptId: "backfill",
      backfillOfferId,
    }, repository);
    if (bodyPath) sealed++;
  }
  if (sealed !== plan.chunks.length) {
    return { chunks: sealed, failed: true, reason: "chunk_seal_failed" };
  }

  const cursorWritten = writeCursor({
    transcriptId,
    lastUuid: plan.newCursor.lastUuid,
    seq: plan.newCursor.seq,
    updatedAt: Date.now(),
    backfill: true,
  }, repository);
  if (!cursorWritten) {
    return { chunks: sealed, failed: true, reason: "cursor_write_failed" };
  }
  return {
    chunks: sealed,
    lastUuid: plan.newCursor.lastUuid,
  };
}

/**
 * Move a repository's cursor to the transcript's newest record.
 * @returns {boolean|null} true when moved; false when there was nothing to do
 *   (no transcript or record yet, or `onlyWhenMissing` and a cursor exists);
 *   null when the transcript could not be read or the cursor not written.
 */
function advanceCursorToTranscriptTail(transcriptPath, repository, {
  onlyWhenMissing = false,
} = {}) {
  if (!transcriptPath || !repository?.repoKey) return false;
  const transcriptId = path.basename(transcriptPath);
  const existing = readCursor(transcriptId, repository);
  if (onlyWhenMissing && existing) return false;
  const readAt = Date.now();
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (err) {
    return err.code === "ENOENT" ? false : null;
  }
  const { objs } = parseJsonl(raw);
  const last = [...objs].reverse().find((record) =>
    record && typeof record.uuid === "string" && record.uuid
  );
  if (!last) return false;
  // Hooks that run at once read the transcript at different lengths. A cursor
  // written since this read, past everything it saw, is not moved back.
  const current = onlyWhenMissing ? null : readCursor(transcriptId, repository);
  if (current?.lastUuid && (current.updatedAt || 0) >= readAt &&
      !objs.some((record) => record?.uuid === current.lastUuid)) {
    return true;
  }
  const written = writeCursor({
    transcriptId,
    lastUuid: last.uuid,
    seq: existing?.seq || 0,
    updatedAt: Date.now(),
    discarded: !onlyWhenMissing,
  }, repository);
  return written ? true : null;
}

function initializeTranscriptCursor(input, deviceId, repository) {
  const started = advanceCursorToTranscriptTail(input?.transcript_path, repository, {
    onlyWhenMissing: true,
  });
  // A resumed session's earlier conversation stays behind this boundary even
  // when the cursor could not be written.
  if (started === null) recordPendingBoundary(input.transcript_path, repository);
  return started;
}

// A repository first seen recording part-way through a transcript starts with
// the turn it was seen in: what came before was written before that
// observation. The hook knows its turn only by its prompt id, and the
// transcript only when its records carry one.
function startTranscriptAtTurn(input, repository) {
  const transcriptPath = input?.transcript_path;
  if (!transcriptPath || !input.prompt_id || !repository?.repoKey) return false;
  const transcriptId = path.basename(transcriptPath);
  // A cursor that cannot be read still holds staging; it is not replaced.
  if (readBoundaryFile(cursorPath(transcriptId, repository))) return false;
  let objs;
  try {
    objs = parseJsonl(fs.readFileSync(transcriptPath, "utf8")).objs;
  } catch (err) {
    if (err.code !== "ENOENT") return false;
    objs = [];
  }
  // Nothing written yet: the transcript starts with this turn.
  if (!lastContentUuid(objs)) {
    return writeCursor({ transcriptId, lastUuid: null, seq: 0, updatedAt: Date.now() }, repository);
  }
  if (!objs.some((record) => typeof record?.promptId === "string")) return false;
  // Not written yet: the whole transcript came before this turn.
  const first = objs.findIndex((record) => record?.promptId === input.prompt_id);
  const before = first === -1 ? objs : objs.slice(0, first);
  // Records before the first prompt open the session; they are no earlier
  // turn, and a null cursor still starts from them.
  const earlierTurn = turnNumbers(before).some((turn) => turn > 0);
  return writeCursor({
    transcriptId,
    lastUuid: earlierTurn ? lastContentUuid(before) : null,
    seq: 0,
    updatedAt: Date.now(),
  }, repository);
}

// Without a license there is no repository queue to hold a cursor, so a hook
// that runs signed out marks the transcript itself. Live staging, in whichever
// repository recording begins, starts after the newest record that hook saw. A
// history import ignores the mark, as it ignores a discarded cursor.
const UNLICENSED_MARK_DIR = path.join(LOG_DIR, "unlicensed-transcripts");
// Every hook writes the mark while signed out, so only the end is read.
const TAIL_BLOCK_BYTES = 64 * 1024;

function unlicensedMarkPath(transcriptId) {
  return path.join(UNLICENSED_MARK_DIR, `${transcriptId}.json`);
}

// The newest record's uuid, reading the transcript backwards a block at a time:
// "" when the transcript is absent or holds no record yet, null when it
// cannot be read.
function transcriptTailUuid(transcriptPath, blockBytes = TAIL_BLOCK_BYTES) {
  const tail = readTranscriptTail(transcriptPath, blockBytes);
  return tail && tail.uuid;
}

// { uuid, size }: the newest record's uuid ("" when none) in the first `size`
// bytes of the transcript; null when it cannot be read.
function readTranscriptTail(transcriptPath, blockBytes = TAIL_BLOCK_BYTES) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    let end = size;
    let cut = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - blockBytes);
      const block = Buffer.alloc(end - start);
      fs.readSync(fd, block, 0, block.length, start);
      let lines = Buffer.concat([block, cut]);
      // Unless the block starts the file, its first line may be cut off; it
      // is completed by the block before it.
      if (start > 0) {
        const lineEnd = lines.indexOf(0x0a);
        cut = lineEnd === -1 ? lines : lines.subarray(0, lineEnd);
        lines = lineEnd === -1 ? Buffer.alloc(0) : lines.subarray(lineEnd + 1);
      }
      const uuid = lastContentUuid(parseJsonl(lines.toString("utf8")).objs);
      if (uuid) return { uuid, size };
      end = start;
    }
    return { uuid: "", size };
  } catch (err) {
    return err.code === "ENOENT" ? { uuid: "", size: 0 } : null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Mark the transcript's newest record as the end of a signed-out period.
 * @returns {boolean|null} true when written; false when there is no record
 *   yet; null when the transcript could not be read or the mark not written.
 */
function markUnlicensedTranscript(transcriptPath) {
  if (!transcriptPath) return false;
  const readAt = Date.now();
  const tail = readTranscriptTail(transcriptPath);
  if (tail === null) return null;
  if (!tail.uuid) return false;
  const transcriptId = path.basename(transcriptPath);
  const file = unlicensedMarkPath(transcriptId);
  // Hooks that run at once read the transcript at different lengths. A mark
  // written since this read, from a longer transcript, is not moved back.
  const current = safeReadJson(file, null);
  if ((current?.updatedAt || 0) >= readAt && current.size > tail.size) return true;
  try {
    atomicWriteJson(file, {
      transcriptId,
      lastUuid: tail.uuid,
      size: tail.size,
      updatedAt: Date.now(),
    });
    return true;
  } catch (err) {
    console.error(`[skillmeter] Transcript mark write failed: ${err.message}`);
    return null;
  }
}

// When a hook cannot write the boundary of a period it did not record — the
// cursor, or without a license the signed-out mark — it records the boundary
// here instead: a separate local store, so the failure that stopped the first
// write rarely stops this one. Each line holds the scope (a repository's
// storage id, or "*" for every repository), the time, and the transcript's
// newest record when it could be read. Never sent.
const PENDING_BOUNDARY_DIR = path.join(LOG_DIR, "transcript-boundaries");

function pendingBoundaryPath(transcriptId) {
  return path.join(PENDING_BOUNDARY_DIR, `${transcriptId}.ndjson`);
}

function boundaryScope(repository) {
  return repository?.repoKey
    ? repositoryStorageId(repository.repoKey, credstore.getOrCreateHashSalt())
    : "*";
}

/**
 * Record a boundary that could not be written where staging normally reads it.
 * @param {object|null} repository  the repository, or null for a signed-out period
 * @returns {boolean} false when this could not be recorded either
 */
function recordPendingBoundary(transcriptPath, repository) {
  if (!transcriptPath) return false;
  const lastUuid = transcriptTailUuid(transcriptPath);
  if (lastUuid === "") return true;
  const entry = { scope: boundaryScope(repository), at: Date.now() };
  if (lastUuid) entry.lastUuid = lastUuid;
  try {
    fs.mkdirSync(PENDING_BOUNDARY_DIR, { recursive: true, mode: 0o700 });
    // The leading newline ends a line a crash left partial.
    fs.appendFileSync(
      pendingBoundaryPath(path.basename(transcriptPath)),
      "\n" + JSON.stringify(entry) + "\n",
      { mode: 0o600 }
    );
    return true;
  } catch (err) {
    console.error(`[skillmeter] Transcript boundary could not be recorded: ${err.message}`);
    return false;
  }
}

// A hook that is not recorded marks its turn, by prompt id, with the
// repository it ran in, or "*" when signed out. Staging never sends a marked
// turn, even once that repository records: whether it was recording is decided
// when the turn was written. The mark holds the prompt id and an HMAC of the
// repository, never a path or content, and is appended so that hooks running
// at once cannot lose one. Local only.
const UNRECORDED_TURN_DIR = path.join(LOG_DIR, "unrecorded-turns");

function unrecordedTurnPath(transcriptId) {
  return path.join(UNRECORDED_TURN_DIR, `${transcriptId}.ndjson`);
}

function readUnrecordedTurns(transcriptId) {
  const marks = new Map();
  let raw;
  try {
    raw = fs.readFileSync(unrecordedTurnPath(transcriptId), "utf8");
  } catch {
    return marks;
  }
  for (const entry of parseJsonl(raw).objs) {
    if (typeof entry?.promptId !== "string" || typeof entry.place !== "string") continue;
    if (!marks.has(entry.promptId)) marks.set(entry.promptId, new Set());
    marks.get(entry.promptId).add(entry.place);
  }
  return marks;
}

function markUnrecordedTurn(input, repoScopeDecision) {
  const promptId = input?.prompt_id;
  const signedOut = repoScopeDecision?.classification === "not_activated";
  const repository = repoScopeDecision?.repoKey ||
    (repoScopeDecision?.repoRoot ? `root:${repoScopeDecision.repoRoot}` : "");
  if (!input?.transcript_path || typeof promptId !== "string" || !promptId) return false;
  if (!signedOut && !repository) return false;
  const transcriptId = path.basename(input.transcript_path);
  const place = signedOut ? "*" : hashHmac(repository, credstore.getOrCreateHashSalt());
  if (!place) return false;
  if (readUnrecordedTurns(transcriptId).get(promptId)?.has(place)) return true;
  try {
    fs.mkdirSync(UNRECORDED_TURN_DIR, { recursive: true, mode: 0o700 });
    // The leading newline ends a line a crash left partial, so this mark is
    // never joined to it; the reader skips blank and partial lines.
    fs.appendFileSync(
      unrecordedTurnPath(transcriptId),
      "\n" + JSON.stringify({ promptId, place }) + "\n",
      { mode: 0o600 }
    );
    return true;
  } catch (err) {
    console.error(`[skillmeter] Unrecorded turn mark failed: ${err.message}`);
    return false;
  }
}

// For turnDestinations: was this turn marked as not recorded?
function unrecordedTurns(transcriptId) {
  const marks = readUnrecordedTurns(transcriptId);
  return (promptId) => marks.has(promptId);
}

// A boundary file as staging sees it: null when absent, { value } when read,
// { unreadableSince } when it exists but cannot be read or parsed. A missing
// or broken directory counts as absent: a boundary that could not be written
// there was recorded as pending instead.
function readBoundaryFile(file, parse = JSON.parse) {
  if (!file) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  try {
    return { value: parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { unreadableSince: stat.mtimeMs };
  }
}

/**
 * Where the live delta starts: after the latest boundary staging can read,
 * the cursor, the signed-out mark, or a pending boundary for this repository.
 * Staging must hold, sending nothing, while a boundary exists that cannot be
 * placed: an unreadable cursor, mark or pending store, or a pending boundary
 * recorded without a position, when no boundary was written after it.
 * @returns {{ start: object|null } | { hold: true }}
 */
function liveDeltaStart(objs, cursor, transcriptId, repository) {
  const known = [];
  const unplaced = [];
  if (cursor) known.push({ lastUuid: cursor.lastUuid, at: cursor.updatedAt || 0 });
  const cursorFile = readBoundaryFile(cursorPath(transcriptId, repository));
  if (cursorFile?.unreadableSince) unplaced.push(cursorFile.unreadableSince);
  const mark = readBoundaryFile(unlicensedMarkPath(transcriptId));
  if (mark?.unreadableSince) unplaced.push(mark.unreadableSince);
  else if (mark?.value?.lastUuid) {
    known.push({ lastUuid: mark.value.lastUuid, at: mark.value.updatedAt || 0 });
  }
  const pending = readBoundaryFile(pendingBoundaryPath(transcriptId), (raw) => parseJsonl(raw).objs);
  if (pending?.unreadableSince) unplaced.push(pending.unreadableSince);
  const scope = boundaryScope(repository);
  for (const entry of pending?.value || []) {
    if (entry?.scope !== "*" && entry?.scope !== scope) continue;
    if (typeof entry.lastUuid === "string" && entry.lastUuid) {
      known.push({ lastUuid: entry.lastUuid, at: entry.at || 0 });
    } else {
      unplaced.push(entry.at || Date.now());
    }
  }
  const latest = Math.max(0, ...known.map((boundary) => boundary.at));
  if (unplaced.some((at) => at >= latest)) return { hold: true };

  const indexOf = (uuid) =>
    uuid ? objs.findIndex((record) => record && record.uuid === uuid) : -1;
  let start = cursor;
  let startIndex = indexOf(cursor?.lastUuid);
  for (const boundary of known) {
    const index = indexOf(boundary.lastUuid);
    if (index > startIndex) {
      start = { ...cursor, lastUuid: boundary.lastUuid };
      startIndex = index;
    }
  }
  return { start };
}

function discardSkippedSessionArtifacts(input, deviceId, repository) {
  sealEventLogAndTriggerDrain(input, deviceId, repository);
  advanceCursorToTranscriptTail(input?.transcript_path, repository);
}

/**
 * Seal final-session artifacts into durable queues and, when anything was
 * queued, spawn a detached drain for the upload, keeping async hooks short.
 */
function sealFinalSessionArtifacts(input, deviceId, repository) {
  const sealedEventLog = sealEventLog(repository);
  const sealedAuditLog = sealOrganizationAuditEventLog();
  let stagedTranscript = false;

  if (input && input.transcript_path && fs.existsSync(input.transcript_path)) {
    const id = deviceId || credstore.getDeviceId();
    const res = stageTranscriptDelta(
      input.transcript_path,
      input.prompt_id,
      id,
      repository
    );
    stagedTranscript = res && res.chunks > 0;
  } else {
    console.error(`[skillmeter] No transcript to stage`);
  }

  if (sealedEventLog || sealedAuditLog || stagedTranscript) {
    spawnDetachedDrain();
  }
}

function sealEventLogAndTriggerDrain(input, deviceId, repository) {
  const sealedEventLog = sealEventLog(repository);
  const sealedAuditLog = sealOrganizationAuditEventLog();
  if (sealedEventLog || sealedAuditLog) {
    spawnDetachedDrain();
  }
}

function listSealedEventLogs() {
  const files = [];
  const contexts = [
    ...listRepositoryQueueContexts(),
    ...listOrganizationAuditQueueContexts(),
  ];
  for (const context of contexts) {
    try {
      files.push(...fs.readdirSync(context.root)
        .filter((file) => /^events\.jsonl\.\d+$/.test(file))
        .map((file) => path.join(context.root, file))
        .filter((filePath) => {
          try { return fs.statSync(filePath).isFile(); } catch { return false; }
        }));
    } catch {}
  }
  return files;
}

// Tally { ok, error } results from a batch into { ok: <count>, errors: [...] }.
function tally(results) {
  let ok = 0;
  const errors = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      if (r.value.ok) ok++;
      else if (r.value.error) errors.push(r.value.error);
    } else if (r.status === "rejected") {
      errors.push(r.reason && r.reason.message ? r.reason.message : String(r.reason));
    }
  }
  return { ok, errors };
}

// Returns { ok: <#uploaded>, errors: [...] } for this batch.
async function drainFailedLogs(timeoutMs) {
  const lock = acquireQueueDrainLock("events");
  if (!lock) return { ok: 0, errors: [] };
  try {
    purgeDisallowedQueues();
    purgeDisallowedOrganizationAuditQueues();
    const files = listSealedEventLogs();
    // Empty queue: do nothing — never fire a refresh on an idle daemon sweep.
    if (files.length === 0) return { ok: 0, errors: [] };
    if (telemetryStore.getGlobalDisabled()) {
      return { ok: 0, errors: [] };
    }

    console.error(`[skillmeter] Draining ${files.length} failed log file(s)`);
    // Best-effort, single-flight refresh once per batch so every file in this
    // drain sends with the freshest token. Non-blocking and never throws.
    await ensureFreshLicense(credstore.getDeviceId());
    const upload = (batch) => Promise.allSettled(
      batch.map((filePath) => transferEventLog(filePath, timeoutMs))
    );
    const results = await retryUnauthorizedOnce(files, await upload(files), upload);
    return tally(results);
  } finally {
    releaseQueueDrainLock(lock);
  }
}

// A 401 means the server rejected the token even though it looked fresh here
// (a clock that runs ahead, a key rotation). Refresh once, bypassing the local
// expiry check, and resend only the rejected files. Results keep input order.
async function retryUnauthorizedOnce(files, results, upload) {
  const rejected = files
    .map((file, index) => ({ file, index }))
    .filter(({ index }) => results[index]?.value?.unauthorized);
  if (rejected.length === 0) return results;
  const before = credstore.getLicenseTokenUncached();
  const after = await ensureFreshLicense(credstore.getDeviceId(), { force: true });
  if (!after || after === before) return results;
  const retried = await upload(rejected.map(({ file }) => file));
  const merged = results.slice();
  rejected.forEach(({ index }, i) => { merged[index] = retried[i]; });
  return merged;
}

/**
 * Send queued BackfillCompleted events. Each belongs to an accepted import and
 * goes only where its chunks may: the offer must still be kept, the signed-in
 * tenant must be the one that accepted it, and its organization must still be
 * licensed. Signed out, paused, or with a stale token it waits; another tenant
 * or a dropped offer deletes it unsent. Returns the number sent.
 */
async function drainBackfillEvents(timeoutMs = EVENT_TIMEOUT) {
  const files = listBackfillEvents();
  if (files.length === 0) return 0;
  const lock = acquireQueueDrainLock("backfill-events");
  if (!lock) return 0;
  let sent = 0;
  try {
    for (const file of files) {
      const entry = readBackfillEvent(file);
      if (!entry) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      if (telemetryStore.getGlobalDisabled()) return sent;
      if (!isChunkEligible(entry.retry, Date.now())) continue;

      const expectedTenant = backfillOfferTenant(entry.offerId);
      const currentTenant = currentTenantFingerprint();
      if (
        !isBackfillOfferAccepted(entry.offerId) ||
        !expectedTenant ||
        (currentTenant && currentTenant !== expectedTenant)
      ) {
        appendBackfillLog("event_dropped", { offerId: entry.offerId });
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      if (!credstore.getAllowedGitHubOrgs().includes(entry.org)) continue;

      await ensureFreshLicense(credstore.getDeviceId());
      const token = credstore.getLicenseTokenUncached();
      if (!token || isJwtExpired(token)) continue;
      // The token this request carries, not a later re-read of it.
      if (tenantFingerprint(token, credstore.getHashSalt()) !== expectedTenant) continue;
      const endpoint = getEndpointFromTokenAllowExpired(token);
      if (!endpoint) continue;

      const body = Buffer.from(JSON.stringify(entry.event) + "\n");
      let error = "";
      try {
        const res = await fetch(`${endpoint}/logs/claude`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-ndjson",
            "Content-Encoding": "gzip",
            "X-Plugin-Version": PLUGIN_VERSION,
            "X-Idempotency-Key": `backfill-completed:${entry.offerId}`,
            "Authorization": `Bearer ${token}`,
          },
          body: zlib.gzipSync(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          try { fs.unlinkSync(file); } catch {}
          appendBackfillLog("event_sent", {
            offerId: entry.offerId,
            outcome: entry.event.data?.outcome,
          });
          sent++;
          continue;
        }
        // A rejected token spends no attempt; the next drain refreshes it.
        if (res.status === 401) continue;
        error = `HTTP ${res.status}`;
      } catch (err) {
        error = err.message;
      }
      const retry = recordUploadFailure(entry.retry, { error });
      if (isChunkExhausted(retry)) {
        appendBackfillLog("event_abandoned", { offerId: entry.offerId, error });
        try { fs.unlinkSync(file); } catch {}
      } else {
        try { atomicWriteJson(file, { ...entry, retry }); } catch {}
      }
    }
    return sent;
  } finally {
    releaseQueueDrainLock(lock);
  }
}

// Drain both queues once. Record an upload-result sentinel so the next
// SessionStart can surface a one-line notice: success when anything uploaded,
// or a failure (with the error) when nothing uploaded but a real transmission
// error occurred. This is the single choke point every drain path funnels
// through, so the notice reflects at most one outcome per drain.
async function drainQueuesOnce(timeoutMs) {
  const ev = await drainFailedLogs(timeoutMs);
  const dc = await drainDeltaChunks(timeoutMs);
  // After the chunks: settling the import's last chunk queues its event.
  try { await drainBackfillEvents(timeoutMs); } catch {}
  const events = ev.ok;
  const transcripts = dc.ok;
  const errors = [...ev.errors, ...dc.errors];
  if (events + transcripts > 0) {
    credstore.writeUploadResult({ events, transcripts });
  } else if (errors.length > 0) {
    credstore.writeUploadResult({ error: errors[0] });
  }
  return { events, transcripts, errors };
}

// Transcript ids any repository holds a cursor for.
function transcriptsWithCursors() {
  const ids = new Set();
  for (const context of listRepositoryQueueContexts()) {
    try {
      for (const f of fs.readdirSync(context.cursors)) {
        if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
      }
    } catch {}
  }
  return ids;
}

// The transcript marks in `dir`, one file per transcript named
// <transcriptId><suffix>, that may age out. A mark holds back what a cursor
// behind it would send, and cursors are never removed, so a mark is kept
// while any repository holds a cursor for its transcript.
function uncursoredTranscriptMarks(dir, suffix, cursored) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => !(f.endsWith(suffix) && cursored.has(f.slice(0, -suffix.length))))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Delete event logs already delivered (the `.sent` markers), chunks that spent
 * their retry budget long ago, and old transcript marks no cursor still needs.
 * Unsent repository-bound chunks and cursors are intentionally retained.
 */
function cleanupStaleFiles() {
  const now = Date.now();
  const candidates = [];
  const unsent = [];

  for (const context of listRepositoryQueueContexts()) {
    try {
      for (const f of fs.readdirSync(context.root)) {
        if (f === "events.jsonl" || /^events\.jsonl\.\d+$/.test(f)) {
          unsent.push(path.join(context.root, f));
        }
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(context.chunks)) {
        if (f.endsWith(".jsonl") || f.endsWith(".meta.json")) {
          unsent.push(path.join(context.chunks, f));
        }
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(context.root)) {
        if (/^events\.jsonl\.\d+\.sent$/.test(f)) {
          candidates.push(path.join(context.root, f));
        }
      }
    } catch {}
    // Quarantined chunks are kept so a rejection the backend later learns to
    // accept can be restored by hand, but they are whole transcript slices —
    // tens of megabytes each — so they age out on the same clock as everything
    // else here rather than sitting on disk forever.
    try {
      for (const f of fs.readdirSync(context.chunks)) {
        if (f.endsWith(QUARANTINE_SUFFIX)) {
          candidates.push(path.join(context.chunks, f));
        }
      }
    } catch {}
  }

  for (const context of listOrganizationAuditQueueContexts()) {
    try {
      for (const f of fs.readdirSync(context.root)) {
        if (/^events\.jsonl\.\d+\.sent$/.test(f)) {
          candidates.push(path.join(context.root, f));
        }
      }
    } catch {}
  }

  // Marks and pending boundaries guard what a later staging must skip, which
  // can be more than 30 days away, so all three follow the same rule. A
  // transcript no repository holds a cursor for still loses them after 30
  // days: a repository that records it later starts at the turn it is first
  // seen in, but one that stages it with no prompt, at session end, does not.
  const cursored = transcriptsWithCursors();
  candidates.push(...uncursoredTranscriptMarks(UNLICENSED_MARK_DIR, ".json", cursored));
  candidates.push(...uncursoredTranscriptMarks(PENDING_BOUNDARY_DIR, ".ndjson", cursored));
  candidates.push(...uncursoredTranscriptMarks(UNRECORDED_TURN_DIR, ".ndjson", cursored));

  if (fs.existsSync(LOG_DIR)) {
    try {
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (/^events\.jsonl\.\d+\.sent$/.test(f)) {
          candidates.push(path.join(LOG_DIR, f));
        }
      }
    } catch {
      // fall through
    }
  }

  // Each session's last collection state, and the last sign-in result its
  // notice showed. A session ends without saying so, so its files age out
  // here. Both directories are the notices' own, so a lock a killed hook left
  // behind ages out too; no hook holds one for more than seconds.
  const { SESSION_STATE_DIR, SIGNIN_NOTICE_DIR } = require("./collection-notice");
  for (const dir of [SESSION_STATE_DIR, SIGNIN_NOTICE_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) candidates.push(path.join(dir, f));
    } catch {}
  }

  let deleted = 0;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && now - st.mtimeMs > CLEANUP_MAX_AGE_MS) {
        fs.unlinkSync(p);
        deleted++;
      }
    } catch {
      // Ignore per-file errors; another session will try again.
    }
  }

  if (deleted > 0) {
    console.error(`[skillmeter] Cleaned up ${deleted} stale file(s) older than 30 days`);
  }

  let expired = 0;
  for (const p of unsent) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && now - st.mtimeMs > UNSENT_MAX_AGE_MS) {
        fs.unlinkSync(p);
        expired++;
      }
    } catch {}
  }
  if (expired > 0) {
    console.error(`[skillmeter] Deleted ${expired} unsent file(s) older than 7 days`);
  }
  cleanupStaleSessionContexts(CLEANUP_MAX_AGE_MS, now);
}

module.exports = {
  readCursor,
  writeCursor,
  sealDeltaChunk,
  stageTranscriptDelta,
  stageTranscriptSnapshot,
  advanceCursorToTranscriptTail,
  startTranscriptAtTurn,
  markUnrecordedTurn,
  markUnlicensedTranscript,
  recordPendingBoundary,
  transcriptTailUuid,
  listDeltaChunks,
  buildChunkHeaders,
  sealFinalSessionArtifacts,
  initializeTranscriptCursor,
  discardSkippedSessionArtifacts,
  clearDrainOnceLock,
  spawnDetachedDrain,
  drainFailedLogs,
  drainDeltaChunks,
  drainBackfillEvents,
  drainQueuesOnce,
  cleanupStaleFiles,
  purgeRepositoryQueue,
  purgeOrganizationQueues,
  purgeOrganizationAuditQueues,
  purgeDisallowedQueues,
  purgeDisallowedOrganizationAuditQueues,
  listRepositoryQueueContexts,
  listOrganizationAuditQueueContexts,
  sealOrganizationAuditEventLog,
};

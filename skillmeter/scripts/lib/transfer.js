/**
 * Transport layer: durable event/transcript queues, upload retries, and
 * age-based cleanup.
 *
 * The filesystem is the source of truth. Hooks append to the active
 * `events.jsonl`, final-session hooks seal it to `events.jsonl.<ts>`, and the
 * SessionStart hook / retry monitor drain sealed event logs plus queued
 * transcript delta chunks in the background.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { spawn } = require("child_process");

const credstore = require("../credstore");
const { getEndpointFromTokenAllowExpired, isJwtExpired } = require("./jwt");
const { ensureFreshLicense } = require("./license-activation");
const { getEventTimeoutMs, getTranscriptChunkMaxBytes } = require("./config");
const { atomicWriteJson, safeReadJson } = require("./io");
const { parseJsonl, buildChunkPlan } = require("./transcript-delta");
const {
  PLUGIN_ROOT,
  LOG_DIR,
  LOG_FILE,
  TRANSCRIPTS_PENDING_DIR,
  TRANSCRIPTS_CHUNKS_DIR,
  TRANSCRIPTS_CURSORS_DIR,
  LEGACY_LOG_DIR,
  PLUGIN_VERSION,
} = require("./paths");

// Async gzip for transcript uploads — keeps the hook's event loop responsive
// while compressing multi-MB transcripts. Sync variants are still used for
// small event-log payloads where the latency is negligible.
const gzipAsync = promisify(zlib.gzip);

const EVENT_TIMEOUT = getEventTimeoutMs();
const TRANSCRIPT_TIMEOUT = 30_000;

// How long we keep uploaded `.sent` event logs and queued transcript artifacts
// before the SessionStart sweep deletes them. 30 days is long enough to
// survive vacations and short outages; short enough that disks don't fill
// up if ingest breaks for weeks.
const CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DRAIN_ONCE_LOCK_FILE = path.join(LOG_DIR, ".drain-once.lock");
const DRAIN_ONCE_LOCK_STALE_MS = 30_000;

/**
 * Upload an event log file to the backend via fetch + gzip.
 * On success (2xx), renames the file to `.sent`; on failure, leaves it for
 * the next SessionStart's retryFailedLogs sweep.
 * @returns {Promise<void>}
 */
// Returns { ok } on success, { ok:false, error } on a real transmission failure
// (HTTP status / network), or { ok:false } for a precondition skip (no file,
// no token, no endpoint) — precondition skips carry no `error` so they aren't
// reported as send failures (the not-signed-in banner already covers those).
async function transferEventLog(logFile, timeoutMs = EVENT_TIMEOUT) {
  if (!logFile || !fs.existsSync(logFile)) return { ok: false };
  if (!credstore.isTelemetryTransmissionAllowed()) {
    console.error(`[skillmeter] Event log: telemetry not authorized for the current org — leaving for retry`);
    return { ok: false };
  }

  // A valid (non-expired) license JWT is REQUIRED — the backend does not accept
  // unauthenticated telemetry. No valid token → leave the file for retry (the
  // drain batch calls ensureFreshLicense first, and SessionStart / the monitor
  // retry once a fresh license is available). Uncached read so the long-lived
  // daemon sees a token refreshed by another process.
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
    const res = await fetch(`${endpoint}/logs/claude`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "X-Plugin-Version": PLUGIN_VERSION,
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
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    console.error(`[skillmeter] Event log transfer error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Seal the active event log into a retryable batch. This is a local durable
 * queue transition only; network upload is handled by retryFailedLogs().
 * @returns {string|null} sealed file path when a log was rotated.
 */
function sealEventLog() {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`[skillmeter] No event log to seal`);
    return null;
  }

  const baseTimestamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = `${baseTimestamp + attempt}`;
    const sealedFile = `${LOG_FILE}.${suffix}`;
    if (fs.existsSync(sealedFile)) continue;

    try {
      fs.renameSync(LOG_FILE, sealedFile);
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

function spawnDetachedDrain() {
  if (!shouldSpawnDrainOnce()) return false;

  const script = path.join(PLUGIN_ROOT, "scripts", "drain_once.js");
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    console.error(`[skillmeter] Drain trigger spawned: pid=${child.pid}`);
    return true;
  } catch (err) {
    clearDrainOnceLock();
    console.error(`[skillmeter] Drain trigger spawn failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Delta transcript upload (uuid-cursor)
//
// Instead of re-staging the whole transcript every Stop, seal only the lines
// added since the last-sent uuid as durable chunks the drain uploads
// independently. See scripts/lib/transcript-delta.js for the pure planning.
// ---------------------------------------------------------------------------

function cursorPath(transcriptId) {
  return path.join(TRANSCRIPTS_CURSORS_DIR, `${transcriptId}.json`);
}

// Uncached (direct disk) read so a cursor advanced by one process is seen by
// another (Stop vs detached drain vs monitor), matching getLicenseTokenUncached.
function readCursor(transcriptId) {
  return safeReadJson(cursorPath(transcriptId), null);
}

// Persist the delta cursor atomically. Best-effort: a failed write just means
// the next Stop recomputes from the old cursor (chunks are idempotent by uuid).
function writeCursor(cursor) {
  try {
    atomicWriteJson(cursorPath(cursor.transcriptId), cursor);
  } catch (err) {
    console.error(`[skillmeter] Transcript cursor write failed: ${err.message}`);
  }
}

// Seal one delta chunk as a durable body (.jsonl) + sidecar (.meta.json). The
// meta is written (durable) BEFORE the body is atomically published, so
// listDeltaChunks (which keys off the body) never yields a body without meta.
// Returns the body path, or null on failure.
function sealDeltaChunk(transcriptId, lines, meta) {
  try {
    fs.mkdirSync(TRANSCRIPTS_CHUNKS_DIR, { recursive: true });
  } catch (err) {
    console.error(`[skillmeter] Delta chunk seal failed (mkdir): ${err.message}`);
    return null;
  }

  const body = lines.join("\n") + "\n";
  const baseTs = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = `${baseTs + attempt}-${process.pid}`;
    const bodyPath = path.join(TRANSCRIPTS_CHUNKS_DIR, `${base}.jsonl`);
    const metaPath = path.join(TRANSCRIPTS_CHUNKS_DIR, `${base}.meta.json`);
    if (fs.existsSync(bodyPath) || fs.existsSync(metaPath)) continue;

    const tmpPath = `${bodyPath}.tmp.${process.pid}.${baseTs}`;
    try {
      const fd = fs.openSync(tmpPath, "w", 0o600);
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      atomicWriteJson(metaPath, { transcriptId, ...meta, createdAt: baseTs });
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
  if (!fs.existsSync(TRANSCRIPTS_CHUNKS_DIR)) return [];
  try {
    return fs.readdirSync(TRANSCRIPTS_CHUNKS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(TRANSCRIPTS_CHUNKS_DIR, f))
      .filter((bodyPath) => {
        try {
          return (
            fs.statSync(bodyPath).isFile() &&
            fs.existsSync(bodyPath.replace(/\.jsonl$/, ".meta.json"))
          );
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

// Build the HTTP headers for a delta chunk upload. Pure (no fs/network) so the
// X-Chunk-Reset / X-Prompt-ID logic is unit-testable.
function buildChunkHeaders(meta, deviceId, token) {
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
  return headers;
}

// Upload one delta chunk. On 2xx, deletes the body then the meta; otherwise
// leaves both for retry. Result shape matches drainFailedLogs entries.
async function uploadDeltaChunk(bodyPath, deviceId, timeoutMs = TRANSCRIPT_TIMEOUT) {
  if (!bodyPath || !fs.existsSync(bodyPath)) return { ok: false };
  if (!credstore.isTelemetryTransmissionAllowed()) {
    console.error(`[skillmeter] Transcript chunk: telemetry not authorized for the current org — kept for retry`);
    return { ok: false };
  }
  const metaPath = bodyPath.replace(/\.jsonl$/, ".meta.json");
  const meta = safeReadJson(metaPath, null);
  if (!meta) {
    console.error(`[skillmeter] Transcript chunk: missing meta for ${path.basename(bodyPath)}`);
    return { ok: false };
  }

  const token = credstore.getLicenseTokenUncached();
  if (!token || isJwtExpired(token)) {
    console.error(`[skillmeter] Transcript chunk: no valid license JWT — kept for retry`);
    return { ok: false };
  }
  const endpoint = getEndpointFromTokenAllowExpired(token);
  if (!endpoint) {
    console.error(`[skillmeter] Transcript chunk: no telemetry endpoint resolvable — kept for retry`);
    return { ok: false };
  }

  let compressed;
  try {
    const raw = await fsp.readFile(bodyPath);
    compressed = await gzipAsync(raw);
  } catch (err) {
    console.error(`[skillmeter] Transcript chunk gzip failed: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const removeChunk = () => {
    try { fs.unlinkSync(bodyPath); } catch {}
    try { fs.unlinkSync(metaPath); } catch {}
  };

  console.error(
    `[skillmeter] Transferring transcript chunk: ${meta.transcriptId} seq=${meta.seq} (${compressed.length} bytes gzipped)`
  );

  try {
    const res = await fetch(`${endpoint}/logs/claude/transcript`, {
      method: "POST",
      headers: buildChunkHeaders(meta, deviceId, token),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      console.error(`[skillmeter] Transcript chunk transferred: ${meta.transcriptId} seq=${meta.seq}`);
      removeChunk();
      return { ok: true };
    }
    console.error(`[skillmeter] Transcript chunk transfer failed: HTTP ${res.status} — kept for retry`);
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    console.error(`[skillmeter] Transcript chunk transfer error: ${err.message} — kept for retry`);
    return { ok: false, error: err.message };
  }
}

// Returns { ok: <#uploaded>, errors: [...] } for this batch.
async function drainDeltaChunks(timeoutMs) {
  const files = listDeltaChunks();
  if (files.length === 0) return { ok: 0, errors: [] };
  if (!credstore.isTelemetryTransmissionAllowed()) {
    return { ok: 0, errors: [] };
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) return { ok: 0, errors: [] };

  console.error(`[skillmeter] Draining ${files.length} transcript chunk(s)`);
  // Best-effort, single-flight refresh once per batch (see drainFailedLogs).
  await ensureFreshLicense(deviceId);
  const results = await Promise.allSettled(files.map((f) => uploadDeltaChunk(f, deviceId, timeoutMs)));
  return tally(results);
}

/**
 * Stage a transcript delta: seal the lines added since the cursor's uuid as
 * durable chunks, then advance the cursor. The cursor advances only after every
 * chunk seals, so a partial failure re-sends the full delta next Stop (chunks
 * are idempotent by uuid). Returns { chunks: <#sealed> }.
 */
function stageTranscriptDelta(transcriptPath, promptId, deviceId) {
  const transcriptId = path.basename(transcriptPath);

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (err) {
    console.error(`[skillmeter] Transcript delta read failed: ${err.message}`);
    return { chunks: 0 };
  }

  const cursor = readCursor(transcriptId);
  const { objs } = parseJsonl(raw);
  const hashSalt = credstore.getOrCreateHashSalt();

  const plan = buildChunkPlan(objs, cursor, hashSalt, {
    seqStart: (cursor && cursor.seq) || 0,
    maxUncompressedBytes: getTranscriptChunkMaxBytes(),
  });

  if (!plan.newCursor) return { chunks: 0 }; // empty delta — cursor untouched

  let sealed = 0;
  for (const chunk of plan.chunks) {
    const bodyPath = sealDeltaChunk(transcriptId, chunk.lines, {
      seq: chunk.seq,
      reset: chunk.reset,
      resetBaselineSeq: chunk.resetBaselineSeq,
      promptId,
    });
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
    });
  }
  return { chunks: sealed };
}

/**
 * Seal final-session artifacts into durable queues. Network upload is left to
 * SessionStart retry and the plugin monitor, keeping async hooks short.
 */
function sealFinalSessionArtifacts(input, deviceId) {
  const sealedEventLog = sealEventLog();
  let stagedTranscript = false;

  if (input && input.transcript_path && fs.existsSync(input.transcript_path)) {
    const id = deviceId || credstore.getDeviceId();
    const res = stageTranscriptDelta(input.transcript_path, input.prompt_id, id);
    stagedTranscript = res && res.chunks > 0;
  } else {
    console.error(`[skillmeter] No transcript to stage`);
  }

  if (sealedEventLog || stagedTranscript) {
    spawnDetachedDrain();
  }
}

function sealEventLogAndTriggerDrain() {
  if (sealEventLog()) {
    spawnDetachedDrain();
  }
}

// One-time forward migration of the durable event-log queue. Older hosts
// (without CLAUDE_PLUGIN_DATA) kept sealed event logs under PLUGIN_ROOT/logs,
// which the host deletes ~7 days after a plugin update. Copy any un-uploaded
// event logs into the persistent LOG_DIR so an in-place upgrade doesn't strand
// them. Best-effort, copy (not move) + skip-existing, so it's safe to run every
// session and a no-op when the paths coincide. (Legacy full-transcript pending
// files are NOT migrated — transcript upload is delta-only now.)
function migrateLegacyQueue() {
  if (LEGACY_LOG_DIR === LOG_DIR) return; // CLAUDE_PLUGIN_DATA unavailable
  if (!fs.existsSync(LEGACY_LOG_DIR)) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const f of fs.readdirSync(LEGACY_LOG_DIR)) {
      const src = path.join(LEGACY_LOG_DIR, f);
      try { if (!fs.statSync(src).isFile()) continue; } catch { continue; }
      if (/^events\.jsonl\.\d+$/.test(f)) {
        // Already-sealed batch → copy under the same name.
        const dest = path.join(LOG_DIR, f);
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      } else if (f === "events.jsonl") {
        // Seal the legacy active log into a batch the drain recognizes.
        const dest = path.join(LOG_DIR, `events.jsonl.${Date.now()}`);
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      }
      // Skip *.sent (already delivered) and lock files.
    }
  } catch {}
}

function listSealedEventLogs() {
  if (!fs.existsSync(LOG_DIR)) return [];

  try {
    return fs.readdirSync(LOG_DIR)
      .filter((file) => /^events\.jsonl\.\d+$/.test(file))
      .map((file) => path.join(LOG_DIR, file))
      .filter((filePath) => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

// Total queued (un-uploaded) artifacts: sealed event logs + delta transcript
// chunks. Used by the retry daemon to detect drain progress for backoff.
function queuedFileCount() {
  return listSealedEventLogs().length + listDeltaChunks().length;
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
  const files = listSealedEventLogs();
  // Empty queue: do nothing — never fire a refresh on an idle daemon sweep.
  if (files.length === 0) return { ok: 0, errors: [] };
  if (!credstore.isTelemetryTransmissionAllowed()) {
    return { ok: 0, errors: [] };
  }

  console.error(`[skillmeter] Draining ${files.length} failed log file(s)`);
  // Best-effort, single-flight refresh once per batch so every file in this
  // drain sends with the freshest token. Non-blocking and never throws.
  await ensureFreshLicense(credstore.getDeviceId());
  const results = await Promise.allSettled(files.map((filePath) => transferEventLog(filePath, timeoutMs)));
  return tally(results);
}

// Drain both queues once. Record an upload-result sentinel so the next
// SessionStart can surface a one-line notice: success when anything uploaded,
// or a failure (with the error) when nothing uploaded but a real transmission
// error occurred. This is the single choke point every drain path funnels
// through, so the notice reflects at most one outcome per drain.
async function drainQueuesOnce(timeoutMs) {
  const ev = await drainFailedLogs(timeoutMs);
  const dc = await drainDeltaChunks(timeoutMs);
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

/**
 * Retry failed event log transfers. Matches files under LOG_DIR named
 * `events.jsonl.<timestamp>` (the pre-`.sent` state) and fires
 * transferEventLog for each.
 */
function retryFailedLogs() {
  void drainFailedLogs();
}

/**
 * Retry failed transcript uploads. Scans the delta chunk queue and fires an
 * upload for every chunk left behind by a previous session. Each upload is
 * fire-and-forget; on 2xx the chunk is removed, otherwise it stays for the
 * next session.
 */
function retryFailedTranscripts() {
  void drainDeltaChunks();
}

/**
 * Delete stale files from LOG_DIR and TRANSCRIPTS_PENDING_DIR. Called from
 * SessionStart right after the retry funcs so failed retries stay around
 * for at least one more session, and nothing that retryFailedTranscripts
 * just kicked off gets yanked out from under the fetch.
 */
function cleanupStaleFiles() {
  const now = Date.now();
  const candidates = [];

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

  // Orphan GC only: the legacy full-file pending queue is no longer written or
  // uploaded (transcript upload is delta-only). Sweep it so any full transcript
  // left by a pre-cutover client version is eventually reclaimed off disk.
  if (fs.existsSync(TRANSCRIPTS_PENDING_DIR)) {
    try {
      for (const f of fs.readdirSync(TRANSCRIPTS_PENDING_DIR)) {
        candidates.push(path.join(TRANSCRIPTS_PENDING_DIR, f));
      }
    } catch {
      // fall through
    }
  }

  // Delta chunk bodies + sidecar metas (and any orphaned .tmp). Cursors are
  // deliberately NOT swept here — they must outlive gaps (vacations, long
  // --resume) so the delta continues instead of full-resending.
  if (fs.existsSync(TRANSCRIPTS_CHUNKS_DIR)) {
    try {
      for (const f of fs.readdirSync(TRANSCRIPTS_CHUNKS_DIR)) {
        candidates.push(path.join(TRANSCRIPTS_CHUNKS_DIR, f));
      }
    } catch {
      // fall through
    }
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
}

module.exports = {
  sealEventLogAndTriggerDrain,
  readCursor,
  writeCursor,
  sealDeltaChunk,
  listDeltaChunks,
  buildChunkHeaders,
  sealFinalSessionArtifacts,
  clearDrainOnceLock,
  drainFailedLogs,
  drainDeltaChunks,
  drainQueuesOnce,
  queuedFileCount,
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
  migrateLegacyQueue,
};

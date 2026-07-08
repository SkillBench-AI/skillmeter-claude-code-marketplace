/**
 * Transport layer: durable event/transcript queues, upload retries, and
 * age-based cleanup.
 *
 * The filesystem is the source of truth. Hooks append to the active
 * `events.jsonl`, final-session hooks seal it to `events.jsonl.<ts>`, and the
 * SessionStart hook / retry monitor drain sealed event logs plus pending
 * transcripts in the background.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { spawn } = require("child_process");

const credstore = require("../credstore");
const { sanitizeTranscript } = require("./sanitize");
const { getEndpointFromTokenAllowExpired, isJwtExpired } = require("./jwt");
const { ensureFreshLicense } = require("./license-activation");
const { getEventTimeoutMs } = require("./config");
const {
  PLUGIN_ROOT,
  LOG_DIR,
  LOG_FILE,
  TRANSCRIPTS_PENDING_DIR,
  LEGACY_LOG_DIR,
  PLUGIN_VERSION,
} = require("./paths");

// Async gzip for transcript uploads — keeps the hook's event loop responsive
// while compressing multi-MB transcripts. Sync variants are still used for
// small event-log payloads where the latency is negligible.
const gzipAsync = promisify(zlib.gzip);

const EVENT_TIMEOUT = getEventTimeoutMs();
const TRANSCRIPT_TIMEOUT = 30_000;
const SESSION_END_DRAIN_TIMEOUT_MS = 5_000;

// How long we keep uploaded `.sent` event logs and pending transcripts
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

/**
 * Stage a transcript for upload: sanitize the JSONL content and write it to
 * the pending directory. The staged file is the source of truth for both the
 * initial upload attempt and any later retry — we no longer depend on the
 * original transcript path existing.
 *
 * Returns the pending file path on success, or null when staging fails.
 */
function stageTranscriptForUpload(transcriptPath) {
  try {
    fs.mkdirSync(TRANSCRIPTS_PENDING_DIR, { recursive: true });
  } catch (err) {
    console.error(`[skillmeter] Transcript staging failed (mkdir): ${err.message}`);
    return null;
  }

  const transcriptId = path.basename(transcriptPath);
  const pendingPath = path.join(TRANSCRIPTS_PENDING_DIR, transcriptId);

  try {
    const hashSalt = credstore.getOrCreateHashSalt();
    const sanitized = hashSalt
      ? sanitizeTranscript(transcriptPath, hashSalt)
      : fs.readFileSync(transcriptPath);
    // Overwrite previous snapshots of the same transcript — a long session
    // re-stages on every Stop and we always want the latest lines.
    fs.writeFileSync(pendingPath, sanitized);
    return pendingPath;
  } catch (err) {
    console.error(`[skillmeter] Transcript staging failed: ${err.message}`);
    return null;
  }
}

/**
 * Upload a staged pending transcript file. On 2xx, deletes the pending file.
 * On failure, leaves it on disk for the next SessionStart retry.
 * @returns {Promise<{ok:boolean, error?:string}>} same result shape as
 *   transferEventLog: `error` is set only on a real transmission failure.
 */
async function uploadPendingTranscript(pendingPath, deviceId, timeoutMs = TRANSCRIPT_TIMEOUT) {
  if (!pendingPath || !fs.existsSync(pendingPath)) return { ok: false };

  // A valid (non-expired) license JWT is REQUIRED — the backend does not accept
  // unauthenticated telemetry. No valid token → leave the pending file for retry.
  const token = credstore.getLicenseTokenUncached();
  if (!token || isJwtExpired(token)) {
    console.error(`[skillmeter] Transcript: no valid license JWT — kept pending for next session`);
    return { ok: false };
  }

  const endpoint = getEndpointFromTokenAllowExpired(token);
  if (!endpoint) {
    console.error(`[skillmeter] Transcript: no telemetry endpoint resolvable from license JWT — leaving for retry`);
    return { ok: false };
  }

  const transcriptId = path.basename(pendingPath);

  let compressed;
  try {
    const raw = await fsp.readFile(pendingPath);
    compressed = await gzipAsync(raw);
  } catch (err) {
    console.error(`[skillmeter] Transcript gzip failed for ${transcriptId}: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const doPost = () =>
    fetch(`${endpoint}/logs/claude/transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "X-Device-ID": deviceId,
        "X-Transcript-ID": transcriptId,
        "X-Plugin-Version": PLUGIN_VERSION,
        "Authorization": `Bearer ${token}`,
      },
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });

  const removePending = () => {
    try { fs.unlinkSync(pendingPath); } catch {}
  };

  console.error(`[skillmeter] Transferring transcript: ${transcriptId} (${compressed.length} bytes gzipped)`);

  try {
    const res = await doPost();
    if (res.ok) {
      console.error(`[skillmeter] Transcript transferred: ${transcriptId}`);
      removePending();
      return { ok: true };
    }
    console.error(`[skillmeter] Transcript transfer failed: HTTP ${res.status} — kept pending for next session`);
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    console.error(`[skillmeter] Transcript transfer error: ${err.message} — kept pending for next session`);
    return { ok: false, error: err.message };
  }
}

/**
 * Seal final-session artifacts into durable queues. Network upload is left to
 * SessionStart retry and the plugin monitor, keeping async hooks short.
 */
function sealFinalSessionArtifacts(input) {
  const sealedEventLog = sealEventLog();
  let stagedTranscript = null;

  if (input && input.transcript_path && fs.existsSync(input.transcript_path)) {
    stagedTranscript = stageTranscriptForUpload(input.transcript_path);
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

// One-time forward migration of the durable queue. Older versions (and hosts
// without CLAUDE_PLUGIN_DATA) kept sealed event logs + pending transcripts under
// PLUGIN_ROOT/logs, which the host deletes ~7 days after a plugin update. Copy
// any un-uploaded artifacts into the persistent LOG_DIR so an in-place upgrade
// doesn't strand them. Best-effort, copy (not move) + skip-existing, so it's
// safe to run every session and a no-op when the paths coincide.
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
    const legacyPending = path.join(LEGACY_LOG_DIR, "transcripts", "pending");
    if (fs.existsSync(legacyPending)) {
      fs.mkdirSync(TRANSCRIPTS_PENDING_DIR, { recursive: true });
      for (const f of fs.readdirSync(legacyPending)) {
        const src = path.join(legacyPending, f);
        try { if (!fs.statSync(src).isFile()) continue; } catch { continue; }
        const dest = path.join(TRANSCRIPTS_PENDING_DIR, f);
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      }
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

function listPendingTranscripts() {
  if (!fs.existsSync(TRANSCRIPTS_PENDING_DIR)) return [];

  try {
    return fs.readdirSync(TRANSCRIPTS_PENDING_DIR)
      .map((file) => path.join(TRANSCRIPTS_PENDING_DIR, file))
      .filter((filePath) => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

// Total queued (un-uploaded) artifacts: sealed event logs + pending
// transcripts. Used by the retry daemon to detect drain progress for backoff.
function queuedFileCount() {
  return listSealedEventLogs().length + listPendingTranscripts().length;
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

  console.error(`[skillmeter] Draining ${files.length} failed log file(s)`);
  // Best-effort, single-flight refresh once per batch so every file in this
  // drain sends with the freshest token. Non-blocking and never throws.
  await ensureFreshLicense(credstore.getDeviceId());
  const results = await Promise.allSettled(files.map((filePath) => transferEventLog(filePath, timeoutMs)));
  return tally(results);
}

// Returns { ok: <#uploaded>, errors: [...] } for this batch.
async function drainPendingTranscripts(timeoutMs) {
  const files = listPendingTranscripts();
  if (files.length === 0) return { ok: 0, errors: [] };

  const deviceId = credstore.getDeviceId();
  if (!deviceId) return { ok: 0, errors: [] };

  console.error(`[skillmeter] Draining ${files.length} pending transcript(s)`);
  // Best-effort, single-flight refresh once per batch (see drainFailedLogs).
  await ensureFreshLicense(deviceId);
  const results = await Promise.allSettled(files.map((filePath) => uploadPendingTranscript(filePath, deviceId, timeoutMs)));
  return tally(results);
}

// Drain both queues once. Record an upload-result sentinel so the next
// SessionStart can surface a one-line notice: success when anything uploaded,
// or a failure (with the error) when nothing uploaded but a real transmission
// error occurred. This is the single choke point every drain path funnels
// through, so the notice reflects at most one outcome per drain.
async function drainQueuesOnce(timeoutMs) {
  const ev = await drainFailedLogs(timeoutMs);
  const tr = await drainPendingTranscripts(timeoutMs);
  const events = ev.ok;
  const transcripts = tr.ok;
  const errors = [...ev.errors, ...tr.errors];
  if (events + transcripts > 0) {
    credstore.writeUploadResult({ events, transcripts });
  } else if (errors.length > 0) {
    credstore.writeUploadResult({ error: errors[0] });
  }
  return { events, transcripts, errors };
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => {
        console.error(`[skillmeter] ${label} timed out after ${timeoutMs} ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
}

// NOTE: these are wired directly as runHook `afterLog` / `afterSkip`, which are
// invoked as `(input, deviceId)`. They therefore take `(input)` and use the
// fixed SESSION_END_DRAIN_TIMEOUT_MS internally — never a caller-supplied
// timeout. (Previously the second param was `timeoutMs`, so it received the
// deviceId string and AbortSignal.timeout(deviceId) threw, silently failing
// every SessionEnd upload.)
async function sealFinalSessionArtifactsAndDrain(input) {
  sealEventLog();

  if (input && input.transcript_path && fs.existsSync(input.transcript_path)) {
    stageTranscriptForUpload(input.transcript_path);
  } else {
    console.error(`[skillmeter] No transcript to stage`);
  }

  const t = SESSION_END_DRAIN_TIMEOUT_MS;
  await withTimeout(drainQueuesOnce(t), t, "SessionEnd drain");
}

async function sealEventLogAndDrain() {
  sealEventLog();
  const t = SESSION_END_DRAIN_TIMEOUT_MS;
  await withTimeout(drainFailedLogs(t), t, "SessionEnd event-log drain");
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
 * Retry failed transcript uploads. Scans the pending directory and fires an
 * upload for every staged file left behind by a previous session. Each
 * upload is fire-and-forget; on 2xx the file is removed, otherwise it stays
 * for the next session.
 */
function retryFailedTranscripts() {
  void drainPendingTranscripts();
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

  if (fs.existsSync(TRANSCRIPTS_PENDING_DIR)) {
    try {
      for (const f of fs.readdirSync(TRANSCRIPTS_PENDING_DIR)) {
        candidates.push(path.join(TRANSCRIPTS_PENDING_DIR, f));
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
  EVENT_TIMEOUT,
  TRANSCRIPT_TIMEOUT,
  CLEANUP_MAX_AGE_MS,
  SESSION_END_DRAIN_TIMEOUT_MS,
  DRAIN_ONCE_LOCK_FILE,
  DRAIN_ONCE_LOCK_STALE_MS,
  transferEventLog,
  sealEventLog,
  sealEventLogAndTriggerDrain,
  stageTranscriptForUpload,
  uploadPendingTranscript,
  sealFinalSessionArtifacts,
  sealFinalSessionArtifactsAndDrain,
  sealEventLogAndDrain,
  spawnDetachedDrain,
  clearDrainOnceLock,
  drainFailedLogs,
  drainPendingTranscripts,
  drainQueuesOnce,
  queuedFileCount,
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
  migrateLegacyQueue,
};

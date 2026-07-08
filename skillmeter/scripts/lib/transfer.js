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
const { getEndpointFromToken, getEndpointFromTokenAllowExpired, isJwtExpired } = require("./jwt");
const { ensureFreshLicense } = require("./license-activation");
const { getEventTimeoutMs } = require("./config");
const {
  PLUGIN_ROOT,
  LOG_DIR,
  LOG_FILE,
  TRANSCRIPTS_PENDING_DIR,
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
async function transferEventLog(logFile, timeoutMs = EVENT_TIMEOUT) {
  if (!logFile || !fs.existsSync(logFile)) return;

  // Uncached so the long-lived daemon sees a token refreshed by another process.
  const storedToken = credstore.getLicenseTokenUncached();
  // Only attach a still-valid bearer; never send a token we know is expired.
  const initialToken = storedToken && !isJwtExpired(storedToken) ? storedToken : null;
  if (storedToken && !initialToken) {
    console.error(`[skillmeter] Event log: dropping expired license JWT before send`);
  }

  // Endpoint is routing info — resolvable even from an expired token. The
  // collector accepts unauthenticated uploads, so a drain still delivers while
  // a refresh is pending/failing.
  const endpoint = getEndpointFromToken(storedToken) || getEndpointFromTokenAllowExpired(storedToken);
  if (!endpoint) {
    console.error(`[skillmeter] Event log: no telemetry endpoint resolvable from license JWT — leaving for retry`);
    return;
  }

  const fileContent = fs.readFileSync(logFile);
  const compressed = zlib.gzipSync(fileContent);
  const baseName = path.basename(logFile);

  const buildHeaders = (token) => {
    const h = {
      "Content-Type": "application/x-ndjson",
      "Content-Encoding": "gzip",
      "X-Plugin-Version": PLUGIN_VERSION,
    };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  };

  const doPost = (token) =>
    fetch(`${endpoint}/logs/claude`, {
      method: "POST",
      headers: buildHeaders(token),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });

  const markSent = () => {
    try { fs.renameSync(logFile, `${logFile}.sent`); } catch {}
  };

  console.error(`[skillmeter] Transferring event log: ${baseName} (${compressed.length} bytes gzipped)`);

  try {
    // Bearer when a valid token exists, plain POST otherwise — the collector
    // accepts unauthenticated uploads, so the plain POST is what delivers today.
    const res = await doPost(initialToken);
    if (res.ok) {
      console.error(`[skillmeter] Event log transferred: ${baseName}`);
      markSent();
      return;
    }
    console.error(`[skillmeter] Event log transfer failed: HTTP ${res.status}`);
  } catch (err) {
    console.error(`[skillmeter] Event log transfer error: ${err.message}`);
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
 * @returns {Promise<void>} resolves after the upload attempt finishes.
 */
async function uploadPendingTranscript(pendingPath, deviceId, timeoutMs = TRANSCRIPT_TIMEOUT) {
  if (!pendingPath || !fs.existsSync(pendingPath)) return;

  const storedToken = credstore.getLicenseTokenUncached();
  const initialToken = storedToken && !isJwtExpired(storedToken) ? storedToken : null;
  if (storedToken && !initialToken) {
    console.error(`[skillmeter] Transcript: dropping expired license JWT before send`);
  }

  const endpoint = getEndpointFromToken(storedToken) || getEndpointFromTokenAllowExpired(storedToken);
  if (!endpoint) {
    console.error(`[skillmeter] Transcript: no telemetry endpoint resolvable from license JWT — leaving for retry`);
    return;
  }

  const transcriptId = path.basename(pendingPath);

  let compressed;
  try {
    const raw = await fsp.readFile(pendingPath);
    compressed = await gzipAsync(raw);
  } catch (err) {
    console.error(`[skillmeter] Transcript gzip failed for ${transcriptId}: ${err.message}`);
    return;
  }

  const buildHeaders = (token) => {
    const h = {
      "Content-Type": "application/x-ndjson",
      "Content-Encoding": "gzip",
      "X-Device-ID": deviceId,
      "X-Transcript-ID": transcriptId,
      "X-Plugin-Version": PLUGIN_VERSION,
    };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  };

  const doPost = (token) =>
    fetch(`${endpoint}/logs/claude/transcript`, {
      method: "POST",
      headers: buildHeaders(token),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs),
    });

  const removePending = () => {
    try { fs.unlinkSync(pendingPath); } catch {}
  };

  console.error(`[skillmeter] Transferring transcript: ${transcriptId} (${compressed.length} bytes gzipped)`);

  try {
    // Bearer when a valid token exists, plain POST otherwise — the collector
    // accepts unauthenticated uploads, so the plain POST is what delivers today.
    const res = await doPost(initialToken);
    if (res.ok) {
      console.error(`[skillmeter] Transcript transferred: ${transcriptId}`);
      removePending();
      return;
    }
    console.error(`[skillmeter] Transcript transfer failed: HTTP ${res.status} — kept pending for next session`);
  } catch (err) {
    console.error(`[skillmeter] Transcript transfer error: ${err.message} — kept pending for next session`);
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

async function drainFailedLogs(timeoutMs) {
  const files = listSealedEventLogs();
  // Empty queue: do nothing — never fire a refresh on an idle daemon sweep.
  if (files.length === 0) return;

  console.error(`[skillmeter] Draining ${files.length} failed log file(s)`);
  // Best-effort, single-flight refresh once per batch so every file in this
  // drain sends with the freshest token. Non-blocking and never throws.
  await ensureFreshLicense(credstore.getDeviceId());
  await Promise.allSettled(files.map((filePath) => transferEventLog(filePath, timeoutMs)));
}

async function drainPendingTranscripts(timeoutMs) {
  const files = listPendingTranscripts();
  if (files.length === 0) return;

  const deviceId = credstore.getDeviceId();
  if (!deviceId) return;

  console.error(`[skillmeter] Draining ${files.length} pending transcript(s)`);
  // Best-effort, single-flight refresh once per batch (see drainFailedLogs).
  await ensureFreshLicense(deviceId);
  await Promise.allSettled(files.map((filePath) => uploadPendingTranscript(filePath, deviceId, timeoutMs)));
}

async function drainQueuesOnce(timeoutMs) {
  await drainFailedLogs(timeoutMs);
  await drainPendingTranscripts(timeoutMs);
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

async function sealFinalSessionArtifactsAndDrain(input, timeoutMs = SESSION_END_DRAIN_TIMEOUT_MS) {
  sealEventLog();

  if (input && input.transcript_path && fs.existsSync(input.transcript_path)) {
    stageTranscriptForUpload(input.transcript_path);
  } else {
    console.error(`[skillmeter] No transcript to stage`);
  }

  await withTimeout(drainQueuesOnce(timeoutMs), timeoutMs, "SessionEnd drain");
}

async function sealEventLogAndDrain(timeoutMs = SESSION_END_DRAIN_TIMEOUT_MS) {
  sealEventLog();
  await withTimeout(drainFailedLogs(timeoutMs), timeoutMs, "SessionEnd event-log drain");
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
};

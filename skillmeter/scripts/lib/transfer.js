/**
 * Transport layer: event-log and transcript uploads, plus the persistence-
 * backed retry and age-based cleanup that sit alongside them.
 *
 * All public uploaders tolerate ingest hiccups via on-disk staging:
 *   - Event logs are rotated in-place to `events.jsonl.<ts>` before POSTing;
 *     success renames to `.sent`, failure leaves them for `retryFailedLogs`.
 *   - Transcripts are sanitised + staged under `transcripts/pending/<id>`
 *     before POSTing; success unlinks, failure leaves them for
 *     `retryFailedTranscripts`.
 *
 * Fire-and-forget is preserved for the transcript path so the Stop hook
 * never blocks the user's next turn on network.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");

const credstore = require("../credstore");
const { sanitizeTranscript } = require("./sanitize");
const { getEndpointFromToken, isJwtExpired } = require("./jwt");
const {
  LOG_DIR,
  LOG_FILE,
  TRANSCRIPTS_PENDING_DIR,
  PLUGIN_VERSION,
} = require("./paths");

// Async gzip for transcript uploads — keeps the hook's event loop responsive
// while compressing multi-MB transcripts. Sync variants are still used for
// small event-log payloads where the latency is negligible.
const gzipAsync = promisify(zlib.gzip);

const EVENT_TIMEOUT = parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
const TRANSCRIPT_TIMEOUT = 30_000;

// How long we keep uploaded `.sent` event logs and pending transcripts
// before the SessionStart sweep deletes them. 30 days is long enough to
// survive vacations and short outages; short enough that disks don't fill
// up if ingest breaks for weeks.
const CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Upload an event log file to the backend via fetch + gzip.
 * On success (2xx), renames the file to `.sent`; on failure, leaves it for
 * the next SessionStart's retryFailedLogs sweep.
 * @returns {Promise<void>}
 */
function transferEventLog(logFile) {
  if (!logFile || !fs.existsSync(logFile)) return Promise.resolve();

  const endpoint = getEndpointFromToken();
  const storedToken = credstore.getLicenseToken(LOG_DIR);
  // Proactive: if the cached JWT is already past its exp, don't send it.
  // PR #35 made Authorization optional server-side, so the request still
  // succeeds without it.
  const initialToken = storedToken && !isJwtExpired(storedToken) ? storedToken : null;
  if (storedToken && !initialToken) {
    console.error(`[skillmeter] Event log: dropping expired license JWT before send`);
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
      signal: AbortSignal.timeout(EVENT_TIMEOUT),
    });

  const markSent = () => {
    try { fs.renameSync(logFile, `${logFile}.sent`); } catch {}
  };

  console.error(`[skillmeter] Transferring event log: ${baseName} (${compressed.length} bytes gzipped)`);

  return doPost(initialToken)
    .then((res) => {
      if (res.ok) {
        console.error(`[skillmeter] Event log transferred: ${baseName}`);
        markSent();
        return;
      }
      // Reactive: server rejected our Authorization header — clear the bad
      // token so subsequent requests don't reuse it, then retry once without
      // auth.
      if (initialToken && (res.status === 401 || res.status === 403)) {
        console.error(`[skillmeter] Event log auth rejected (HTTP ${res.status}), clearing license and retrying without auth`);
        try { credstore.setLicenseToken(""); } catch {}
        return doPost(null).then((res2) => {
          if (res2.ok) {
            console.error(`[skillmeter] Event log transferred on retry: ${baseName}`);
            markSent();
          } else {
            console.error(`[skillmeter] Event log retry failed: HTTP ${res2.status}`);
          }
        });
      }
      console.error(`[skillmeter] Event log transfer failed: HTTP ${res.status}`);
    })
    .catch((err) => {
      console.error(`[skillmeter] Event log transfer error: ${err.message}`);
    });
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
    const hashSalt = credstore.getOrCreateHashSalt(LOG_DIR);
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
 * On failure, leaves it on disk for the next SessionStart retry. Fire-and-
 * forget — caller does NOT await so the Stop hook doesn't block the user.
 */
async function uploadPendingTranscript(pendingPath, deviceId) {
  if (!pendingPath || !fs.existsSync(pendingPath)) return;

  const endpoint = getEndpointFromToken();
  const storedToken = credstore.getLicenseToken(LOG_DIR);
  const initialToken = storedToken && !isJwtExpired(storedToken) ? storedToken : null;
  if (storedToken && !initialToken) {
    console.error(`[skillmeter] Transcript: dropping expired license JWT before send`);
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
      signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT),
    });

  const removePending = () => {
    try { fs.unlinkSync(pendingPath); } catch {}
  };

  console.error(`[skillmeter] Transferring transcript: ${transcriptId} (${compressed.length} bytes gzipped)`);

  doPost(initialToken).then((res) => {
    if (res.ok) {
      console.error(`[skillmeter] Transcript transferred: ${transcriptId}`);
      removePending();
      return;
    }
    if (initialToken && (res.status === 401 || res.status === 403)) {
      console.error(`[skillmeter] Transcript auth rejected (HTTP ${res.status}), clearing license and retrying without auth`);
      try { credstore.setLicenseToken(""); } catch {}
      return doPost(null).then((res2) => {
        if (res2.ok) {
          console.error(`[skillmeter] Transcript transferred on retry: ${transcriptId}`);
          removePending();
        } else {
          console.error(`[skillmeter] Transcript retry failed: HTTP ${res2.status} — kept pending for next session`);
        }
      });
    }
    console.error(`[skillmeter] Transcript transfer failed: HTTP ${res.status} — kept pending for next session`);
  }).catch((err) => {
    console.error(`[skillmeter] Transcript transfer error: ${err.message} — kept pending for next session`);
  });
}

/**
 * Stage a transcript and fire its upload. Fire-and-forget: the Stop hook
 * does NOT await this so the user's next turn is never blocked on a slow
 * network. If the upload fails, the staged file survives for the next
 * SessionStart's retryFailedTranscripts scan.
 */
function transferTranscript(transcriptPath, deviceId) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
  const pendingPath = stageTranscriptForUpload(transcriptPath);
  if (!pendingPath) return;
  uploadPendingTranscript(pendingPath, deviceId);
}

/**
 * Rotate the current event log and transfer the shared event batch.
 * @returns {Promise<void>}
 */
function flushEventLog() {
  if (fs.existsSync(LOG_FILE)) {
    try {
      const sendingFile = `${LOG_FILE}.${Date.now()}`;
      fs.renameSync(LOG_FILE, sendingFile);
      console.error(`[skillmeter] Rotated event log: ${path.basename(sendingFile)}`);
      return transferEventLog(sendingFile);
    } catch (err) {
      console.error(`[skillmeter] Event log rotation failed: ${err.message}`);
      return Promise.resolve();
    }
  }
  console.error(`[skillmeter] No event log to flush`);
  return Promise.resolve();
}

/**
 * Rotate the current event log and transfer both events and transcript.
 * Shared afterLog handler for Stop and SessionEnd hooks.
 * @returns {Promise<void>} resolves after the event-log transfer completes
 *   (transcript transfer is fire-and-forget — see transferTranscript)
 */
function flushAndTransfer(input, deviceId) {
  const eventLogPromise = flushEventLog();

  if (input.transcript_path && fs.existsSync(input.transcript_path)) {
    transferTranscript(input.transcript_path, deviceId);
  } else {
    console.error(`[skillmeter] No transcript to transfer`);
  }

  return eventLogPromise;
}

/**
 * Retry failed event log transfers. Matches files under LOG_DIR named
 * `events.jsonl.<timestamp>` (the pre-`.sent` state) and fires
 * transferEventLog for each.
 */
function retryFailedLogs() {
  if (!fs.existsSync(LOG_DIR)) return;

  try {
    const files = fs.readdirSync(LOG_DIR);
    let retryCount = 0;

    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      if (!fs.statSync(filePath).isFile()) continue;
      if (/^events\.jsonl\.\d+$/.test(file)) {
        retryCount++;
        transferEventLog(filePath);
      }
    }

    if (retryCount > 0) {
      console.error(`[skillmeter] Retrying ${retryCount} failed log file(s)`);
    }
  } catch {
    // Ignore errors during retry
  }
}

/**
 * Retry failed transcript uploads. Scans the pending directory and fires an
 * upload for every staged file left behind by a previous session. Each
 * upload is fire-and-forget; on 2xx the file is removed, otherwise it stays
 * for the next session.
 */
function retryFailedTranscripts() {
  if (!fs.existsSync(TRANSCRIPTS_PENDING_DIR)) return;

  let files;
  try {
    files = fs.readdirSync(TRANSCRIPTS_PENDING_DIR);
  } catch {
    return;
  }

  const deviceId = credstore.getDeviceId(LOG_DIR);
  if (!deviceId) return;

  let retryCount = 0;
  for (const file of files) {
    const filePath = path.join(TRANSCRIPTS_PENDING_DIR, file);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    retryCount++;
    uploadPendingTranscript(filePath, deviceId);
  }

  if (retryCount > 0) {
    console.error(`[skillmeter] Retrying ${retryCount} pending transcript(s)`);
  }
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
  transferEventLog,
  stageTranscriptForUpload,
  uploadPendingTranscript,
  transferTranscript,
  flushEventLog,
  flushAndTransfer,
  retryFailedLogs,
  retryFailedTranscripts,
  cleanupStaleFiles,
};

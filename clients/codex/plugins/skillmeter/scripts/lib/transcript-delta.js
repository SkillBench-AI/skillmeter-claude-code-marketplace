"use strict";

// Codex-specific durable chunk queue. Reuses Claude's stage/cursor/send model,
// but anchors on raw complete-byte position and prefix HMAC, not optional UUIDs.
// All files are private to PLUGIN_DATA; this module never accesses credentials.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { sanitizeLine } = require("../sanitizer");
const { sessionMetadata, sessionContinuation } = require("./session-metadata");
const health = require("./transcript-health");
const { createProjection } = require("./compaction-projection");

const MAX_ENVELOPE = 5 * 1024 * 1024; // below the 6 MiB Lambda event ceiling
const ENVELOPE_RESERVE = 128 * 1024; // headers + JSON event wrapper
const MAX_RECORD = 32 * 1024 * 1024;
const STAGE_BYTES = 8 * 1024 * 1024;
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hmac = (salt, bytes) => crypto.createHmac("sha256", salt).update(bytes).digest("hex");

let warnedDirectoryDurability = false;
function syncDir(dir) {
  // Windows cannot fsync a read-only directory handle. File data is still
  // synced before publication; do not turn a published write into a failure.
  if (process.platform === "win32") {
    if (!warnedDirectoryDurability) {
      warnedDirectoryDurability = true;
      try { console.error("[skillmeter] Windows queue directory durability is unconfirmed; directory syncing is unsupported."); } catch {}
    }
    return;
  }
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeDurable(file, bytes) {
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function recordFailure(dir, phase, code, progress = {}) { health.update(dir, phase, code, progress, writeDurable); }
function recordProgress(dir, phase, progress) { health.update(dir, phase, null, progress, writeDurable); }
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // incomplete lock: fail closed
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

// Exclusive PID lock, no expiry-based takeover of live writers. Dead-owner
// reaping is serialized for the observed inode, preventing two stale reapers
// from unlinking a newly acquired lock. A crash during reaping is recoverable.
function acquireLock(file, depth = 0) {
  if (depth > 8) return null;
  const ownerFile = `${file}.owner-${crypto.randomUUID()}`;
  const fd = fs.openSync(ownerFile, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const inode = fs.statSync(ownerFile).ino;
  try { fs.linkSync(ownerFile, file); fs.unlinkSync(ownerFile); }
  catch (e) {
    fs.unlinkSync(ownerFile);
    if (e.code !== "EEXIST") throw e;
    let st;
    try { st = fs.statSync(file); }
    catch (error) {
      if (error.code === "ENOENT") return acquireLock(file, depth + 1);
      throw error;
    }
    let owner;
    try { owner = readJson(file); }
    catch (error) {
      if (error.code === "ENOENT") return acquireLock(file, depth + 1);
      return null; // malformed ownership cannot be safely reclaimed
    }
    if (alive(owner.pid)) return null;
    const releaseReaper = acquireLock(`${file}.reap-${st.ino}`, depth + 1);
    if (!releaseReaper) return null;
    try {
      try { if (fs.statSync(file).ino === st.ino) fs.unlinkSync(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } finally { releaseReaper(); }
    return acquireLock(file, depth + 1);
  }
  return () => {
    try { if (fs.statSync(file).ino === inode) fs.unlinkSync(file); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  };
}

function prefix(fd, length, salt) {
  const hash = crypto.createHmac("sha256", salt);
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < length) {
    const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, length - position), position);
    if (!n) throw new Error("source-truncated-during-read");
    hash.update(buffer.subarray(0, n)); position += n;
  }
  return hash;
}

// The first complete line of the source, or null while none is complete.
function firstRecord(fd, size) {
  const buffer = Buffer.alloc(64 * 1024);
  const parts = [];
  let length = 0, position = 0;
  while (position < size && length <= MAX_RECORD) {
    const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (!n) break;
    position += n;
    const read = buffer.subarray(0, n);
    const end = read.indexOf(10);
    const part = Buffer.from(end >= 0 ? read.subarray(0, end + 1) : read);
    parts.push(part);
    length += part.length;
    if (end >= 0) return Buffer.concat(parts, length);
  }
  return null;
}

// Routing identity for a batch staged past the file start. A first record that
// is not a usable session_meta leaves the batch as before: content only.
function continuationLine(fd, size, salt, id, generation, options) {
  const raw = firstRecord(fd, size);
  if (!raw) return null;
  let projected;
  try {
    projected = sessionContinuation(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw).trim()));
  } catch { return null; }
  if (!projected) return null;
  if (options.authorizeRecord && !options.authorizeRecord(projected)) throw new Error("source-scope-changed");
  const sanitized = sanitizeLine(projected, salt);
  // One identity line per generation: the collector merges on uuid, so every
  // batch that lands in the same stored object collapses to a single line.
  sanitized.uuid = hmac(salt, `${id}\0${generation}\0continuation`);
  return JSON.stringify(sanitized) + "\n";
}

function encodeChunks(lines, maxEnvelope = MAX_ENVELOPE, continuation = null, startsSession = false) {
  const limit = Math.min(MAX_ENVELOPE, maxEnvelope);
  if (!Number.isFinite(limit) || limit <= ENVELOPE_RESERVE + 128) throw new Error("invalid-wire-budget");
  const output = [];
  function encode(group, first) {
    // Keep routing identity with each wire payload. Splitting a prefixed batch
    // can otherwise strand its header, or file later chunks without identity.
    const records = continuation ? [first && startsSession ? lines[0] : continuation, ...group] : group;
    const body = zlib.gzipSync(Buffer.from(records.join("")));
    if (4 * Math.ceil(body.length / 3) + ENVELOPE_RESERVE <= limit) {
      output.push({ body, records: records.length }); return;
    }
    if (group.length <= 1) throw new Error("oversized-single-record");
    const mid = Math.floor(group.length / 2);
    encode(group.slice(0, mid), first); encode(group.slice(mid), false);
  }
  if (lines.length) encode(continuation && startsSession ? lines.slice(1) : lines, true);
  return output;
}

function groups(dir) {
  return fs.readdirSync(dir).filter(n => /^batch-\d+-[a-f0-9-]+$/.test(n)).sort().map(n => path.join(dir, n));
}
function recover(dir) {
  const file = path.join(dir, "cursor.json");
  let cursor = fs.existsSync(file) ? readJson(file) : null;
  if (cursor && (cursor.version !== 1 || !Number.isSafeInteger(cursor.seq) || cursor.seq < 1)) {
    throw new Error("invalid-cursor");
  }
  // Both callers hold the queue lock. Unpublished staging directories cannot
  // belong to a live writer and are not referenced by a committed cursor.
  let reaped = false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.stage-[a-f0-9-]{36}$/.test(entry.name)) {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      reaped = true;
    }
  }
  if (reaped) syncDir(dir);
  for (const group of groups(dir)) {
    const commit = readJson(path.join(group, "commit.json"));
    if (!cursor || commit.cursor.seq > cursor.seq) {
      for (const chunk of commit.chunks) {
        if (digest(fs.readFileSync(path.join(group, chunk.file))) !== chunk.sha256) throw new Error("incomplete-transaction");
      }
      cursor = commit.cursor;
      writeDurable(file, JSON.stringify(cursor));
    }
    if (!fs.existsSync(path.join(group, "ready"))) writeDurable(path.join(group, "ready"), "1");
  }
  return cursor;
}

function validateConsent(state) {
  if (!state || state.version !== 1 || typeof state.epoch !== "string" ||
      typeof state.owner !== "string" || typeof state.fileId !== "string" ||
      typeof state.enabled !== "boolean" || typeof state.stamp !== "string" ||
      typeof state.authorization !== "string" || !Number.isSafeInteger(state.observed) || state.observed < 0 ||
      !Array.isArray(state.excluded)) throw new Error("invalid-consent-journal");
  let previous = 0;
  for (const range of state.excluded) {
    if (!Array.isArray(range) || range.length !== 2 ||
        !range.every(Number.isSafeInteger) || range[0] < previous || range[1] < range[0] ||
        range[1] > state.observed) throw new Error("invalid-consent-journal");
    previous = range[1];
  }
}

// Observe authorization at a lifecycle boundary using stat only. Ranges contain
// byte positions, never transcript content. A first observation excludes the
// existing prefix; enabling telemetry is not authorization for historical data.
function observeConsent(root, source, scope, salt, enabled, stamp, rebase = false, verifyReplacement = false) {
  const dir = path.join(root, hmac(salt, path.resolve(source)));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(dir, "lock"));
  if (!release) return null;
  try {
    const stat = fs.statSync(source), fileId = `${stat.dev}:${stat.ino}`;
    const file = path.join(dir, "consent.json");
    let state = fs.existsSync(file) ? readJson(file) : null;
    if (state) validateConsent(state);
    if (state && state.owner !== scope.owner) throw new Error("source-owner-changed");
    if (state && state.fileId !== fileId && !rebase && enabled && state.enabled && state.stamp === stamp) {
      // Hooks only stat. The background reader can prove that a restored file
      // still has the exact committed prefix before reusing its authorization.
      if (!verifyReplacement) return state;
      const cursor = fs.existsSync(path.join(dir, "cursor.json")) ? readJson(path.join(dir, "cursor.json")) : null;
      if (cursor && cursor.consentEpoch === state.epoch && state.observed <= cursor.offset && stat.size >= cursor.offset) {
        const fd = fs.openSync(source, "r");
        try {
          if (prefix(fd, cursor.offset, salt).digest("hex") === cursor.prefix) state.fileId = fileId;
        } finally { fs.closeSync(fd); }
      }
    }
    if (!state || rebase || state.authorization !== scope.consentStamp || state.fileId !== fileId || stat.size < state.observed) {
      state = { version: 1, epoch: crypto.randomUUID(), owner: scope.owner,
        fileId, observed: stat.size, excluded: [[0, stat.size]], enabled, stamp, authorization: scope.consentStamp };
    } else {
      if (!enabled || !state.enabled || state.stamp !== stamp) {
        const last = state.excluded.at(-1);
        if (last && last[1] === state.observed) last[1] = stat.size;
        else state.excluded.push([state.observed, stat.size]);
      }
      state.observed = stat.size;
      state.enabled = enabled;
      state.stamp = stamp;
    }
    // Controls can establish the next boundary even before an upload hint
    // exists. This is a source pointer and offsets only, never source content.
    state.source = path.resolve(source);
    state.cwd = scope.cwd;
    state.repoRoot = scope.repoRoot;
    writeDurable(file, JSON.stringify(state));
    return state;
  } finally { release(); }
}

function stage(root, source, scope, salt, options = {}) {
  if (options.consent) validateConsent(options.consent);
  const id = hmac(salt, path.resolve(source));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(dir, "lock"));
  if (!release) return { status: "busy", files: [] };
  let fd, capturedBytes, observedBytes;
  try {
    const cursor = recover(dir);
    capturedBytes = cursor?.offset || 0;
    if (cursor && (cursor.scope.owner !== scope.owner || cursor.scope.deviceId !== scope.deviceId)) {
      throw new Error("source-owner-changed");
    }
    fd = fs.openSync(source, "r");
    const stat = fs.fstatSync(fd);
    observedBytes = stat.size;
    if (options.consent) {
      if (!options.consent.enabled || options.consent.owner !== scope.owner ||
          JSON.stringify(readJson(path.join(dir, "consent.json"))) !== JSON.stringify(options.consent)) {
        throw new Error("consent-changed-during-stage");
      }
      stat.size = Math.min(stat.size, options.consent.observed);
    }
    const fileId = `${stat.dev}:${stat.ino}`;
    if (options.consent && options.consent.fileId !== fileId) throw new Error("consent-source-rewritten");
    let offset = cursor?.offset || 0;
    let rawPrefix;
    const requested = fs.existsSync(path.join(dir, "reset-request.json")) ? readJson(path.join(dir, "reset-request.json")) : null;
    const preserveMetadata = Boolean(options.consent && options.preserveSessionMetadata);
    let reset = !cursor || cursor.fileId !== fileId || stat.size < offset ||
      (preserveMetadata && cursor.metadataVersion !== 1) ||
      (options.consent && (cursor.consentEpoch !== options.consent.epoch || cursor.scope.consentStamp !== scope.consentStamp)) ||
      (requested && requested.baseline >= cursor.baseline);
    if (reset && cursor && options.consent && cursor.consentEpoch === options.consent.epoch &&
        (stat.size < offset || prefix(fd, offset, salt).digest("hex") !== cursor.prefix)) {
      throw new Error("consent-source-rewritten");
    }
    if (!reset) {
      rawPrefix = prefix(fd, offset, salt);
      reset = rawPrefix.digest("hex") !== cursor.prefix;
      if (reset && options.consent && cursor.consentEpoch === options.consent.epoch) {
        throw new Error("consent-source-rewritten");
      }
      if (!reset && stat.size === offset) {
        recordProgress(dir, "capture", { capturedBytes: offset, observedBytes, partial: false });
        return { status: "unchanged", files: [], partial: false };
      }
      if (!reset) rawPrefix = prefix(fd, offset, salt);
    }
    if (reset) { offset = 0; rawPrefix = prefix(fd, 0, salt); }
    const generation = reset ? (cursor?.generation || 0) + 1 : cursor.generation;
    const baseline = reset ? (cursor?.seq || 0) + 1 : cursor.baseline;
    const projectCompaction = createProjection(fd, { salt, id, generation, consent: options.consent, maxRecord: MAX_RECORD });
    // Every split wire chunk needs identity, including later chunks in the
    // initial batch. The first reset chunk keeps the real session_meta.
    const continuation = preserveMetadata ? continuationLine(fd, stat.size, salt, id, generation, options) : null;
    let pending = Buffer.alloc(0), readPosition = offset, committed = offset;
    let lineCount = reset ? 0 : cursor.lineCount;
    const lines = [];
    const buffer = Buffer.alloc(64 * 1024);
    // Fixed stage budget, except one supported large record. Partial trailing
    // bytes never enter the cursor and are reconsidered on the next capture.
    while (readPosition < stat.size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - readPosition), readPosition);
      if (!n) break;
      readPosition += n;
      pending = Buffer.concat([pending, buffer.subarray(0, n)]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const raw = pending.subarray(0, end + 1);
        if (raw.length > MAX_RECORD) throw new Error("oversized-single-record");
        const excluded = options.consent?.excluded.some(([start, end]) => committed < end && committed + raw.length > start);
        // Read only the first source record across the exclusion boundary, and
        // project only its metadata. All other excluded records stay undecoded.
        const header = preserveMetadata && committed === 0;
        const text = excluded && !header ? "" : new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
        if (text) {
          let record;
          try { record = JSON.parse(text); } catch { throw new Error("malformed-complete-record"); }
          if (!record || Array.isArray(record) || typeof record !== "object") throw new Error("malformed-complete-record");
          if (header && excluded) record = sessionMetadata(record);
          if (record) {
            if (options.authorizeRecord && !options.authorizeRecord(record)) throw new Error("source-scope-changed");
            // Collector merges on UUID. Identity uses raw position/content before
            // sanitization, preserving identical authored records and redaction collisions.
            const uuid = hmac(salt, `${id}\0${generation}\0${committed}\0${hmac(salt, raw)}`);
            const sanitized = sanitizeLine(record, salt);
            const serialize = value => {
              if (value.uuid) value._codex_source_uuid = value.uuid;
              value.uuid = uuid;
              return JSON.stringify(value) + "\n";
            };
            let serialized = serialize(sanitized);
            if (record.type === "compacted") {
              // Keep every already-deliverable representation unchanged. Gzip
              // can compress repeated inline content better than unique refs.
              try { encodeChunks([serialized], options.maxEnvelope, continuation); }
              catch (error) {
                if (error.message !== "oversized-single-record") throw error;
                serialized = serialize(sanitizeLine(projectCompaction(record, committed, sanitized), salt));
              }
            }
            if (Buffer.byteLength(serialized) >= MAX_RECORD) throw new Error("oversized-single-record");
            lines.push(serialized);
          }
        }
        rawPrefix.update(raw); committed += raw.length; lineCount++;
        pending = pending.subarray(end + 1);
      }
      if (pending.length > MAX_RECORD) throw new Error("oversized-single-record");
      if (lines.length && committed - offset >= (options.stageBytes || STAGE_BYTES)) break;
    }
    if (!lines.length) {
      recordProgress(dir, "capture", { capturedBytes: offset, observedBytes, partial: pending.length > 0 });
      return { status: "unchanged", files: [], partial: pending.length > 0 };
    }
    const encoded = encodeChunks(lines, options.maxEnvelope, continuation, offset === 0);
    let seq = cursor?.seq || 0;
    const chunks = encoded.map(({ body, records }) => ({ file: `${++seq}.gz`, seq, reset: baseline, records, sha256: digest(body) }));
    const next = { version: 1, seq, baseline, generation, offset: committed, lineCount,
      ...(options.consent ? { consentEpoch: options.consent.epoch } : {}),
      ...(preserveMetadata ? { metadataVersion: 1 } : {}),
      prefix: rawPrefix.digest("hex"), fileId, scope, source: path.resolve(source), transcriptId: path.basename(source) };
    // Detect concurrent source rewrite before publishing any state.
    if (prefix(fd, committed, salt).digest("hex") !== next.prefix) throw new Error("source-changed-during-stage");
    if (options.authorizeCommit && !options.authorizeCommit()) throw new Error("consent-changed-during-stage");
    const group = path.join(dir, `batch-${String(chunks[0].seq).padStart(16, "0")}-${crypto.randomUUID()}`);
    const temp = path.join(dir, `.stage-${crypto.randomUUID()}`);
    fs.mkdirSync(temp, { mode: 0o700 });
    for (let i = 0; i < chunks.length; i++) writeDurable(path.join(temp, chunks[i].file), encoded[i].body);
    writeDurable(path.join(temp, "commit.json"), JSON.stringify({ cursor: next, chunks, createdAt: Date.now() }));
    options.fault?.("before-publish");
    if (options.authorizeCommit && !options.authorizeCommit()) throw new Error("consent-changed-during-stage");
    fs.renameSync(temp, group); syncDir(dir);
    options.fault?.("after-publish");
    writeDurable(path.join(dir, "cursor.json"), JSON.stringify(next));
    options.fault?.("after-cursor");
    writeDurable(path.join(group, "ready"), "1");
    recordProgress(dir, "capture", { capturedBytes: committed, observedBytes, partial: pending.length > 0 });
    return { status: "staged", files: chunks.map(c => path.join(group, c.file)), cursor: next };
  } catch (e) {
    // Error code only. Never persist source text or arbitrary exception payloads.
    const code = ["oversized-single-record", "malformed-complete-record", "invalid-wire-budget",
      "source-changed-during-stage", "source-truncated-during-read", "invalid-cursor", "incomplete-transaction", "source-scope-changed", "source-owner-changed", "consent-source-rewritten", "consent-changed-during-stage", "invalid-session-metadata", "unsupported-session-source", "unsupported-session-originator"].includes(e.message) ? e.message : "stage-failed";
    // A failed diagnostics write must not replace the capture error.
    try { recordFailure(dir, "capture", code, { capturedBytes, observedBytes }); } catch {}
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); release(); }
}

function queueDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(n => /^[a-f0-9]{64}$/.test(n)).map(n => path.join(root, n));
}
function pendingFiles(dir) {
  const cursor = fs.existsSync(path.join(dir, "cursor.json")) ? readJson(path.join(dir, "cursor.json")) : null;
  return groups(dir).flatMap(group => {
    // A durable full reset supersedes pending older generations. Keep their
    // immutable files for recovery, but never send them ahead of the reset.
    if (cursor && readJson(path.join(group, "commit.json")).cursor.baseline < cursor.baseline) return [];
    if (!fs.existsSync(path.join(group, "ready"))) return [];
    return readJson(path.join(group, "commit.json")).chunks.map(c => path.join(group, c.file)).filter(f => fs.existsSync(f));
  });
}
function metadata(file) {
  const commit = readJson(path.join(path.dirname(file), "commit.json"));
  const chunk = commit.chunks.find(c => c.file === path.basename(file));
  if (!chunk) throw new Error("unknown-chunk");
  return { ...chunk, scope: commit.cursor.scope, transcriptId: commit.cursor.transcriptId };
}
// Preserve the committed cursor and consent journal when removing payloads.
// A busy queue is rechecked after its current request completes.
function purgeRevoked(dir, revoked) {
  const release = acquireLock(path.join(dir, "lock"));
  if (!release) return false;
  try {
    recover(dir);
    for (const group of groups(dir)) {
      const commit = readJson(path.join(group, "commit.json"));
      if (revoked(commit.cursor.scope)) fs.rmSync(group, { recursive: true });
    }
    syncDir(dir);
    return true;
  } finally { release(); }
}
async function drainDirectory(dir, send) {
  const release = acquireLock(path.join(dir, "lock"));
  if (!release) return 0;
  let sent = 0;
  try {
    recover(dir);
    for (const file of pendingFiles(dir)) {
      const meta = metadata(file), body = fs.readFileSync(file);
      if (digest(body) !== meta.sha256) throw new Error("chunk-integrity-failed");
      const previousAttempt = health.inspect(dir).delivery?.attemptId;
      const outcome = await send(meta, body);
      if (outcome === "reset-required") {
        writeDurable(path.join(dir, "reset-request.json"), JSON.stringify({ baseline: meta.reset }));
      }
      if (outcome !== "sent") {
        const previous = health.inspect(dir).delivery;
        const code = previous?.attemptId !== previousAttempt && previous?.activeFailure?.code;
        recordFailure(dir, "delivery", code || `delivery-${outcome}`, { seq: meta.seq });
        break; // never advance over retry/auth/poison
      }
      recordProgress(dir, "delivery", { acknowledgedSeq: meta.seq, acknowledgedBaseline: meta.reset });
      fs.unlinkSync(file); syncDir(path.dirname(file)); sent++;
    }
    for (const group of groups(dir)) {
      if (readJson(path.join(group, "commit.json")).chunks.every(c => !fs.existsSync(path.join(group, c.file)))) {
        fs.rmSync(group, { recursive: true }); syncDir(dir);
      }
    }
    return sent;
  } finally { release(); }
}
module.exports = { stage, observeConsent, purgeRevoked, encodeChunks, acquireLock, recover, queueDirectories, pendingFiles, metadata,
  drainDirectory, writeDurable, recordFailure, hmac, MAX_ENVELOPE, ENVELOPE_RESERVE, MAX_RECORD, STAGE_BYTES };

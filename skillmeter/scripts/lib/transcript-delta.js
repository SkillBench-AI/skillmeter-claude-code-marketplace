/**
 * Pure delta-computation core for uuid-cursor transcript upload.
 *
 * The plugin used to re-upload the ENTIRE transcript on every Stop hook, which
 * blew past the backend's 6 MB request limit on long sessions (HTTP 413). This
 * module computes the *delta* — only the transcript lines added since the last
 * successfully-staged line — anchored on each content line's stable `uuid`.
 *
 * Anchoring on `uuid` (a content identity) rather than a byte/line offset makes
 * transcript rewrites/compaction *detectable*: if the last-sent uuid is no
 * longer present, we fall back to a full "reset" send instead of silently
 * mis-slicing a rewritten file.
 *
 * Leaf module: imports only ./sanitize so the whole file is unit-testable with
 * plain objects (no fs, network, or credstore).
 */

const { sanitizeLine } = require("./sanitize");

const DEFAULT_CHUNK_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Parse JSONL text into ordered objects. Blank lines are skipped and malformed
 * lines are dropped individually so a trailing partial line from a live writer
 * never aborts the delta.
 * @returns {{ objs: object[], malformed: number }}
 */
function parseJsonl(raw) {
  const lines = String(raw).split("\n");
  const objs = [];
  let malformed = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { objs, malformed };
}

/**
 * Newest content uuid in order: scan from the end for the first object with a
 * non-empty string `uuid`. Metadata lines (mode, permission-mode, …) have no
 * uuid and are skipped. Returns null when there is no content line.
 */
function lastContentUuid(objs) {
  for (let i = objs.length - 1; i >= 0; i--) {
    const u = objs[i] && objs[i].uuid;
    if (typeof u === "string" && u) return u;
  }
  return null;
}

/**
 * Decide where the delta starts and whether it is a reset, from the persisted
 * cursor:
 *   - no cursor            → { startIndex: 0, reset: false } (first send)
 *   - cursor uuid found    → { startIndex: i+1, reset: false } (normal delta)
 *   - cursor uuid missing  → { startIndex: 0, reset: true } (rewrite/compaction)
 */
function computeDelta(objs, cursor) {
  if (!cursor || !cursor.lastUuid) return { startIndex: 0, reset: false };
  const idx = objs.findIndex((o) => o && o.uuid === cursor.lastUuid);
  if (idx === -1) return { startIndex: 0, reset: true };
  return { startIndex: idx + 1, reset: false };
}

/**
 * Split serialized JSONL strings into groups whose UNCOMPRESSED size stays
 * under `maxUncompressedBytes` (a conservative proxy so the gzipped body stays
 * well under the backend's hard limit). A single line larger than the budget
 * becomes its own group — it is never dropped.
 */
function splitLinesByBudget(lines, maxUncompressedBytes = DEFAULT_CHUNK_MAX_BYTES) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for the newline
    if (current.length > 0 && size + lineBytes > maxUncompressedBytes) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += lineBytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Build the full chunk plan plus the cursor to persist AFTER the chunks are
 * durably sealed.
 *
 * @param {object[]} objs  parsed transcript lines (in file order)
 * @param {object|null} cursor  prior cursor { lastUuid, seq } or null
 * @param {string} salt  hash salt for per-line sanitization
 * @param {{seqStart?: number, maxUncompressedBytes?: number}} [opts]
 * @returns {{ chunks: Array<{lines:string[], seq:number, reset:boolean, resetBaselineSeq:number|null}>,
 *             newCursor: {lastUuid: string|null, seq: number} | null }}
 *   newCursor is null when the delta is empty (nothing to send; leave the
 *   cursor untouched).
 */
function buildChunkPlan(objs, cursor, salt, opts = {}) {
  // Continue the sequence from the cursor unless explicitly overridden.
  const seqStart = opts.seqStart != null ? opts.seqStart : (cursor && cursor.seq) || 0;
  const maxUncompressedBytes = opts.maxUncompressedBytes || DEFAULT_CHUNK_MAX_BYTES;

  const { startIndex, reset } = computeDelta(objs, cursor);
  const deltaObjs = objs.slice(startIndex);
  if (deltaObjs.length === 0) {
    return { chunks: [], newCursor: null };
  }

  const lines = deltaObjs.map((o) => JSON.stringify(sanitizeLine(o, salt)));
  const groups = splitLinesByBudget(lines, maxUncompressedBytes);

  const firstSeq = seqStart + 1;
  let seq = seqStart;
  const chunks = groups.map((groupLines) => {
    seq += 1;
    return {
      lines: groupLines,
      seq,
      reset,
      // Every sub-chunk of a reset carries the SAME baseline so the server can
      // truncate rows with seq < baseline idempotently, regardless of the order
      // parallel chunk uploads arrive in.
      resetBaselineSeq: reset ? firstSeq : null,
    };
  });

  // Metadata-only delta keeps the previous anchor (no new content uuid).
  const newLastUuid = lastContentUuid(deltaObjs) || (cursor && cursor.lastUuid) || null;

  return { chunks, newCursor: { lastUuid: newLastUuid, seq } };
}

module.exports = {
  parseJsonl,
  lastContentUuid,
  computeDelta,
  splitLinesByBudget,
  buildChunkPlan,
};

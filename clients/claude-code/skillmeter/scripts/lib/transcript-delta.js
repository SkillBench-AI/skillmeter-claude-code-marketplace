/**
 * Plan transcript chunks from the last staged content UUID. A missing anchor
 * indicates a rewrite/compaction and starts a full reset. Persist the new cursor
 * only after chunks are durable. No filesystem, network or credential access.
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
 * Number each record's turn. A user record with a new promptId starts a turn;
 * a transcript written without promptIds starts one at each user record that
 * is not a tool result. Records before the first turn are turn 0.
 */
function turnNumbers(objs) {
  const turns = new Array(objs.length);
  let turn = 0;
  let promptId;
  for (let i = 0; i < objs.length; i++) {
    const record = objs[i];
    if (record && record.type === "user" && startsTurn(record, promptId)) {
      turn++;
      promptId = record.promptId;
    }
    turns[i] = turn;
  }
  return turns;
}

function startsTurn(record, promptId) {
  if (typeof record.promptId === "string" && record.promptId) {
    return record.promptId !== promptId;
  }
  const content = record.message && record.message.content;
  return !(Array.isArray(content) && content.some((block) => block && block.type === "tool_result"));
}

/**
 * The repository each record may be sent for, decided per turn from the
 * working directory Claude Code writes on each record. `placeOf(cwd)` returns
 * `{ key, recording }` inside a repository, null outside any, and undefined
 * when it cannot tell (the directory is gone).
 *
 * A turn belongs to the repository it ended in: the last of its records
 * written inside one. It is sent only when every repository it was written in
 * is recording; otherwise, or when it was written only outside repositories,
 * it goes nowhere (null). A directory that no longer exists cannot show it was
 * recording, so a turn that names one goes nowhere either. A turn whose
 * records carry no working directory is `undefined`, left to the repository
 * staging it.
 *
 * `seenUnrecorded(promptId)` is true when a hook of that turn ran while it was
 * not recorded: signed out, or in a repository not recording then. Such a turn
 * goes nowhere, even for that repository once it records: a hook reads the
 * transcript after the fact, so what the turn wrote before and after that
 * hook cannot be told apart.
 */
function turnDestinations(objs, placeOf, seenUnrecorded = () => false) {
  const turns = turnNumbers(objs);
  const seen = new Map();
  const prompts = new Map();
  for (let i = 0; i < objs.length; i++) {
    const promptId = objs[i] && objs[i].promptId;
    if (typeof promptId === "string" && promptId && !prompts.has(turns[i])) {
      prompts.set(turns[i], promptId);
    }
    const cwd = objs[i] && objs[i].cwd;
    if (typeof cwd !== "string" || !cwd) continue;
    const place = placeOf(cwd);
    const turn = seen.get(turns[i]) || { key: null, recording: true };
    if (place === undefined) turn.recording = false;
    else if (place) {
      turn.key = place.key;
      turn.recording = turn.recording && place.recording;
    }
    seen.set(turns[i], turn);
  }
  return turns.map((number) => {
    const turn = seen.get(number);
    const key = !turn ? undefined : turn.recording ? turn.key : null;
    const promptId = prompts.get(number);
    return promptId && seenUnrecorded(promptId) ? null : key;
  });
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
 * @param {{seqStart?: number, maxUncompressedBytes?: number, keep?: function(number): boolean}} [opts]
 *   `keep(index)` selects which delta records are sent; the cursor still
 *   moves past the others.
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

  const kept = opts.keep
    ? deltaObjs.filter((o, offset) => opts.keep(startIndex + offset))
    : deltaObjs;
  const lines = kept.map((o) => JSON.stringify(sanitizeLine(o, salt)));
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
  turnNumbers,
  turnDestinations,
  splitLinesByBudget,
  buildChunkPlan,
};

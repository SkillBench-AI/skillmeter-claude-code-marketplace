/**
 * Session status (ADR 003, decision 7): each Claude Code session's collection
 * state for its working directory, written for the display module
 * (hooks/status.tsx), which shows it beside the prompt and warns when
 * collection stops.
 *
 * Unlike the notices' record (collection-notice.js), which is resolved without
 * a working directory to describe this client, this one carries the gate for
 * the directory the session is in, so the display can tell "collecting here"
 * from "off here". It reports and never gates.
 *
 * A file holds only the state's and the reason's names, is never sent, and is
 * written only when either changes. transfer.js cleanupStaleFiles removes it
 * 30 days after that.
 */

const path = require("path");
const { SESSION_STATUS_DIR } = require("./paths");
const { atomicWriteJson, safeReadJson } = require("./io");
const { readCollectionState } = require("./collection-state");

const SCHEMA = 1;

// The display module reads the file of its own session; a hook without a
// usable session id has nothing to write for.
function sessionStatusFile(sessionId) {
  return typeof sessionId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(sessionId)
    ? path.join(SESSION_STATUS_DIR, `${sessionId}.json`)
    : null;
}

/**
 * Write `{ state, reason }` for the session when it differs from what is
 * stored. Returns whether it wrote.
 */
function recordSessionStatus(sessionId, { state, reason }) {
  const file = sessionStatusFile(sessionId);
  if (!file || typeof state !== "string" || typeof reason !== "string") return false;
  const stored = safeReadJson(file, null);
  if (stored?.state === state && stored?.reason === reason) return false;
  atomicWriteJson(file, { schema: SCHEMA, state, reason });
  return true;
}

/**
 * Resolve and record the session's state, from the gate a hook already
 * resolved or from its working directory. Never throws: the indicator must not
 * cost a hook its capture.
 */
function updateSessionStatus(sessionId, { gate = null, cwd = "" } = {}) {
  try {
    return recordSessionStatus(sessionId, readCollectionState({ gate, cwd }));
  } catch {
    return false;
  }
}

module.exports = {
  SESSION_STATUS_DIR,
  sessionStatusFile,
  recordSessionStatus,
  updateSessionStatus,
};

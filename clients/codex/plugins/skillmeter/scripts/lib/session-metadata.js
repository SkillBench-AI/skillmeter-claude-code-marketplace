"use strict";

// The startup record also contains instructions and other historical context.
// Only routing identity and lineage may cross the excluded consent prefix.
// The caller must authorize its cwd and apply the regular sanitizer afterwards.
function sessionMetadata(record) {
  if (record.type !== "session_meta") return null;
  const payload = record.payload;
  if (!payload || typeof payload.id !== "string" || !payload.id.trim() ||
      typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("invalid-session-metadata");
  }
  const selected = { id: payload.id, cwd: payload.cwd };
  if (payload.source != null) {
    if (typeof payload.source === "string") selected.source = payload.source;
    else if (typeof payload.source === "object" && !Array.isArray(payload.source) && payload.source.subagent) {
      selected.source = { subagent: true };
    } else throw new Error("unsupported-session-source");
  }
  if (payload.originator != null) {
    if (typeof payload.originator !== "string" || payload.originator.length > 80 ||
        !/^[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$/.test(payload.originator)) {
      throw new Error("unsupported-session-originator");
    }
    selected.originator = payload.originator;
  }
  if (payload.parent_thread_id != null) {
    if (typeof payload.parent_thread_id !== "string") throw new Error("invalid-session-metadata");
    selected.parent_thread_id = payload.parent_thread_id;
  }
  return { type:"session_meta",
    ...(typeof record.timestamp === "string" ? {timestamp:record.timestamp} : {}),
    ...(typeof record.uuid === "string" ? {uuid:record.uuid} : {}), payload:selected };
}

// A batch staged past the file start repeats the routing identity under its own
// type, so a stored object that holds only later chunks can be attributed to
// its session and told apart from the session's first record. No timestamp:
// the collector dates objects from their earliest line, and the session start
// would file a continuation under the day the session began.
function sessionContinuation(record) {
  const header = sessionMetadata(record);
  return header && { type: "session_continuation", payload: header.payload };
}

module.exports = { sessionMetadata, sessionContinuation };

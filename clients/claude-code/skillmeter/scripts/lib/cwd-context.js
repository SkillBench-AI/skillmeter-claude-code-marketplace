/**
 * Session-local cwd observation state.
 *
 * This state is never uploaded. It preserves only HMAC identifiers and a
 * coarse scope classification so hooks can observe repository transitions
 * without retaining local paths or repository names.
 */

const fs = require("fs");
const path = require("path");

const { atomicWriteJson, safeReadJson } = require("./io");
const { SESSIONS_DIR } = require("./paths");
const { hashHmac } = require("./sanitize");

function contextPath(sessionId, hashSalt) {
  const sessionHash = hashHmac(sessionId, hashSalt);
  return sessionHash
    ? path.join(SESSIONS_DIR, sessionHash, "cwd-context.json")
    : "";
}

function observeSessionCwd({
  sessionId,
  cwd,
  repoKey = "",
  classification = "unknown",
  hashSalt,
}) {
  const file = contextPath(sessionId, hashSalt);
  if (!file) return null;

  const cwdHash = hashHmac(cwd, hashSalt);
  const repositoryHash = hashHmac(repoKey, hashSalt);
  const previous = safeReadJson(file, null);
  const next = {
    cwd_hash: cwdHash,
    repository_hash: repositoryHash,
    classification,
    updated_at: Date.now(),
  };
  const cwdChanged = !!previous && previous.cwd_hash !== cwdHash;
  const repositoryChanged =
    !!previous && previous.repository_hash !== repositoryHash;
  if (
    previous &&
    !cwdChanged &&
    !repositoryChanged &&
    previous.classification === classification
  ) {
    return {
      cwdChanged: false,
      repositoryChanged: false,
      previous,
      current: previous,
    };
  }
  try {
    atomicWriteJson(file, next);
  } catch {
    return null;
  }
  return {
    cwdChanged,
    repositoryChanged,
    previous,
    current: next,
  };
}

function clearSessionCwdContext(sessionId, hashSalt) {
  const file = contextPath(sessionId, hashSalt);
  if (!file) return false;
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleSessionContexts(maxAgeMs, now = Date.now()) {
  if (!fs.existsSync(SESSIONS_DIR)) return 0;
  let deleted = 0;
  try {
    for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join(SESSIONS_DIR, entry.name);
      const file = path.join(root, "cwd-context.json");
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs <= maxAgeMs) continue;
        fs.rmSync(root, { recursive: true, force: true });
        deleted++;
      } catch {}
    }
  } catch {}
  return deleted;
}

module.exports = {
  contextPath,
  observeSessionCwd,
  clearSessionCwdContext,
  cleanupStaleSessionContexts,
};

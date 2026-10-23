const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const config = require("./lib/config");
const { getLicenseOrgs } = require("./lib/jwt");

// Two stores (ADR 005). The shared credentials.json holds the device identity
// every SkillMeter client on the machine agrees on; fields other clients own
// there are preserved and never read. The session is this plugin's alone: its
// license, broker refresh token, sign-in intent and sign-out.

function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Null when absent or unreadable, for detecting an interleaved write.
function readRaw(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return null; }
}

// Write and fsync a sibling file before renaming it over the store, so readers
// see a complete old or new file.
function writeObject(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempPath = `${file}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

const PREEMPTED = Symbol("credential-store-preempted");

// One locked read/modify/write attempt. PREEMPTED means a changed file or a
// lost lock was detected; the checks are not atomic with the rename.
function mutateOnce(file, fn, afterCommit) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { acquireLock } = require("./lib/credential-lock");
  const deadline = Date.now() + 1000;
  let release;
  while (!(release = acquireLock(`${file}.lock`))) {
    if (Date.now() >= deadline) throw new Error("credential-store-busy");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    const baseline = readRaw(file);
    const store = readObject(file);
    const result = fn(store);
    if (result === false) return false;
    if (!release.stillHeld() || readRaw(file) !== baseline) return PREEMPTED;
    writeObject(file, store);
    if (afterCommit) afterCommit();
    return result === undefined ? true : result;
  } finally { release(); }
}

function mutate(file, fn, afterCommit) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = mutateOnce(file, fn, afterCommit);
    if (outcome !== PREEMPTED) return outcome;
  }
  throw new Error("credential-store-busy");
}

// ---------------------------------------------------------------------------
// Shared identity
// ---------------------------------------------------------------------------

let identityCache = null;

function readIdentity() {
  if (!identityCache) identityCache = readObject(config.credentialsFile());
  return identityCache;
}

// Create a missing identity field under the lock. On lock timeout, re-read: a
// concurrent hook may have created it.
function ensureIdentityField(key, create) {
  const existing = readIdentity()[key];
  if (existing) return existing;
  let value;
  try {
    mutate(config.credentialsFile(), store => {
      if (!store[key]) store[key] = create();
      value = store[key];
    });
  } catch (err) {
    if (err && err.message === "credential-store-busy") {
      identityCache = null;
      const fresh = readIdentity()[key];
      if (fresh) return fresh;
    }
    throw err;
  }
  identityCache = null;
  return value;
}

const getDeviceId = () => ensureIdentityField("device_id", () => crypto.randomUUID().toUpperCase());
const getOrCreateHashSalt = () => ensureIdentityField("hash_salt", () => crypto.randomBytes(16).toString("hex"));

// ---------------------------------------------------------------------------
// This plugin's session
// ---------------------------------------------------------------------------

const readSession = () => readObject(config.sessionFile());
const mutateSession = (fn, afterCommit) => mutate(config.sessionFile(), fn, afterCommit);

// The license, unless signed out. Read from disk on every call: the retry
// daemon outlives sign-ins, renewals and sign-outs in other processes.
function getLicenseToken() {
  const session = readSession();
  return session.event_cutover !== 1 || session.signed_out === true ? null : session.license_jwt || null;
}

// Compatibility helper for callers that only need a session file. Its existence
// is not evidence of completed cutover; use completeEventCutover for that.
function ensureSessionFile() {
  if (fs.existsSync(config.sessionFile())) return false;
  return mutateSession(session => {
    if (Object.keys(session).length) return false;
    session.created_at = new Date().toISOString();
  }) === true;
}

// A session file is not proof that the legacy event queue was cleared. The
// completion record is committed only after every batch is removed, under the
// same lock as sign-in. A crash or a busy batch leaves it retryable.
function completeEventCutover(purge, queueEmpty = () => false) {
  if (isEventCutoverComplete()) return true;
  return mutateSession(session => {
    if (session.event_cutover === 1) return false;
    if (Object.hasOwn(session, "event_cutover")) return false;
    // Malformed/unreadable state is not evidence of a pre-broker installation.
    let raw;
    try { raw = fs.readFileSync(config.sessionFile(), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (raw !== undefined) {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    }
    // A previous broker version may already have captured new data alongside
    // skipped legacy batches. Preserve that ambiguous queue for explicit review.
    if (session.license_jwt || session.refresh_token) {
      if (queueEmpty() !== true) return false;
    } else if (purge() !== true) return false;
    session.event_cutover = 1;
    session.created_at ||= new Date().toISOString();
  }) === true || isEventCutoverComplete();
}

const isEventCutoverComplete = () => readSession().event_cutover === 1;

// Signed in: a license is held and the user has not signed out. Freshness is
// enforced when data is sent, not here.
const isSignedIn = () => !!getLicenseToken();
const getSignedOut = () => readSession().signed_out === true;

// Snapshot the session before a network exchange. The generation detects a
// sign-out/sign-in cycle that reuses a token; the device id guards against a
// reset identity.
function recoverySnapshot() {
  const session = readSession();
  return {
    token: session.license_jwt || null,
    refreshToken: session.refresh_token || null,
    generation: session.auth_generation || null,
    deviceId: readObject(config.credentialsFile()).device_id || null,
    signedOut: session.event_cutover !== 1 || session.signed_out === true,
  };
}

function snapshotMatches(session, expected) {
  return session.event_cutover === 1 && !!expected && !expected.signedOut && session.signed_out !== true &&
    (session.license_jwt || null) === expected.token &&
    (session.refresh_token || null) === (expected.refreshToken || null) &&
    (session.auth_generation || null) === expected.generation &&
    (readObject(config.credentialsFile()).device_id || null) === expected.deviceId;
}

const isRecoveryCurrent = expected => snapshotMatches(readSession(), expected);

// Explicit sign-in starts a new intent; a sign-in still polling from an older
// intent can no longer commit.
function markEngaged() {
  return mutateSession(session => {
    delete session.signed_out;
    session.auth_generation = crypto.randomUUID();
    return session.auth_generation;
  });
}

// Commit a sign-in only for the intent that started it. onCommit runs under
// the lock and must not take it again.
function commitSignin({ jwt, refreshToken, generation, onCommit }) {
  return mutateSession(session => {
    if (session.event_cutover !== 1 || session.signed_out === true) return false;
    if (generation && session.auth_generation !== generation) return false;
    session.license_jwt = jwt;
    session.refresh_token = refreshToken;
    session.auth_generation = crypto.randomUUID();
  }, onCommit);
}

// The broker rotated the refresh token: the one presented is spent, so the new
// one is stored before anything else can fail.
function commitRotation(expected, refreshToken) {
  return mutateSession(session => {
    if (!snapshotMatches(session, expected)) return false;
    session.refresh_token = refreshToken;
  });
}

function commitRefresh(jwt, expected) {
  return mutateSession(session => {
    if (!snapshotMatches(session, expected)) return false;
    session.license_jwt = jwt;
  });
}

// The workspace no longer licenses this user (402, or 404 for the pinned
// tenant). Not a sign-out: signing in to a workspace that does resumes.
function dropSession(expected, onCommit) {
  return mutateSession(session => {
    if (!snapshotMatches(session, expected)) return false;
    delete session.license_jwt;
    delete session.refresh_token;
    session.auth_generation = crypto.randomUUID();
  }, onCommit);
}

// Keep the device identity; end this session and every in-flight exchange.
function signOut() {
  return mutateSession(session => {
    delete session.license_jwt;
    delete session.refresh_token;
    session.signed_out = true;
    session.auth_generation = crypto.randomUUID();
  });
}

// Sign-out and sign-in close consent-journal intervals through this value.
const getAuthGeneration = () => readSession().auth_generation || null;

// Matches the Claude plugin: renew while the license is still valid so a
// request in flight does not cross the expiry.
const LICENSE_EXPIRY_SKEW_SECONDS = 5 * 60;

function isLicenseTokenExpired(token, skewSeconds = LICENSE_EXPIRY_SKEW_SECONDS) {
  const { decodeJwtPayload } = require("./lib/jwt");
  const payload = token ? decodeJwtPayload(token) : null;
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

// The GitHub accounts repository capture is allowed for: the license's `orgs`
// claim. Empty when signed out or when the license covers none.
function getAllowedGitHubOrgs() {
  const token = getLicenseToken();
  return token ? getLicenseOrgs(token) : [];
}

// Long-running processes re-read identity after another process changed it.
function refreshFromDisk() { identityCache = null; }

module.exports = {
  refreshFromDisk,
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  // The upload path's name for the same uncached read.
  getLicenseTokenUncached: getLicenseToken,
  ensureSessionFile,
  completeEventCutover,
  isEventCutoverComplete,
  isSignedIn,
  getSignedOut,
  getAuthGeneration,
  recoverySnapshot,
  isRecoveryCurrent,
  markEngaged,
  commitSignin,
  commitRotation,
  commitRefresh,
  dropSession,
  signOut,
  isLicenseTokenExpired,
  getAllowedGitHubOrgs,
  // The locked read/modify/write primitive, for the race suite.
  mutateSession,
};

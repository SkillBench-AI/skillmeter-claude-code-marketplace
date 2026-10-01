const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Two stores (ADR 005). The shared one, CRED_FILE, holds the device identity
// every client on the machine agrees on (device_id, hash_salt) and fields
// other clients own, which are preserved. The session, SESSION_FILE, is this
// client's alone: its license, broker refresh token, sign-in intent and sign-out. SKILLMETER_STATE_DIR
// still isolates a dev environment's state from prod; the account directory is
// keyed by it (lib/paths).
const { CRED_FILE } = require("./lib/config");
const { ACCOUNT_DIR } = require("./lib/paths");
// Canonical JWT helpers. The org(s) validated for telemetry come straight from
// the license JWT (the activator's decision); the client keeps no list of its own.
const { isJwtExpired, getLicenseOrgs } = require("./lib/jwt");
// Shared low-level file I/O (safe read, atomic write) — leaf module, no cycle.
const { safeReadJson, atomicWriteJson } = require("./lib/io");
const telemetryStore = require("./lib/telemetry-store");

const SESSION_FILE = path.join(ACCOUNT_DIR, "session.json");

// ---------------------------------------------------------------------------
// Low-level file helpers, one implementation for both stores
// ---------------------------------------------------------------------------

// A store that exists but is not a JSON object (truncated, emptied, a foreign
// non-atomic writer caught mid-write) reads as empty, so the next write
// re-creates it. The original bytes are kept first; see mutateFile.
function isStoreObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readObject(file) {
  const store = safeReadJson(file, null);
  return isStoreObject(store) ? store : {};
}

// This dead-owner-only lock protocol is shared with Codex for CRED_FILE.
// Older clients that ignore it or reclaim live locks by age must be stopped
// before use. The session file is ours alone, but takes the same lock so every
// process of this client serializes on it.
function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { acquireLock } = require("./lib/credential-lock");
  const deadline = Date.now() + 1000;
  let release;
  while (!(release = acquireLock(`${file}.lock`))) {
    if (Date.now() >= deadline) throw new Error("credential-store-busy");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { return fn(release); }
  finally { release(); }
}

// null when the file does not exist. A file that exists but cannot be read
// throws: writing over it would replace a device identity or session this
// process simply could not see.
function readRaw(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`credential store unreadable (${err?.code || "error"})`);
  }
}

function isCorrupt(raw) {
  if (raw == null) return false;
  try { return !isStoreObject(JSON.parse(raw)); }
  catch { return true; }
}

// Keep a corrupt store's exact bytes before it is replaced, and say so: what
// it held is gone, so the user must sign in again. Throws when the copy cannot
// be made, so the caller does not reset a store it failed to preserve. Runs
// under the file's lock.
function preserveCorrupt(file) {
  const bytes = fs.readFileSync(file); // a Buffer: invalid UTF-8 survives
  const aside =
    `${file}.corrupt-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(aside, bytes, { mode: 0o600, flag: "wx" });
  console.error(
    `[skillmeter] Credential store was unreadable and has been reset; the original is kept at ${aside}. Run /skillmeter:signin to sign in again.`
  );
}

const PREEMPTED = Symbol("credential-store-preempted");
function mutateFile(file, fn, afterCommit) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = withFileLock(file, (release) => {
      const baseline = readRaw(file);
      const store = readObject(file);
      const result = fn(store);
      if (result === false) return false;
      // These checks detect visible preemption, not an atomic rename fence.
      if (!release.stillHeld() || readRaw(file) !== baseline) return PREEMPTED;
      if (isCorrupt(baseline)) preserveCorrupt(file);
      atomicWriteJson(file, store);
      if (afterCommit) afterCommit();
      return result === undefined ? true : result;
    });
    if (result !== PREEMPTED) return result;
  }
  throw new Error("credential-store-busy");
}

// The shared store: identity plus other clients' fields.
function readStore() {
  return readObject(CRED_FILE);
}

function mutateStore(fn) {
  return mutateFile(CRED_FILE, fn);
}

// The session. Before ADR 005 it lived in the shared store, so the first read
// without a session file copies it from there, once: the license, sign-out and
// sign-in intent. The shared store is left as it is, because other clients
// still read it. From then on nothing another client writes there reaches this
// session.
const SESSION_FIELDS = ["license_jwt", "signed_out", "auth_generation"];

function ensureSession() {
  if (fs.existsSync(SESSION_FILE)) return;
  try {
    withFileLock(SESSION_FILE, () => {
      if (fs.existsSync(SESSION_FILE)) return;
      const shared = readStore();
      const seed = {};
      for (const key of SESSION_FIELDS) {
        if (shared[key] !== undefined) seed[key] = shared[key];
      }
      atomicWriteJson(SESSION_FILE, seed);
    });
  } catch {
    // Unwritable: readSession() returns an empty session, which reads as signed
    // out, and the next write tries again.
  }
}

function readSession() {
  ensureSession();
  return readObject(SESSION_FILE);
}

function mutateSession(fn, afterCommit) {
  ensureSession();
  return mutateFile(SESSION_FILE, fn, afterCommit);
}

// The device identity is shared and write-once, so it can be read outside the
// session lock and still compared under it.
function currentDeviceId() {
  return readStore().device_id || null;
}

function recoverySnapshot() {
  const session = readSession();
  return {
    token: session.license_jwt || null,
    refreshToken: session.refresh_token || null,
    generation: session.auth_generation || null,
    deviceId: currentDeviceId(),
    signedOut: session.signed_out === true,
  };
}

function snapshotMatches(session, expected) {
  return expected && !expected.signedOut && session.signed_out !== true &&
    (session.license_jwt || null) === expected.token &&
    (session.refresh_token || null) === (expected.refreshToken || null) &&
    (session.auth_generation || null) === expected.generation &&
    currentDeviceId() === expected.deviceId;
}

function isRecoveryCurrent(expected) {
  return snapshotMatches(readSession(), expected);
}

// The broker rotated the refresh token: the one presented is now spent, so the
// new one is stored before anything else can fail (ADR 005). Returns false when
// the session moved on meanwhile.
function commitRotation(expected, refreshToken) {
  return mutateSession((session) => {
    if (!snapshotMatches(session, expected)) return false;
    session.refresh_token = refreshToken;
  });
}

function commitRefresh(jwt, expected) {
  return mutateSession((session) => {
    if (!snapshotMatches(session, expected)) return false;
    session.license_jwt = jwt;
  });
}

// 402: the organization no longer licenses this user (license cancelled, or
// the user left or was removed from the workspace). Drop the token so
// isSignedIn() turns false and recording stops at its one gate. Unlike
// signOut() this sets no signed_out flag: nothing was chosen, and a new
// sign-in into a workspace that still licenses the user simply resumes.
// onCommit runs under the lock, so it must be synchronous and must not
// acquire the session lock again.
function dropRevokedLicense(expected, onCommit) {
  return mutateSession((session) => {
    if (!snapshotMatches(session, expected)) return false;
    delete session.license_jwt;
    delete session.refresh_token;
    session.auth_generation = crypto.randomUUID();
  }, onCommit);
}

// Serialize a refresh status update against sign-in/sign-out too. fn must be
// synchronous and must not acquire the session lock again.
function withRecoveryCurrent(expected, fn) {
  ensureSession();
  return withFileLock(SESSION_FILE, (release) => {
    if (!release.stillHeld() || !isRecoveryCurrent(expected)) return false;
    fn();
    return true;
  });
}

// Sign-in result sentinel: FileChanged reports completion of detached sign-in.
// Keep it separate from the session so routine refreshes do not trigger notices.

const SIGNIN_RESULT_FILE = path.join(ACCOUNT_DIR, "signin-result.json");

function writeSigninResult(result, expected) {
  try {
    const write = () => atomicWriteJson(SIGNIN_RESULT_FILE, { ...result, ts: Date.now() });
    if (expected) {
      ensureSession();
      withFileLock(SESSION_FILE, () => {
        if (signinMatches(readObject(SESSION_FILE), expected)) write();
      });
    } else write();
  } catch {
    // Best-effort: a missing sentinel only degrades to the re-run UX.
  }
}

function readSigninResult() {
  return safeReadJson(SIGNIN_RESULT_FILE, null);
}

// Pre-create the sentinel so SessionStart `watchPaths` can register it before
// the first sign-in (some file watchers only fire on modify, not create).
function ensureSigninResultFile() {
  if (!fs.existsSync(SIGNIN_RESULT_FILE)) {
    try {
      atomicWriteJson(SIGNIN_RESULT_FILE, { status: "none" });
    } catch {}
  }
}

// Upload result sentinel: detached drains record successful uploads here.
// SessionStart shows the notice once and marks it notified.

const UPLOAD_RESULT_FILE = path.join(ACCOUNT_DIR, "upload-result.json");

// Record a drain outcome — success counts (events/transcripts) or a transmission
// `error`. `notified:false` so the next SessionStart surfaces it exactly once.
// Best-effort; a missing sentinel just means no notice.
function writeUploadResult({ events = 0, transcripts = 0, error = null } = {}) {
  try {
    atomicWriteJson(UPLOAD_RESULT_FILE, { events, transcripts, error, ts: Date.now(), notified: false });
  } catch {}
}

function readUploadResult() {
  return safeReadJson(UPLOAD_RESULT_FILE, null);
}

// Flag the current result as shown, so it isn't surfaced again next session.
function markUploadNotified() {
  try {
    const cur = readUploadResult();
    if (cur && !cur.notified) atomicWriteJson(UPLOAD_RESULT_FILE, { ...cur, notified: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function ensureIdentityField(key, create) {
  const existing = readStore()[key];
  if (existing) return existing;
  let value;
  mutateStore((store) => {
    if (!store[key]) store[key] = create();
    value = store[key];
  });
  return value;
}

function getDeviceId() {
  return ensureIdentityField("device_id", () => crypto.randomUUID().toUpperCase());
}

function getOrCreateHashSalt() {
  return ensureIdentityField("hash_salt", () => crypto.randomBytes(16).toString("hex"));
}

function getHashSalt() {
  return readStore().hash_salt || "";
}

function getLicenseToken() {
  const session = readSession();
  return session.signed_out === true ? null : session.license_jwt || null;
}

// Kept as an explicit API for transfer call sites that require a fresh token.
function getLicenseTokenUncached() {
  return getLicenseToken();
}

// Matches the VS Code extension's TOKEN_EXPIRY_SKEW_MS (5 min). Refresh
// fires proactively while the JWT is still technically valid so requests
// in flight don't cross the expiry boundary.
const LICENSE_EXPIRY_SKEW_SECONDS = 5 * 60;

/**
 * Return true when the given JWT is missing, malformed, or its `exp`
 * claim lies within `skewSeconds` of now. Absent/malformed tokens are
 * treated as expired so callers don't need to double-check.
 */
function isLicenseTokenExpired(token, skewSeconds = LICENSE_EXPIRY_SKEW_SECONDS) {
  return isJwtExpired(token, { skewSeconds, treatMissingAsExpired: true });
}

// Signed in: this client's session holds a license and the user has not signed
// out. Freshness is not part of it. Capture keys off this; transmission
// separately requires an unexpired token (ADR 001, decision 3), so an expired
// or unrefreshable token never drops what the user already chose to record.
function isSignedIn() {
  return !!getLicenseToken();
}

function hasValidLicense() {
  const t = getLicenseTokenUncached();
  return !!t && !isLicenseTokenExpired(t);
}

// Sign-out blocks background refresh and in-flight sign-in commits.
// Read from disk so other processes observe it. Explicit sign-in clears it.
function getSignedOut() {
  return readSession().signed_out === true;
}

function normalizeOrg(org) {
  return typeof org === "string" ? org.trim().toLowerCase() : "";
}

/**
 * Network-side consent check. Token expiry is deliberately handled by the
 * transfer layer after its refresh attempt; this check answers only whether
 * the current license org(s) are authorized to transmit at all.
 */
function isTelemetryTransmissionAllowed(repoKey = "") {
  const policy = telemetryStore.readPolicy();
  if (policy.global.enabled === false) return false;
  const session = readSession();
  if (session.signed_out === true) return false;
  const orgs = session.license_jwt ? getLicenseOrgs(session.license_jwt) : [];
  if (orgs.length === 0) return false;
  if (!orgs.every((org) => policy.organizations[normalizeOrg(org)]?.enabled === true)) {
    return false;
  }
  if (repoKey) {
    const normalizedKey = telemetryStore.normalizeRepoKey(repoKey);
    if (!normalizedKey) return false;
    const org = normalizedKey.split("/")[1];
    if (!orgs.map(normalizeOrg).includes(org)) return false;
    if (policy.repositories[normalizedKey]?.enabled !== true) return false;
  }
  return true;
}

// Drop the license JWT atomically (the validated org lives in the JWT, so
// nothing else needs clearing). The device identity is in the shared store and
// survives a sign-out / sign-in cycle; other clients' sessions are untouched.
function signOut() {
  return mutateSession((session) => {
    delete session.license_jwt;
    delete session.refresh_token;
    session.signed_out = true;
    session.auth_generation = crypto.randomUUID();
  });
}

// Explicit sign-in starts a new intent even if the server reuses the same JWT.
function markEngaged() {
  return mutateSession((session) => {
    delete session.signed_out;
    session.auth_generation = crypto.randomUUID();
    return session.auth_generation;
  });
}

// Explicit issuance is bound to its originating intent. A refresh in that
// same intent may rotate the token while browser approval is pending.
function signinMatches(session, expected) {
  return !expected.signedOut && session.signed_out !== true &&
    (session.auth_generation || null) === expected.generation &&
    currentDeviceId() === expected.deviceId;
}

// onCommit publishes local status/notifications before another intent can win.
// It must be synchronous and must not acquire the session lock again. A sign-in
// without a refresh token (a broker that did not grant `offline`) clears any
// earlier one, so renewal never mixes two sign-ins.
function commitSignin({ jwt, refreshToken = null, expected, onCommit }) {
  return mutateSession((session) => {
    if (session.signed_out === true) return false;
    if (expected && !signinMatches(session, expected)) return false;
    session.license_jwt = jwt;
    if (refreshToken) session.refresh_token = refreshToken;
    else delete session.refresh_token;
    session.auth_generation = crypto.randomUUID();
  }, onCommit);
}

/**
 * The GitHub org(s) telemetry is validated for, as decided by the license
 * activator and minted into the JWT. Empty array means "not activated" —
 * repo-scope treats this as a hard block, not an allow-all. Reads uncached so
 * a token refreshed by another process is reflected immediately.
 */
function getAllowedGitHubOrgs() {
  const token = getLicenseTokenUncached();
  return token ? getLicenseOrgs(token) : [];
}

module.exports = {
  SESSION_FILE,
  isSignedIn,
  recoverySnapshot,
  isRecoveryCurrent,
  commitRefresh,
  commitRotation,
  dropRevokedLicense,
  withRecoveryCurrent,
  getDeviceId,
  getOrCreateHashSalt,
  getHashSalt,
  getLicenseToken,
  getLicenseTokenUncached,
  isLicenseTokenExpired,
  hasValidLicense,
  getAllowedGitHubOrgs,
  isTelemetryTransmissionAllowed,
  // Atomic sign-in lifecycle — prefer these over the lower-level set* helpers
  // when adjusting more than one field, so partial writes can't race.
  commitSignin,
  markEngaged,
  signOut,
  // Flag accessors
  getSignedOut,
  // Sign-in result sentinel (for the FileChanged sign-in notifier)
  SIGNIN_RESULT_FILE,
  writeSigninResult,
  readSigninResult,
  ensureSigninResultFile,
  // Upload result sentinel (for the SessionStart "telemetry sent" notice)
  writeUploadResult,
  readUploadResult,
  markUploadNotified,
};

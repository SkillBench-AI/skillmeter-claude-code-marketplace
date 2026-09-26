const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Resolved centrally in lib/config.js so SKILLMETER_STATE_DIR can isolate a dev
// environment's credentials/identity from prod.
const { CRED_FILE } = require("./lib/config");
// Canonical JWT helpers. The org(s) validated for telemetry come straight from
// the license JWT (the activator's decision); the client keeps no list of its own.
const { isJwtExpired, getLicenseOrgs } = require("./lib/jwt");
// Shared low-level file I/O (safe read, atomic write) — leaf module, no cycle.
const { safeReadJson, atomicWriteJson } = require("./lib/io");
const telemetryStore = require("./lib/telemetry-store");

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

// A store that exists but is not a JSON object (truncated, emptied, a foreign
// non-atomic writer caught mid-write) reads as empty, so the next write
// re-creates the identity. The original bytes are kept first; see mutateStore.
function isStoreObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStore() {
  const store = safeReadJson(CRED_FILE, null);
  return isStoreObject(store) ? store : {};
}

// This dead-owner-only lock protocol is shared with Codex. Older clients
// that ignore it or reclaim live locks by age must be stopped before use.
function withCredentialLock(fn) {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true, mode: 0o700 });
  const { acquireLock } = require("./lib/credential-lock");
  const deadline = Date.now() + 1000;
  let release;
  while (!(release = acquireLock(`${CRED_FILE}.lock`))) {
    if (Date.now() >= deadline) throw new Error("credential-store-busy");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { return fn(release); }
  finally { release(); }
}

// null when the file does not exist. A file that exists but cannot be read
// throws: writing over it would replace a device identity and license this
// process simply could not see.
function readRaw() {
  try { return fs.readFileSync(CRED_FILE, "utf8"); }
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

// Keep a corrupt store's exact bytes before it is replaced, and say so: the
// device identity and sign-in it held are gone, so the user must sign in
// again. Throws when the copy cannot be made, so the caller does not reset a
// store it failed to preserve. Runs under the credential lock.
function preserveCorruptStore() {
  const bytes = fs.readFileSync(CRED_FILE); // a Buffer: invalid UTF-8 survives
  const aside =
    `${CRED_FILE}.corrupt-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(aside, bytes, { mode: 0o600, flag: "wx" });
  console.error(
    `[skillmeter] Credential store was unreadable and has been reset; the original is kept at ${aside}. Run /skillmeter:signin to sign in again.`
  );
}

const PREEMPTED = Symbol("credential-store-preempted");
function mutateStore(fn, afterCommit) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = withCredentialLock((release) => {
      const baseline = readRaw();
      const store = readStore();
      const result = fn(store);
      if (result === false) return false;
      // These checks detect visible preemption, not an atomic rename fence.
      if (!release.stillHeld() || readRaw() !== baseline) return PREEMPTED;
      if (isCorrupt(baseline)) preserveCorruptStore();
      atomicWriteJson(CRED_FILE, store);
      if (afterCommit) afterCommit();
      return result === undefined ? true : result;
    });
    if (result !== PREEMPTED) return result;
  }
  throw new Error("credential-store-busy");
}

function recoverySnapshot() {
  const store = readStore();
  return {
    token: store.license_jwt || null,
    generation: store.auth_generation || null,
    deviceId: store.device_id || null,
    signedOut: store.signed_out === true,
  };
}

function snapshotMatches(store, expected) {
  return expected && !expected.signedOut && store.signed_out !== true &&
    (store.license_jwt || null) === expected.token &&
    (store.auth_generation || null) === expected.generation &&
    (store.device_id || null) === expected.deviceId;
}

function isRecoveryCurrent(expected) {
  return snapshotMatches(readStore(), expected);
}

function commitRefresh(jwt, expected) {
  return mutateStore((store) => {
    if (!snapshotMatches(store, expected)) return false;
    store.license_jwt = jwt;
  });
}

// Serialize a refresh status update against sign-in/sign-out too. fn must be
// synchronous and must not acquire the credential lock again.
function withRecoveryCurrent(expected, fn) {
  return withCredentialLock((release) => {
    if (!release.stillHeld() || !isRecoveryCurrent(expected)) return false;
    fn();
    return true;
  });
}

// Sign-in result sentinel: FileChanged reports completion of detached sign-in.
// Keep it separate from credentials so routine refreshes do not trigger notices.

const SIGNIN_RESULT_FILE = path.join(path.dirname(CRED_FILE), "signin-result.json");

function writeSigninResult(result, expected) {
  try {
    const write = () => atomicWriteJson(SIGNIN_RESULT_FILE, { ...result, ts: Date.now() });
    if (expected) {
      withCredentialLock(() => {
        if (signinMatches(readStore(), expected)) write();
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

const UPLOAD_RESULT_FILE = path.join(path.dirname(CRED_FILE), "upload-result.json");

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
  const store = readStore();
  return store.signed_out === true ? null : store.license_jwt || null;
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

// True when a non-expired license JWT is present on disk. Reads uncached so a
// token just refreshed by this process (or another terminal) is observed — the
// canonical "am I signed in" check, replacing inlined
// `t && !isLicenseTokenExpired(t)` at call sites.
// Signed in: a license is held and the user has not signed out. Freshness is
// not part of it. Capture keys off this; transmission separately requires an
// unexpired token (ADR 001, decision 3), so an expired or unrefreshable token
// never drops what the user already chose to record.
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
  return readStore().signed_out === true;
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
  const store = readStore();
  if (store.signed_out === true) return false;
  const orgs = store.license_jwt ? getLicenseOrgs(store.license_jwt) : [];
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
// nothing else needs clearing). Preserves device_id and hash_salt so the
// machine identity survives a sign-out / sign-in cycle.
function signOut() {
  return mutateStore((store) => {
    delete store.license_jwt;
    store.signed_out = true;
    store.auth_generation = crypto.randomUUID();
  });
}

// Explicit sign-in starts a new intent even if the server reuses the same JWT.
function markEngaged() {
  return mutateStore((store) => {
    delete store.signed_out;
    store.auth_generation = crypto.randomUUID();
    return store.auth_generation;
  });
}

// Explicit issuance is bound to its originating intent. A refresh in that
// same intent may rotate the token while browser approval is pending.
function signinMatches(store, expected) {
  return !expected.signedOut && store.signed_out !== true &&
    (store.auth_generation || null) === expected.generation &&
    (store.device_id || null) === expected.deviceId;
}

// onCommit publishes local status/notifications before another intent can win.
// It must be synchronous and must not acquire the credential lock again.
function commitSignin({ jwt, expected, onCommit }) {
  return mutateStore((store) => {
    if (store.signed_out === true) return false;
    if (expected && !signinMatches(store, expected)) return false;
    store.license_jwt = jwt;
    store.auth_generation = crypto.randomUUID();
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
  isSignedIn,
  recoverySnapshot,
  isRecoveryCurrent,
  commitRefresh,
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

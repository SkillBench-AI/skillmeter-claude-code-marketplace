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

// Locked store I/O, shared with the Codex client (shared/lib/store-file.js):
// both clients write CRED_FILE, under the same dead-owner lock.
const { readObject, withFileLock, mutateFile } = require("./lib/store-file");
// The device identity in CRED_FILE, shared with the Codex client.
const deviceIdentity = require("./lib/device-identity");

// The shared store: identity plus other clients' fields.
function readStore() {
  return readObject(CRED_FILE);
}


// The session. Before ADR 005 it lived in the shared store, so the first read
// without a session file copies sign-out and sign-in intent from there, once.
// The license is not copied: one from before ADR 005 has no refresh token and
// cannot be renewed, so the user signs in again. The shared store is left as
// it is, because other clients still read it. From then on nothing another
// client writes there reaches this session.
const SESSION_FIELDS = ["signed_out", "auth_generation"];

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

// A device flow is waiting for browser approval: /skillmeter:signin wrote
// `pending` when it started, and neither a final result nor the device code's
// expiry has ended it. The marker belongs to the sign-in attempt that wrote it:
// a sign-out, a newer attempt or a revocation changes `auth_generation`, which
// ends the wait just as it stops that attempt's poll from committing. No marker
// counts for longer than the cap. A poller that died without writing a result
// is not detected; its marker lasts until it expires.
const SIGNIN_PENDING_MAX_MS = 30 * 60_000;

function intentTag(generation) {
  return crypto.createHash("sha256").update(String(generation)).digest("hex").slice(0, 16);
}

function writeSigninPending(lifetimeMs, expected) {
  const expiresAt = Date.now() + Math.min(lifetimeMs, SIGNIN_PENDING_MAX_MS);
  writeSigninResult({ status: "pending", expires_at: expiresAt, intent: intentTag(expected.generation) }, expected);
}

function isSigninPending(now = Date.now()) {
  const result = readSigninResult();
  if (result?.status !== "pending" || typeof result.expires_at !== "number") return false;
  if (now >= result.expires_at || result.expires_at - now > SIGNIN_PENDING_MAX_MS) return false;
  const generation = readSession().auth_generation;
  return Boolean(generation) && result.intent === intentTag(generation);
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

function getDeviceId() {
  return deviceIdentity.getDeviceId();
}

function getOrCreateHashSalt() {
  return deviceIdentity.getOrCreateHashSalt();
}

function getHashSalt() {
  return deviceIdentity.readHashSalt();
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

// The user's recorded sign-out. It blocks background refresh; the generation,
// not this flag, blocks a stale sign-in commit. Read from disk so other
// processes observe it. Only a completed sign-in clears it.
function getSignedOut() {
  return readSession().signed_out === true;
}

function normalizeOrg(org) {
  return typeof org === "string" ? org.trim().toLowerCase() : "";
}

/**
 * Network-side consent check. Token expiry is deliberately handled by the
 * transfer layer after its refresh attempt; this check answers only whether
 * the current license may transmit at all.
 *
 * A repository needs its own organization licensed and authorized, and itself
 * enabled (ADR 004, decision 2); another licensed organization left unset does
 * not block it. Organization-level data (`repoKey` empty) is not tied to one
 * organization, so it needs every licensed organization authorized.
 */
function isTelemetryTransmissionAllowed(repoKey = "") {
  const policy = telemetryStore.readPolicy();
  if (policy.global.enabled === false) return false;
  const session = readSession();
  if (session.signed_out === true) return false;
  const orgs = session.license_jwt ? getLicenseOrgs(session.license_jwt).map(normalizeOrg) : [];
  if (orgs.length === 0) return false;
  const authorized = (org) => policy.organizations[org]?.enabled === true;
  if (!repoKey) return orgs.every(authorized);
  const normalizedKey = telemetryStore.normalizeRepoKey(repoKey);
  if (!normalizedKey) return false;
  const org = normalizedKey.split("/")[1];
  return orgs.includes(org) && authorized(org) &&
    policy.repositories[normalizedKey]?.enabled === true;
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
// A sign-out stays recorded until a sign-in commits: the new generation alone
// is what stops an earlier intent from committing.
function markEngaged() {
  return mutateSession((session) => {
    session.auth_generation = crypto.randomUUID();
    return session.auth_generation;
  });
}

// Explicit issuance is bound to its originating intent. A refresh in that
// same intent may rotate the token while browser approval is pending. A
// sign-out, or a newer sign-in, changes the generation, so a sign-in started
// before it cannot commit.
function signinMatches(session, expected) {
  return (session.auth_generation || null) === expected.generation &&
    currentDeviceId() === expected.deviceId;
}

// onCommit publishes local status/notifications before another intent can win.
// It must be synchronous and must not acquire the session lock again. A commit
// without a refresh token clears any earlier one, so renewal never mixes two
// sign-ins.
// The commit is what ends a sign-out.
function commitSignin({ jwt, refreshToken = null, expected, onCommit }) {
  return mutateSession((session) => {
    if (expected && !signinMatches(session, expected)) return false;
    delete session.signed_out;
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
  // The shared renewal flow's name (license-renewal.js), as in the Codex client.
  dropSession: dropRevokedLicense,
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
  writeSigninPending,
  isSigninPending,
  ensureSigninResultFile,
  // Upload result sentinel (for the SessionStart "telemetry sent" notice)
  writeUploadResult,
  readUploadResult,
  markUploadNotified,
};

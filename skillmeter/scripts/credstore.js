const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Resolved centrally in lib/config.js so SKILLMETER_STATE_DIR can isolate a dev
// environment's credentials/identity from prod.
const { CRED_FILE } = require("./lib/config");
// Canonical JWT helpers. The validated org(s) for telemetry are read straight
// from the license JWT (the activator's decision) — the client no longer stores
// or narrows a GitHub org list.
const { isJwtExpired, getLicenseOrgs } = require("./lib/jwt");
// Shared low-level file I/O (safe read, atomic write) — leaf module, no cycle.
const { safeReadJson, atomicWriteJson } = require("./lib/io");
const telemetryStore = require("./lib/telemetry-store");

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

function readStore() {
  return safeReadJson(CRED_FILE, {});
}

function writeStore(data) {
  atomicWriteJson(CRED_FILE, data);
}

// ---------------------------------------------------------------------------
// Sign-in result sentinel — records the outcome of an interactive sign-in
// attempt so a FileChanged hook can notify success/failure without the user
// re-running /skillmeter:signin. Kept in its own file (not credentials.json,
// which license refresh rewrites often) so a watcher fires only on real
// sign-in attempts, not on every token refresh.
// ---------------------------------------------------------------------------

const SIGNIN_RESULT_FILE = path.join(path.dirname(CRED_FILE), "signin-result.json");

function writeSigninResult(result) {
  try {
    atomicWriteJson(SIGNIN_RESULT_FILE, { ...result, ts: Date.now() });
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

// ---------------------------------------------------------------------------
// Upload result sentinel — records the outcome of a successful telemetry drain
// (which runs in a detached process that can't print to the session). The next
// SessionStart reads it and shows a one-line "telemetry sent" notice, then
// marks it notified so it isn't repeated. Written only when a drain uploaded
// something.
// ---------------------------------------------------------------------------

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

function getDeviceId() {
  const store = readStore();
  if (store.device_id) return store.device_id;

  const newId = crypto.randomUUID().toUpperCase();
  store.device_id = newId;
  writeStore(store);
  console.error("[skillmeter] New device ID created");
  return newId;
}

function getOrCreateHashSalt() {
  const store = readStore();
  if (store.hash_salt) return store.hash_salt;

  const newSalt = crypto.randomBytes(16).toString("hex");
  store.hash_salt = newSalt;
  writeStore(store);
  console.error("[skillmeter] New hash salt created");
  return newSalt;
}

function getHashSalt() {
  return readStore().hash_salt || "";
}

function getLicenseToken() {
  const store = readStore();
  return store.license_jwt || null;
}

// Kept as an explicit API for transfer call sites that require a fresh token.
function getLicenseTokenUncached() {
  return readStore().license_jwt || null;
}

function setLicenseToken(jwt) {
  const store = readStore();
  store.license_jwt = jwt;
  writeStore(store);
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
function hasValidLicense() {
  const t = getLicenseTokenUncached();
  return !!t && !isLicenseTokenExpired(t);
}

// `signed_out` is set by /skillmeter:signout. It blocks the silent gh
// fallback so a still-authenticated gh CLI doesn't auto-resignin on the
// next SessionStart. `markEngaged()` (called from /skillmeter:signin) clears it.
//
// Reads bypass the cache so a setter run by another process is reflected
// immediately — relevant when signin runs as a long-lived background poll
// while the user might invoke signout from a fresh hook process.
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
  const store = readStore();
  delete store.license_jwt;
  store.signed_out = true;
  writeStore(store);
}

// Called when the user explicitly invokes /skillmeter:signin — clears the
// signed-out sentinel so the next gh attempt is unblocked.
function markEngaged() {
  const store = readStore();
  delete store.signed_out;
  writeStore(store);
}

// Persist a freshly-issued license atomically. Re-reads the store at write
// time and aborts if /skillmeter:signout fired while the license issuance
// was in flight — the user's most recent intent wins. Returns true when
// the license was written, false when it was discarded. The validated org
// lives in the JWT itself, so nothing else is stored.
function commitSignin({ jwt }) {
  const store = readStore();
  if (store.signed_out === true) return false;
  store.license_jwt = jwt;
  writeStore(store);
  return true;
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
  getDeviceId,
  getOrCreateHashSalt,
  getHashSalt,
  getLicenseToken,
  getLicenseTokenUncached,
  setLicenseToken,
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

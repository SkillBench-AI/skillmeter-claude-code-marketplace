const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Resolved centrally in lib/paths.js so SKILLMETER_STATE_DIR can isolate a dev
// environment's credentials/identity from prod.
const { CRED_FILE } = require("./lib/paths");
// Canonical JWT helpers. The validated org(s) for telemetry are read straight
// from the license JWT (the activator's decision) — the client no longer stores
// or narrows a GitHub org list.
const { isJwtExpired, getLicenseOrgs } = require("./lib/jwt");
// Shared low-level file I/O (safe read, atomic write) — leaf module, no cycle.
const { safeReadJson, atomicWriteJson } = require("./lib/io");

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

let _cache = null;

function loadStore() {
  if (_cache) return _cache;
  _cache = readStore();
  return _cache;
}

function getDeviceId() {
  const store = loadStore();
  if (store.device_id) return store.device_id;

  const newId = crypto.randomUUID().toUpperCase();
  store.device_id = newId;
  writeStore(store);
  _cache = store;
  console.error("[skillmeter] New device ID created");
  return newId;
}

function getOrCreateHashSalt() {
  const store = loadStore();
  if (store.hash_salt) return store.hash_salt;

  const newSalt = crypto.randomBytes(16).toString("hex");
  store.hash_salt = newSalt;
  writeStore(store);
  _cache = store;
  console.error("[skillmeter] New hash salt created");
  return newSalt;
}

function getLicenseToken() {
  const store = loadStore();
  return store.license_jwt || null;
}

// Bypasses the in-process cache (`loadStore`) and reads from disk. The
// long-lived retry daemon warms `_cache` on first read and would otherwise
// never observe a license refreshed by another process (e.g. a SessionStart in
// a different terminal). Use this wherever the freshest on-disk token matters.
function getLicenseTokenUncached() {
  return readStore().license_jwt || null;
}

function setLicenseToken(jwt) {
  const store = readStore();
  store.license_jwt = jwt;
  writeStore(store);
  _cache = store;
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

// `telemetry_disabled` is the machine-global kill-switch toggled by
// `/skillmeter:telemetry disable-global`. Hooks check it before any
// per-project opt-in. Independent of signin state — the license stays
// intact while transmission is paused.
function getTelemetryDisabled() {
  return readStore().telemetry_disabled === true;
}

function setTelemetryDisabled(value) {
  const store = readStore();
  if (value === true) {
    store.telemetry_disabled = true;
  } else {
    delete store.telemetry_disabled;
  }
  writeStore(store);
  _cache = store;
}

// Drop the license JWT atomically (the validated org lives in the JWT, so
// nothing else needs clearing). Also removes the obsolete allowed_github_orgs
// key left by pre-JWT-org versions. Preserves device_id and hash_salt so the
// machine identity survives a sign-out / sign-in cycle.
function signOut() {
  const store = readStore();
  delete store.license_jwt;
  delete store.allowed_github_orgs; // legacy-key cleanup
  store.signed_out = true;
  writeStore(store);
  _cache = store;
}

// Called when the user explicitly invokes /skillmeter:signin — clears the
// signed-out sentinel so the next gh attempt is unblocked.
function markEngaged() {
  const store = readStore();
  delete store.signed_out;
  writeStore(store);
  _cache = store;
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
  _cache = store;
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
  getLicenseToken,
  getLicenseTokenUncached,
  setLicenseToken,
  isLicenseTokenExpired,
  hasValidLicense,
  getAllowedGitHubOrgs,
  // Atomic sign-in lifecycle — prefer these over the lower-level set* helpers
  // when adjusting more than one field, so partial writes can't race.
  commitSignin,
  markEngaged,
  signOut,
  // Flag accessors
  getSignedOut,
  getTelemetryDisabled,
  setTelemetryDisabled,
  // Sign-in result sentinel (for the FileChanged sign-in notifier)
  SIGNIN_RESULT_FILE,
  writeSigninResult,
  readSigninResult,
  ensureSigninResultFile,
  // Upload result sentinel (for the SessionStart "telemetry sent" notice)
  UPLOAD_RESULT_FILE,
  writeUploadResult,
  readUploadResult,
  markUploadNotified,
};

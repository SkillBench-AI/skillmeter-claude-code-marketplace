const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Resolved centrally in lib/paths.js so SKILLMETER_STATE_DIR can isolate a dev
// environment's credentials/identity from prod.
const { CRED_FILE } = require("./lib/paths");
// Canonical JWT helpers. The validated org(s) for telemetry are read straight
// from the license JWT (the activator's decision) — the client no longer stores
// or narrows a GitHub org list.
const { decodeJwtPayload, getLicenseOrgs } = require("./lib/jwt");

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Atomic write: write payload to a sibling tempfile, fsync, then rename into
// place. POSIX rename within the same filesystem is atomic — readers see either
// the old file or the new file, never a partial write. Concurrent writers can
// still lose updates; eliminating that requires a file lock (separate follow-up).
function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

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
  try {
    return JSON.parse(fs.readFileSync(SIGNIN_RESULT_FILE, "utf8"));
  } catch {
    return null;
  }
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
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
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

// Drop license + org list atomically. Preserves device_id and hash_salt
// so the machine identity survives a sign-out / sign-in cycle.
function signOut() {
  const store = readStore();
  delete store.license_jwt;
  delete store.allowed_github_orgs;
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
};

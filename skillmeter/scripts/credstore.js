const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { getSkillmeterStringSetting } = require("./lib/settings");

const CRED_FILE = path.join(os.homedir(), ".skillbench", "credentials.json");

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

function writeStore(data) {
  const dir = path.dirname(CRED_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Atomic write: write payload to a sibling tempfile, fsync, then
  // rename into place. POSIX rename within the same filesystem is
  // atomic — readers see either the old file or the new file, never
  // a partial write. Concurrent writers can still lose updates;
  // eliminating that requires a file lock (separate follow-up).
  const tempPath = `${CRED_FILE}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, CRED_FILE);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
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

function setLicenseToken(jwt) {
  const store = readStore();
  store.license_jwt = jwt;
  writeStore(store);
  _cache = store;
}

/**
 * Decode the payload section of a JWT without verifying the signature.
 * Only safe to use for local expiry hints; never trust the contents for
 * authorization decisions. Kept internal to credstore so the storage
 * layer can answer `isLicenseTokenExpired` without pulling a full JWT
 * library dependency.
 */
function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
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
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

function getGhFallbackRetryAfter() {
  const store = readStore();
  return Number(store.gh_fallback_retry_after) || 0;
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
  delete store.gh_fallback_retry_after;
  store.signed_out = true;
  writeStore(store);
  _cache = store;
}

// Called when the user explicitly invokes /skillmeter:signin — clears the
// signed-out sentinel and the gh-fallback cooldown in a single write so the
// next gh attempt is unblocked atomically.
function markEngaged() {
  const store = readStore();
  delete store.signed_out;
  delete store.gh_fallback_retry_after;
  writeStore(store);
  _cache = store;
}

function normalizeOrgs(orgs) {
  if (!Array.isArray(orgs)) return [];
  return Array.from(
    new Set(
      orgs
        .filter((o) => typeof o === "string")
        .map((o) => o.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

// Persist a freshly-issued license atomically. Re-reads the store at write
// time and aborts if /skillmeter:signout fired while the license issuance
// was in flight — the user's most recent intent wins. Returns true when
// the license was written, false when it was discarded.
function commitSignin({ jwt, orgs }) {
  const store = readStore();
  if (store.signed_out === true) return false;
  store.license_jwt = jwt;
  store.allowed_github_orgs = normalizeOrgs(orgs);
  delete store.gh_fallback_retry_after;
  writeStore(store);
  _cache = store;
  return true;
}

function setGhFallbackRetryAfter(unixSeconds) {
  const store = readStore();
  if (unixSeconds > 0) {
    store.gh_fallback_retry_after = unixSeconds;
  } else {
    delete store.gh_fallback_retry_after;
  }
  writeStore(store);
  _cache = store;
}

/**
 * GitHub identities (user login + org logins) the activated user is a member
 * of. Used by repo-scope to gate telemetry to the user's own repos and the
 * orgs they belong to. Empty array means "not activated" — gating treats
 * this as a hard block, not an allow-all.
 */
function getAllowedGitHubOrgs() {
  const store = loadStore();
  const orgs = store.allowed_github_orgs;
  if (!Array.isArray(orgs)) return [];
  return orgs;
}

/**
 * Fetch the activating user's GitHub login + every org they belong to.
 * Returns an array of lowercase logins suitable for passing to
 * `commitSignin`. Throws on any HTTP/network failure so the caller can
 * decide whether to abort.
 */
async function fetchUserGitHubOrgs(githubToken) {
  const headers = {
    "Authorization": `Bearer ${githubToken}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skillmeter-cli",
  };

  const userRes = await fetch("https://api.github.com/user", {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) {
    throw new Error(`GET /user returned ${userRes.status}`);
  }
  const userBody = await userRes.json();
  const userLogin = typeof userBody?.login === "string" ? userBody.login : "";

  const orgsRes = await fetch("https://api.github.com/user/orgs?per_page=100", {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!orgsRes.ok) {
    throw new Error(`GET /user/orgs returned ${orgsRes.status}`);
  }
  const orgsBody = await orgsRes.json();
  const orgLogins = Array.isArray(orgsBody)
    ? orgsBody.map((org) => (typeof org?.login === "string" ? org.login : ""))
    : [];

  return [userLogin, ...orgLogins].filter(Boolean);
}

// Default points at prod. Devs/agents override via SKILLMETER_ACTIVATE_URL
// (e.g. https://api.dev.skillbench.com/activate) or a `skillmeter.activate_url`
// entry in the project's .claude/settings.local.json.
const DEFAULT_ACTIVATE_URL = "https://api.skillbench.com/activate";

function getActivateUrl() {
  if (process.env.SKILLMETER_ACTIVATE_URL) return process.env.SKILLMETER_ACTIVATE_URL;
  const fromSettings = getSkillmeterStringSetting(process.cwd(), "activate_url");
  if (fromSettings) return fromSettings;
  return DEFAULT_ACTIVATE_URL;
}

const FAILURE_COOLDOWN = 24 * 60 * 60;
const TRANSIENT_COOLDOWN = 5 * 60;

/**
 * Attempt to activate silently using `gh auth token` if the user already
 * has the GitHub CLI authenticated. Returns the license JWT on success,
 * null otherwise. Failures are cached in the credstore so repeated hooks
 * don't hammer GitHub/the activation endpoint.
 */
async function trySilentGhActivate(deviceId) {
  if (getSignedOut()) {
    console.error("[skillmeter] gh activation skipped: signed out (run /skillmeter:signin to re-enable)");
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const retryAfter = getGhFallbackRetryAfter();
  if (retryAfter > now) {
    const secondsLeft = retryAfter - now;
    console.error(`[skillmeter] gh activation skipped: in cooldown for another ${secondsLeft}s`);
    return null;
  }

  let ghToken;
  try {
    ghToken = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    console.error("[skillmeter] gh activation skipped: gh CLI not installed or not authenticated");
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }
  if (!ghToken) {
    console.error("[skillmeter] gh activation skipped: `gh auth token` returned empty");
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  console.error("[skillmeter] gh activation: exchanging token with activation endpoint");

  let res;
  try {
    res = await fetch(getActivateUrl(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ghToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_id: deviceId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[skillmeter] gh activation failed: network error (${err.message})`);
    setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }

  if (res.status >= 500) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] gh activation failed: activation endpoint returned ${res.status} (${body.slice(0, 200)})`);
    setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] gh activation rejected: HTTP ${res.status} (${body.slice(0, 200)})`);
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[skillmeter] gh activation failed: activation endpoint returned invalid JSON");
    setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }
  const jwt = payload?.token;
  if (!jwt) {
    console.error("[skillmeter] gh activation failed: response missing `token` field");
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  // Fetch the user's GitHub identities BEFORE persisting the license so
  // license + orgs land atomically. If the gh CLI's token lacks the
  // `read:org` scope the fetch fails — we treat that as silent-path
  // failure and let the device-flow path run, which always requests the
  // right scopes.
  let orgs;
  try {
    orgs = await fetchUserGitHubOrgs(ghToken);
  } catch (err) {
    console.error(`[skillmeter] gh activation failed: cannot fetch GitHub orgs (${err.message})`);
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  if (!commitSignin({ jwt, orgs })) {
    console.error("[skillmeter] gh activation discarded: signed out during issuance");
    return null;
  }
  console.error(`[skillmeter] gh activation succeeded (allowed orgs: ${orgs.join(", ") || "none"})`);
  return jwt;
}

module.exports = {
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  setLicenseToken,
  isLicenseTokenExpired,
  LICENSE_EXPIRY_SKEW_SECONDS,
  getAllowedGitHubOrgs,
  fetchUserGitHubOrgs,
  trySilentGhActivate,
  // Atomic sign-in lifecycle — prefer these over the lower-level set* helpers
  // when adjusting more than one field, so partial writes can't race.
  commitSignin,
  markEngaged,
  signOut,
  // Flag accessors
  getSignedOut,
  getTelemetryDisabled,
  setTelemetryDisabled,
  getActivateUrl,
  DEFAULT_ACTIVATE_URL,
  CRED_FILE,
};

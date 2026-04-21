const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CRED_FILE = path.join(os.homedir(), ".skillbench", "credentials.json");

const KEYCHAIN_SERVICES = {
  device_id: "com.skillbench.device-id",
  hash_salt: "com.skillbench.hash-salt",
  license_jwt: "com.skillbench.license",
};

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
  fs.writeFileSync(CRED_FILE, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Keychain migration (one-time, macOS only)
// ---------------------------------------------------------------------------

function readKeychain(service) {
  const account = process.env.USER || process.env.USERNAME || "";
  if (!account) return null;
  try {
    const result = execSync(
      `security find-generic-password -a "${account}" -s "${service}" -w 2>/dev/null`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function migrateFromKeychain() {
  const store = readStore();
  let migrated = false;

  for (const [key, service] of Object.entries(KEYCHAIN_SERVICES)) {
    if (!store[key]) {
      const val = readKeychain(service);
      if (val) {
        store[key] = val;
        migrated = true;
      }
    }
  }

  if (migrated) {
    writeStore(store);
    console.error("[skillmeter] Migrated credentials from Keychain to ~/.skillbench/credentials.json");
  }

  return store;
}

// Also migrate from legacy fallback files in the plugin logs directory
function migrateFromFallbackFiles(logDir) {
  const store = readStore();
  let migrated = false;

  const legacyMap = {
    device_id: path.join(logDir, ".device-id"),
    hash_salt: path.join(logDir, ".hash-salt"),
  };

  for (const [key, filePath] of Object.entries(legacyMap)) {
    if (!store[key]) {
      try {
        if (fs.existsSync(filePath)) {
          const val = fs.readFileSync(filePath, "utf8").trim();
          if (val) {
            store[key] = val;
            migrated = true;
          }
        }
      } catch {}
    }
  }

  if (migrated) {
    writeStore(store);
    console.error("[skillmeter] Migrated credentials from legacy fallback files");
  }

  return store;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _cache = null;

function loadStore(logDir) {
  if (_cache) return _cache;

  _cache = readStore();

  // Migrate from legacy stores if any keys are missing
  const needed = !_cache.device_id || !_cache.hash_salt;
  if (needed) {
    _cache = migrateFromKeychain();
    _cache = migrateFromFallbackFiles(logDir);
  }

  return _cache;
}

function getDeviceId(logDir) {
  const store = loadStore(logDir);
  if (store.device_id) return store.device_id;

  const newId = crypto.randomUUID().toUpperCase();
  store.device_id = newId;
  writeStore(store);
  _cache = store;
  console.error("[skillmeter] New device ID created");
  return newId;
}

function getOrCreateHashSalt(logDir) {
  const store = loadStore(logDir);
  if (store.hash_salt) return store.hash_salt;

  const newSalt = crypto.randomBytes(16).toString("hex");
  store.hash_salt = newSalt;
  writeStore(store);
  _cache = store;
  console.error("[skillmeter] New hash salt created");
  return newSalt;
}

function getLicenseToken(logDir) {
  const store = loadStore(logDir);
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

const ACTIVATE_URL = "https://api.meter.skillbench.com/activate";
const FAILURE_COOLDOWN = 24 * 60 * 60;
const TRANSIENT_COOLDOWN = 5 * 60;

/**
 * Attempt to activate silently using `gh auth token` if the user already
 * has the GitHub CLI authenticated. Returns the license JWT on success,
 * null otherwise. Failures are cached in the credstore so repeated hooks
 * don't hammer GitHub/the activation endpoint.
 */
async function trySilentGhActivate(deviceId) {
  const now = Math.floor(Date.now() / 1000);
  if (getGhFallbackRetryAfter() > now) return null;

  let ghToken;
  try {
    ghToken = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }
  if (!ghToken) {
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  let res;
  try {
    res = await fetch(ACTIVATE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ghToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_id: deviceId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }

  if (res.status >= 500) {
    setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }
  if (!res.ok) {
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }
  const jwt = payload?.token;
  if (!jwt) {
    setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  setLicenseToken(jwt);
  setGhFallbackRetryAfter(0);
  return jwt;
}

module.exports = {
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  setLicenseToken,
  isLicenseTokenExpired,
  LICENSE_EXPIRY_SKEW_SECONDS,
  getGhFallbackRetryAfter,
  setGhFallbackRetryAfter,
  trySilentGhActivate,
  ACTIVATE_URL,
  CRED_FILE,
};

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

module.exports = {
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  setLicenseToken,
  CRED_FILE,
};

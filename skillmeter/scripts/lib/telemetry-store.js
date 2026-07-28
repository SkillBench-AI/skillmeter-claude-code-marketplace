/**
 * Machine-wide telemetry policy SSOT.
 *
 * Repository decisions are keyed by canonical GitHub identity, not a checkout
 * path, so clones and worktrees share one setting. credentials.json remains the
 * identity/JWT store; its legacy telemetry fields are imported once.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { CRED_FILE, TELEMETRY_POLICY_FILE } = require("./config");
const { safeReadJson, atomicWriteJson } = require("./io");
const { getLicenseOrgs } = require("./jwt");
const {
  getTelemetryOptInSnapshot,
  removeTelemetryOptIn,
  settingsPathFor,
} = require("./settings");

const SCHEMA_VERSION = 1;
const LEGACY_CREDENTIALS_VERSION = 1;
const LOCK_FILE = `${TELEMETRY_POLICY_FILE}.lock`;
const LOCK_STALE_MS = 10_000;

function emptyPolicy() {
  return {
    schema_version: SCHEMA_VERSION,
    revision: 0,
    global: { enabled: true },
    organizations: {},
    repositories: {},
    migration: {
      credentials_version: 0,
      legacy_settings: {},
    },
  };
}

function normalizeOrg(org) {
  return typeof org === "string" ? org.trim().toLowerCase() : "";
}

function normalizeRepoKey(repoKey) {
  if (typeof repoKey !== "string") return "";
  const match = repoKey.trim().toLowerCase().match(
    /^(?:github\.com\/)?([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/
  );
  return match ? `github.com/${match[1]}/${match[2].replace(/\.git$/, "")}` : "";
}

function normalizePolicy(raw) {
  const base = emptyPolicy();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  return {
    ...base,
    ...raw,
    schema_version: SCHEMA_VERSION,
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0,
    global: {
      enabled: raw.global?.enabled !== false,
      ...(raw.global || {}),
    },
    organizations: raw.organizations && typeof raw.organizations === "object"
      ? raw.organizations
      : {},
    repositories: raw.repositories && typeof raw.repositories === "object"
      ? raw.repositories
      : {},
    migration: {
      ...base.migration,
      ...(raw.migration || {}),
      legacy_settings:
        raw.migration?.legacy_settings &&
        typeof raw.migration.legacy_settings === "object"
          ? raw.migration.legacy_settings
          : {},
    },
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return fs.openSync(LOCK_FILE, "wx", 0o600);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {}
      sleepSync(10);
    }
  }
  throw new Error("Telemetry policy is busy.");
}

function withPolicyLock(callback) {
  const fd = acquireLock();
  try {
    return callback();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

function importLegacyCredentials(policy) {
  if (policy.migration.credentials_version >= LEGACY_CREDENTIALS_VERSION) {
    return false;
  }

  const credentials = safeReadJson(CRED_FILE, {});
  policy.global = {
    enabled: credentials.telemetry_disabled !== true,
    decided_at: Date.now(),
    source: "legacy",
  };
  for (const [org, record] of Object.entries(
    credentials.org_telemetry_consents || {}
  )) {
    const normalized = normalizeOrg(org);
    if (!normalized || typeof record?.enabled !== "boolean") continue;
    policy.organizations[normalized] = {
      enabled: record.enabled,
      consent_version: record.policy_version || 1,
      decided_at: record.decided_at || Date.now(),
      source: record.source || "legacy",
    };
  }

  // Preserve pre-org-consent behavior when the old migration had not run.
  if (
    credentials.org_telemetry_migration_version !== 1 &&
    credentials.license_jwt &&
    credentials.signed_out !== true
  ) {
    for (const org of getLicenseOrgs(credentials.license_jwt)) {
      const normalized = normalizeOrg(org);
      if (!normalized || policy.organizations[normalized]) continue;
      policy.organizations[normalized] = {
        enabled: true,
        consent_version: 1,
        decided_at: Date.now(),
        source: "legacy",
      };
    }
  }

  policy.migration.credentials_version = LEGACY_CREDENTIALS_VERSION;
  return true;
}

function disableLegacyCredentialPolicy() {
  const credentials = safeReadJson(CRED_FILE, {});
  let changed = false;
  if (credentials.telemetry_disabled !== true) {
    credentials.telemetry_disabled = true;
    changed = true;
  }
  for (const key of [
    "org_telemetry_consents",
    "org_telemetry_migration_version",
  ]) {
    if (key in credentials) {
      delete credentials[key];
      changed = true;
    }
  }
  if (changed) atomicWriteJson(CRED_FILE, credentials);
}

function ensurePolicy() {
  const policy = withPolicyLock(() => {
    const current = normalizePolicy(safeReadJson(TELEMETRY_POLICY_FILE, null));
    if (importLegacyCredentials(current) || !fs.existsSync(TELEMETRY_POLICY_FILE)) {
      current.revision++;
      atomicWriteJson(TELEMETRY_POLICY_FILE, current);
    }
    return current;
  });
  // Also retry after a crash between the policy write and credentials cleanup.
  // The operation is idempotent once legacy fields are gone.
  try { disableLegacyCredentialPolicy(); } catch {}
  return policy;
}

function readPolicy() {
  const existing = safeReadJson(TELEMETRY_POLICY_FILE, null);
  if (
    existing &&
    existing.schema_version === SCHEMA_VERSION &&
    existing.migration?.credentials_version >= LEGACY_CREDENTIALS_VERSION
  ) {
    try { disableLegacyCredentialPolicy(); } catch {}
    return normalizePolicy(existing);
  }
  return ensurePolicy();
}

function mutatePolicy(mutator, expectedRevision = null) {
  let changed = false;
  const policy = withPolicyLock(() => {
    const current = normalizePolicy(safeReadJson(TELEMETRY_POLICY_FILE, null));
    importLegacyCredentials(current);
    if (
      expectedRevision !== null &&
      current.revision !== expectedRevision
    ) {
      const err = new Error("Telemetry policy changed; reload and try again.");
      err.code = "STALE_POLICY";
      err.policy = current;
      throw err;
    }
    changed = mutator(current) !== false;
    if (changed) {
      current.revision++;
      atomicWriteJson(TELEMETRY_POLICY_FILE, current);
    }
    return current;
  });
  try { disableLegacyCredentialPolicy(); } catch {}
  return { policy, changed };
}

function sourceIdForSettings(repoRoot, salt) {
  return crypto.createHmac("sha256", salt)
    .update(path.resolve(settingsPathFor(repoRoot)))
    .digest("hex")
    .slice(0, 24);
}

function migrateLegacyRepositorySetting(repoRoot, repoKey) {
  const normalizedKey = normalizeRepoKey(repoKey);
  if (!repoRoot || !normalizedKey) return { migrated: false, cleaned: false };
  const legacy = getTelemetryOptInSnapshot(repoRoot);
  if (!legacy) {
    return { migrated: false, cleaned: false };
  }
  const legacyValue = legacy.value;

  let sourceId = "";
  const migration = mutatePolicy((current) => {
    if (!current.migration.source_salt) {
      current.migration.source_salt = crypto.randomBytes(16).toString("hex");
    }
    sourceId = sourceIdForSettings(
      repoRoot,
      current.migration.source_salt
    );
    const marker = current.migration.legacy_settings[sourceId];
    const importedFingerprint = typeof marker === "string"
      ? marker
      : marker?.source_fingerprint;
    if (importedFingerprint === legacy.fingerprint) {
      return false;
    }
    const existing = current.repositories[normalizedKey];
    if (!existing || existing.source === "legacy") {
      current.repositories[normalizedKey] = {
        enabled: existing?.enabled === false || legacyValue === false
          ? false
          : true,
        decided_at: Date.now(),
        source: "legacy",
      };
    }
    current.migration.legacy_settings[sourceId] = legacy.fingerprint;
    return true;
  });

  // Cleanup is deliberately after the central atomic write. The helper
  // re-reads and checks the expected value so a changed source is not erased.
  const cleaned = removeTelemetryOptIn(
    repoRoot,
    legacyValue,
    legacy.fingerprint
  );
  if (cleaned) {
    migration.policy = mutatePolicy((current) => {
      if (!current.migration.legacy_settings[sourceId]) return false;
      delete current.migration.legacy_settings[sourceId];
      return true;
    }).policy;
  }
  return {
    migrated: migration.changed,
    cleaned,
    policy: migration.policy,
  };
}

function getGlobalDisabled() {
  return readPolicy().global.enabled === false;
}

function setGlobalEnabled(enabled) {
  return mutatePolicy((policy) => {
    policy.global = {
      enabled: enabled === true,
      decided_at: Date.now(),
      source: "user",
    };
  }).policy.global;
}

function getOrganizationConsent(org) {
  const record = readPolicy().organizations[normalizeOrg(org)];
  return typeof record?.enabled === "boolean" ? record.enabled : null;
}

function setOrganizationConsent(org, enabled) {
  const normalized = normalizeOrg(org);
  if (!normalized) throw new Error("A GitHub organization is required.");
  if (typeof enabled !== "boolean") {
    throw new Error("Org telemetry consent must be boolean.");
  }
  return mutatePolicy((policy) => {
    policy.organizations[normalized] = {
      enabled,
      consent_version: 1,
      decided_at: Date.now(),
      source: "user",
    };
  }).policy.organizations[normalized];
}

function getRepositoryOverride(repoKey, repoRoot = "") {
  const normalized = normalizeRepoKey(repoKey);
  if (!normalized) return null;
  if (repoRoot) migrateLegacyRepositorySetting(repoRoot, normalized);
  const record = readPolicy().repositories[normalized];
  return typeof record?.enabled === "boolean" ? record.enabled : null;
}

function setRepositoryOverride(repoKey, enabled, expectedRevision = null) {
  const normalized = normalizeRepoKey(repoKey);
  if (!normalized) throw new Error("A canonical GitHub repository is required.");
  if (typeof enabled !== "boolean") {
    throw new Error("Repository telemetry override must be boolean.");
  }
  return mutatePolicy((policy) => {
    policy.repositories[normalized] = {
      enabled,
      decided_at: Date.now(),
      source: "user",
    };
  }, expectedRevision).policy.repositories[normalized];
}

function authorizeOrganizationRepositories(
  org,
  repoKeys,
  enabled,
  expectedRevision = null
) {
  const normalizedOrg = normalizeOrg(org);
  if (!normalizedOrg) throw new Error("A GitHub organization is required.");
  if (!Array.isArray(repoKeys) || typeof enabled !== "boolean") {
    throw new Error("A repository selection is required.");
  }
  const normalizedKeys = [...new Set(repoKeys.map(normalizeRepoKey))];
  if (
    normalizedKeys.some(
      (repoKey) => !repoKey || repoKey.split("/")[1] !== normalizedOrg
    )
  ) {
    throw new Error("Every repository must belong to the authorized organization.");
  }
  return mutatePolicy((policy) => {
    const decidedAt = Date.now();
    policy.organizations[normalizedOrg] = {
      enabled: true,
      consent_version: 1,
      decided_at: decidedAt,
      source: "user",
    };
    for (const repoKey of normalizedKeys) {
      policy.repositories[repoKey] = {
        enabled,
        decided_at: decidedAt,
        source: "user",
      };
    }
  }, expectedRevision).policy;
}

function getPolicyRevision() {
  return readPolicy().revision;
}

module.exports = {
  SCHEMA_VERSION,
  TELEMETRY_POLICY_FILE,
  normalizeOrg,
  normalizeRepoKey,
  readPolicy,
  mutatePolicy,
  migrateLegacyRepositorySetting,
  getGlobalDisabled,
  setGlobalEnabled,
  getOrganizationConsent,
  setOrganizationConsent,
  getRepositoryOverride,
  setRepositoryOverride,
  authorizeOrganizationRepositories,
  getPolicyRevision,
};

/**
 * Machine-wide telemetry policy SSOT.
 *
 * Repository decisions are keyed by canonical GitHub identity, not a checkout
 * path, so clones and worktrees share one setting. credentials.json is the
 * identity/JWT store and holds no telemetry state.
 */

const fs = require("fs");
const path = require("path");

const { TELEMETRY_POLICY_FILE } = require("./config");
const { safeReadJson, atomicWriteJson } = require("./io");

const SCHEMA_VERSION = 1;
const LOCK_FILE = `${TELEMETRY_POLICY_FILE}.lock`;
const LOCK_STALE_MS = 10_000;

function emptyPolicy() {
  return {
    schema_version: SCHEMA_VERSION,
    revision: 0,
    global: { enabled: true },
    organizations: {},
    repositories: {},
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

// Closed schema: only the fields below survive a read/write round-trip, so a
// key this version does not understand is never written back.
function normalizePolicy(raw) {
  const base = emptyPolicy();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  return {
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

function ensurePolicy() {
  return withPolicyLock(() => {
    const current = normalizePolicy(safeReadJson(TELEMETRY_POLICY_FILE, null));
    if (!fs.existsSync(TELEMETRY_POLICY_FILE)) {
      current.revision++;
      atomicWriteJson(TELEMETRY_POLICY_FILE, current);
    }
    return current;
  });
}

function readPolicy() {
  const existing = safeReadJson(TELEMETRY_POLICY_FILE, null);
  if (existing && existing.schema_version === SCHEMA_VERSION) {
    return normalizePolicy(existing);
  }
  return ensurePolicy();
}

function mutatePolicy(mutator, expectedRevision = null) {
  let changed = false;
  const policy = withPolicyLock(() => {
    const current = normalizePolicy(safeReadJson(TELEMETRY_POLICY_FILE, null));
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
  return { policy, changed };
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

function getRepositoryOverride(repoKey) {
  const normalized = normalizeRepoKey(repoKey);
  if (!normalized) return null;
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
  getGlobalDisabled,
  setGlobalEnabled,
  getOrganizationConsent,
  setOrganizationConsent,
  getRepositoryOverride,
  setRepositoryOverride,
  authorizeOrganizationRepositories,
  getPolicyRevision,
};

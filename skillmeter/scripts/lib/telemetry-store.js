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
// Version of the consent statement shown before a choice is recorded (ADR 004,
// decision 3). Version 2 names every client and every clone of the repository;
// records at 1 or without the field are legacy choices.
const CONSENT_VERSION = 2;
const CONSENT_STATEMENT =
  "Telemetry choices apply to every SkillMeter client on this machine " +
  "(Claude Code and Codex) and to every clone or worktree of the repository.";
const LOCK_FILE = `${TELEMETRY_POLICY_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
// Client-owned marker that this plugin has read a valid policy file. Once it
// exists, a missing policy file blocks capture and delivery instead of
// reading as first use (ADR 004, decision 5). One marker per policy path, so
// the dev and prod state directories never observe each other.
const OBSERVED_FILE = path.join(
  require("./paths").DATA_ROOT,
  `telemetry-policy-observed.${require("crypto")
    .createHash("sha256").update(TELEMETRY_POLICY_FILE).digest("hex").slice(0, 12)}.json`
);

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

function blockedError(reason) {
  const err = new Error(
    `Telemetry policy file is ${reason.replace(/_/g, " ")}; repair ` +
    `${TELEMETRY_POLICY_FILE} before changing telemetry settings.`
  );
  err.code = "POLICY_BLOCKED";
  err.reason = reason;
  return err;
}

// Classify the policy file without normalizing it into permission. A blocked
// state keeps the file's bytes, holds queues and refuses the ordinary
// enable/disable controls; only a readable policy or an explicit repair ends it.
function classifyPolicyFile() {
  let raw;
  try {
    raw = fs.readFileSync(TELEMETRY_POLICY_FILE, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { status: "absent" };
    return { status: "unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed" };
  }
  if (parsed.schema_version !== SCHEMA_VERSION) return { status: "unsupported_schema" };
  return { status: "valid", raw: parsed };
}

function recordObservation(policy) {
  const previous = safeReadJson(OBSERVED_FILE, null);
  if (previous?.file === TELEMETRY_POLICY_FILE && previous.revision === policy.revision) {
    return true;
  }
  try {
    atomicWriteJson(OBSERVED_FILE, {
      file: TELEMETRY_POLICY_FILE,
      revision: policy.revision,
      observed_at: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

function policyObserved() {
  return safeReadJson(OBSERVED_FILE, null)?.file === TELEMETRY_POLICY_FILE;
}

// The state every reader shares: `{ status: "valid", policy }` or a blocked
// state `{ status, reason, policy }` whose policy grants nothing.
function readPolicyState() {
  const file = classifyPolicyFile();
  if (file.status === "absent") {
    if (policyObserved()) {
      return { status: "blocked", reason: "missing_after_observation", policy: blockedPolicy("missing_after_observation") };
    }
    const policy = ensurePolicy();
    if (!recordObservation(policy)) {
      return { status: "blocked", reason: "marker_unavailable", policy: blockedPolicy("marker_unavailable") };
    }
    return { status: "valid", policy };
  }
  if (file.status !== "valid") {
    return { status: "blocked", reason: file.status, policy: blockedPolicy(file.status) };
  }
  const policy = normalizePolicy(file.raw);
  if (!recordObservation(policy)) {
    return { status: "blocked", reason: "marker_unavailable", policy: blockedPolicy("marker_unavailable") };
  }
  return { status: "valid", policy };
}

function blockedPolicy(reason) {
  return { ...emptyPolicy(), blocked: reason };
}

function readPolicy() {
  return readPolicyState().policy;
}

function getPolicyBlockedReason() {
  const state = readPolicyState();
  return state.status === "blocked" ? state.reason : null;
}

function mutatePolicy(mutator, expectedRevision = null) {
  let changed = false;
  const policy = withPolicyLock(() => {
    const file = classifyPolicyFile();
    if (file.status === "absent" && policyObserved()) {
      throw blockedError("missing_after_observation");
    }
    if (file.status !== "absent" && file.status !== "valid") {
      throw blockedError(file.status);
    }
    const current = normalizePolicy(file.status === "valid" ? file.raw : null);
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
      recordObservation(current);
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
      consent_version: CONSENT_VERSION,
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
      consent_version: CONSENT_VERSION,
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
      consent_version: CONSENT_VERSION,
      decided_at: decidedAt,
      source: "user",
    };
    for (const repoKey of normalizedKeys) {
      policy.repositories[repoKey] = {
        enabled,
        consent_version: CONSENT_VERSION,
        decided_at: decidedAt,
        source: "user",
      };
    }
  }, expectedRevision).policy;
}

// ON records written before the cross-client statement existed. They keep
// authorizing this plugin, which recorded them, but another client must not
// treat them as shared consent until the user confirms the statement once.
function legacyConsentRecords(policy = readPolicy()) {
  const legacy = { organizations: [], repositories: [] };
  for (const [org, record] of Object.entries(policy.organizations)) {
    if (record?.enabled === true && record.consent_version !== CONSENT_VERSION) {
      legacy.organizations.push(org);
    }
  }
  for (const [repoKey, record] of Object.entries(policy.repositories)) {
    if (record?.enabled === true && record.consent_version !== CONSENT_VERSION) {
      legacy.repositories.push(repoKey);
    }
  }
  return legacy;
}

function acknowledgementRequired(policy) {
  const legacy = legacyConsentRecords(policy);
  return legacy.organizations.length > 0 || legacy.repositories.length > 0;
}

// Stamp every ON record with the current statement version. Runs under the
// policy lock with an expected revision so a concurrent OFF is never overwritten.
function acknowledgeConsentStatement(expectedRevision = null) {
  let acknowledged = 0;
  const { policy } = mutatePolicy((current) => {
    const legacy = legacyConsentRecords(current);
    const stamp = { consent_version: CONSENT_VERSION, acknowledged_at: Date.now() };
    for (const org of legacy.organizations) {
      Object.assign(current.organizations[org], stamp);
      acknowledged++;
    }
    for (const repoKey of legacy.repositories) {
      Object.assign(current.repositories[repoKey], stamp);
      acknowledged++;
    }
    return acknowledged > 0;
  }, expectedRevision);
  return { revision: policy.revision, acknowledged };
}

function getPolicyRevision() {
  return readPolicy().revision;
}

module.exports = {
  SCHEMA_VERSION,
  CONSENT_VERSION,
  CONSENT_STATEMENT,
  TELEMETRY_POLICY_FILE,
  OBSERVED_FILE,
  normalizeOrg,
  normalizeRepoKey,
  readPolicy,
  readPolicyState,
  getPolicyBlockedReason,
  legacyConsentRecords,
  acknowledgementRequired,
  acknowledgeConsentStatement,
  getGlobalDisabled,
  setGlobalEnabled,
  getOrganizationConsent,
  setOrganizationConsent,
  getRepositoryOverride,
  setRepositoryOverride,
  authorizeOrganizationRepositories,
  getPolicyRevision,
};

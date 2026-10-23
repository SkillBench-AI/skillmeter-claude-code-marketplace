"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { policyPathIsAbsent } = require("./consent-policy");

// Codex's consent record. It keeps the schema of the Claude plugin's record so
// the two stay easy to compare, but no other client reads or writes this file
// (ADR 006 in the Claude plugin repository). Ordinary writes never repair
// invalid policy.
const FIELDS = ["schema_version", "revision", "global", "organizations", "repositories"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const record = value => object(value) && typeof value.enabled === "boolean" &&
  (value.decided_at === undefined || integer(value.decided_at)) &&
  (value.consent_version === undefined || [1, 2].includes(value.consent_version));

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

// Temp files are uniquely named and never read back. Their cleanup is best
// effort: a failure here must not replace the outcome of the write it follows,
// which has already committed or already failed with its own error.
function discard(temp) {
  try { fs.unlinkSync(temp); } catch {}
}

// A renamed or linked directory entry is only durable once its directory is
// synced. Without this, a revoking write could reappear as the old grant after
// a crash, and a lost marker would read as first use instead of POLICY_MISSING.
// Returns false where the platform cannot sync a directory: on Windows, libuv
// opens directories read-only and FlushFileBuffers requires write access. The
// caller reports that durability is unconfirmed rather than claiming a sync.
function syncDir(dir) {
  if (process.platform === "win32") return false;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}

function validatePolicy(policy) {
  if (!object(policy) || policy.schema_version !== 1 || !integer(policy.revision) ||
      Object.keys(policy).some(key => !FIELDS.includes(key)) || !record(policy.global) ||
      !object(policy.organizations) || !object(policy.repositories) ||
      !Object.values(policy.organizations).every(record) || !Object.values(policy.repositories).every(record)) {
    throw error("INVALID_POLICY", "Consent record is invalid or unsupported; repair it explicitly before changing consent.");
  }
  return policy;
}

function normalizeRepoKey(value) {
  if (typeof value !== "string") return "";
  const match = value.trim().toLowerCase().match(/^(?:github\.com\/)?([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/);
  return match ? `github.com/${match[1]}/${match[2].replace(/\.git$/, "")}` : "";
}

function normalizeOrg(value) {
  if (typeof value !== "string") return "";
  const org = value.trim().toLowerCase();
  return /^[a-z0-9_.-]+$/.test(org) ? org : "";
}

function createConsentStore({ file, observedFile }) {
  if (!file || !observedFile || path.resolve(file) === path.resolve(observedFile)) {
    throw new Error("Separate consent record and observation paths are required.");
  }
  const lockFile = `${file}.lock`;

  function validMarker() {
    try { return fs.lstatSync(observedFile).isFile() && fs.readFileSync(observedFile, "utf8") === "1\n"; }
    catch { return false; }
  }

  function observed(mark = false, onCreate = () => {}) {
    try {
      if (mark && !observed()) {
        fs.mkdirSync(path.dirname(observedFile), { recursive: true, mode: 0o700 });
        const temp = `${observedFile}.${randomUUID()}.tmp`;
        let fd;
        try {
          fd = fs.openSync(temp, "wx", 0o600);
          fs.writeFileSync(fd, "1\n"); fs.fsyncSync(fd);
          fs.linkSync(temp, observedFile);
          // Report the new marker before syncing, so a failed sync can still be
          // rolled back by a first write that owns it.
          onCreate(fs.fstatSync(fd));
          syncDir(path.dirname(observedFile));
        } catch (err) { if (err.code !== "EEXIST") throw err; }
        finally {
          if (fd !== undefined) fs.closeSync(fd);
          discard(temp);
        }
      }
      if (!fs.lstatSync(observedFile).isFile() || fs.readFileSync(observedFile, "utf8") !== "1\n") throw new Error("invalid marker");
      return true;
    } catch (err) {
      if (!mark && err.code === "ENOENT") {
        if (policyPathIsAbsent(observedFile)) return false;
        // Another process may have published the marker between the two
        // lookups; a valid marker is an observation, not a broken path.
        if (validMarker()) return true;
      }
      throw error("POLICY_OBSERVATION_FAILED", "Cannot persist or read the consent record observation; check client data permissions.");
    }
  }

  function readPolicy() {
    let raw;
    try {
      // Renaming onto a file symlink would detach this client from its target.
      if (!fs.lstatSync(file).isFile()) throw new Error("not a regular policy file");
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT" && policyPathIsAbsent(file)) {
        if (observed()) throw error("POLICY_MISSING", "Previously observed consent record is missing; restore it before changing consent.");
        return null;
      }
      throw error("INVALID_POLICY", "Cannot read the consent record; check its path and permissions before changing consent.");
    }
    observed(true);
    let policy;
    try { policy = JSON.parse(raw); }
    catch { throw error("INVALID_POLICY", "Consent record contains invalid JSON; repair it explicitly."); }
    return validatePolicy(policy);
  }

  function withLock(callback) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { fd = fs.openSync(lockFile, "wx", 0o600); break; }
      catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Age alone cannot prove that a lock's writer exited, so leave even an
        // old lock for explicit recovery.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (fd === undefined) throw error("POLICY_BUSY", "Consent record is busy; retry after the other writer finishes.");
    const token = randomUUID();
    const acquiredAt = Date.now();
    const owned = () => {
      try { return fs.readFileSync(lockFile, "utf8") === token; }
      catch { return false; }
    };
    try {
      fs.writeFileSync(fd, token);
      return callback(() => {
        // A lock held past ten seconds counts as expired. An expired or
        // replaced lock must not commit or remove its replacement.
        if (Date.now() - acquiredAt >= 10_000 || !owned()) throw error("POLICY_BUSY", "Consent record lock changed; reload and retry.");
      });
    } finally {
      fs.closeSync(fd);
      if (owned()) fs.unlinkSync(lockFile);
    }
  }

  function mutate(mutator, options, onCommitted) {
    if (onCommitted !== undefined && typeof onCommitted !== "function") throw new TypeError("Commit observer must be a function.");
    const expected = options?.expectedRevision;
    if (expected !== null && !integer(expected)) {
      throw error("EXPECTED_REVISION_REQUIRED", "Read the policy first and supply its revision (null only for first use).");
    }
    // Check paths before creating directories or acquiring a lock.
    readPolicy();
    return withLock(assertOwned => {
      const previous = readPolicy();
      if ((previous?.revision ?? null) !== expected) {
        throw error("STALE_POLICY", "Consent record changed; reload the choices and confirm again.");
      }
      const policy = previous || { schema_version: 1, revision: 0, global: { enabled: true }, organizations: {}, repositories: {} };
      mutator(policy);
      policy.revision++;
      validatePolicy(policy);
      let createdMarker;
      const temp = `${file}.tmp.${process.pid}.${randomUUID()}`;
      let fd;
      try {
        // Inside the rollback scope: a marker published by this attempt is
        // removed if the attempt fails before the policy exists.
        observed(true, stat => { createdMarker = stat; });
        fd = fs.openSync(temp, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(policy, null, 2) + "\n");
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        assertOwned();
        fs.renameSync(temp, file);
        // The rename already published the choice. A failed directory sync must
        // not skip local reconciliation of it, so report it only afterwards.
        let directorySyncError, directorySynced = false;
        try { directorySynced = syncDir(path.dirname(file)); }
        catch (err) { directorySyncError = err; }
        // Keep cooperating writers out until the client has observed revocation.
        try { onCommitted?.(policy); }
        catch { throw error("POLICY_COMMITTED_OBSERVER_FAILED", "Consent record was saved, but local reconciliation failed; inspect consent-preview and retry queue cleanup."); }
        if (directorySyncError) {
          throw Object.assign(error("POLICY_COMMITTED_DURABILITY_UNCERTAIN",
            "Consent record was saved and local cleanup ran, but the save may not survive a crash; inspect consent-preview before retrying."),
          { cause: directorySyncError });
        }
        Object.defineProperty(policy, "durability", { value: directorySynced ? "synced" : "unconfirmed" });
      } catch (err) {
        // A failed first write has not observed a policy. Roll back only this
        // attempt's marker, under our lock, while the policy is still absent.
        // Uncertain ownership or cleanup failure deliberately leaves the hold.
        if (!previous && createdMarker) {
          try {
            assertOwned();
            const current = fs.lstatSync(observedFile);
            if (current.dev === createdMarker.dev && current.ino === createdMarker.ino && policyPathIsAbsent(file)) {
              fs.unlinkSync(observedFile);
            }
          } catch { /* Preserve the original write error and fail closed. */ }
        }
        throw err;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        discard(temp);
      }
      return policy;
    });
  }

  function decision(enabled, previous) {
    if (typeof enabled !== "boolean") throw new TypeError("Telemetry consent must be boolean.");
    return { enabled, decided_at: Math.max(Date.now(), (previous?.decided_at ?? 0) + 1), source: "user" };
  }

  function setRepositoryOverride(repoKey, enabled, options) {
    const key = normalizeRepoKey(repoKey);
    if (!key || key.endsWith("/")) throw new Error("A canonical GitHub repository is required.");
    return setChoice("repositories", key, enabled, options);
  }

  function setOrganizationConsent(org, enabled, options) {
    const key = normalizeOrg(org);
    if (!key) throw new Error("A GitHub organization is required.");
    return setChoice("organizations", key, enabled, options);
  }

  // ON records `consent_version: 2`: the user was shown that the choice covers
  // Codex in every clone or worktree on this machine.
  function setChoice(section, key, enabled, options) {
    if (enabled === true && options?.acknowledged !== true) {
      throw error("ACKNOWLEDGEMENT_REQUIRED", "Enabling requires acknowledgement of machine-wide consent scope.");
    }
    return mutate(policy => {
      policy[section][key] = {
        ...decision(enabled, policy[section][key]),
        ...(enabled === true ? { consent_version: 2 } : {}),
      };
    }, options, options?.onCommitted);
  }

  // Sign-in onboarding: organization ON and the listed repositories ON or OFF
  // in one revision, so an interrupted onboarding never leaves half a choice.
  function setOrganizationRepositories(org, repoKeys, repositoriesEnabled, options) {
    const orgKey = normalizeOrg(org);
    if (!orgKey) throw new Error("A GitHub organization is required.");
    if (typeof repositoriesEnabled !== "boolean") throw new TypeError("Telemetry consent must be boolean.");
    const keys = [...new Set([].concat(repoKeys).map(normalizeRepoKey))];
    if (keys.some(key => !key || key.split("/")[1] !== orgKey)) {
      throw new Error("Every repository must be a canonical GitHub repository of the organization.");
    }
    if (options?.acknowledged !== true) {
      throw error("ACKNOWLEDGEMENT_REQUIRED", "Enabling requires acknowledgement of machine-wide consent scope.");
    }
    return mutate(policy => {
      // An organization already ON keeps its record: its decided_at is part of
      // every repository's consent stamp, so re-deciding it would read as a
      // changed choice and hold the queues of repositories already ON.
      const organization = policy.organizations[orgKey];
      if (organization?.enabled !== true || organization.consent_version !== 2) {
        policy.organizations[orgKey] = { ...decision(true, organization), consent_version: 2 };
      }
      for (const key of keys) {
        policy.repositories[key] = {
          ...decision(repositoriesEnabled, policy.repositories[key]),
          ...(repositoriesEnabled ? { consent_version: 2 } : {}),
        };
      }
    }, options, options?.onCommitted);
  }

  // Several repository choices in one revision, for the telemetry list picker.
  // `choices` maps repository keys to ON (true) or OFF (false).
  function setRepositoryChoices(choices, options) {
    const entries = Object.entries(choices).map(([key, enabled]) => [normalizeRepoKey(key), enabled]);
    if (!entries.length || entries.some(([key, enabled]) => !key || typeof enabled !== "boolean")) {
      throw new Error("Canonical GitHub repositories with boolean choices are required.");
    }
    if (entries.some(([, enabled]) => enabled) && options?.acknowledged !== true) {
      throw error("ACKNOWLEDGEMENT_REQUIRED", "Enabling requires acknowledgement of machine-wide consent scope.");
    }
    return mutate(policy => {
      for (const [key, enabled] of entries) {
        policy.repositories[key] = { ...decision(enabled, policy.repositories[key]), ...(enabled ? { consent_version: 2 } : {}) };
      }
    }, options, options?.onCommitted);
  }

  function setGlobalEnabled(enabled, options) {
    return mutate(policy => { policy.global = decision(enabled, policy.global); }, options);
  }

  return { readPolicy, setRepositoryOverride, setOrganizationConsent, setOrganizationRepositories, setRepositoryChoices, setGlobalEnabled };
}

module.exports = { createConsentStore, normalizeRepoKey };

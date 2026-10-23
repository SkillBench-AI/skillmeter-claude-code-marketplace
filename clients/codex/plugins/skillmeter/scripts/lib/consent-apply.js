"use strict";
const { buildConsentPreview } = require("./consent-preview");
const error = (code, message) => Object.assign(new Error(message), { code });

const CONSENT_SET_USAGE = "Usage: consent-set <on|off> (--organization org | --repository github.com/org/repo) --revision <number|absent> [--acknowledge-machine-scope]";

function parseConsentChoiceArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const fail = () => { throw error("INVALID_ARGUMENTS", CONSENT_SET_USAGE); };
  if (!["on", "off"].includes(args[0])) fail();
  const options = { enabled: args[0] === "on", acknowledged: false };
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail();
    seen.add(arg);
    if (arg === "--acknowledge-machine-scope") options.acknowledged = true;
    else if (arg === "--repository") options.repository = args[++i];
    else if (arg === "--organization") options.organization = args[++i];
    else if (arg === "--revision") {
      const value = args[++i];
      if (value !== "absent" && !/^(0|[1-9][0-9]*)$/.test(value || "")) fail();
      options.expectedRevision = value === "absent" ? null : Number(value);
    } else fail();
  }
  if (!options.repository === !options.organization || !seen.has("--revision")) fail();
  return options;
}

function checkChoice(enabled, expectedRevision) {
  if (typeof enabled !== "boolean") throw error("CHOICE_REQUIRED", "Choose ON or OFF explicitly; a local choice is never migrated automatically.");
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw error("EXPECTED_REVISION_REQUIRED", "Run consent-preview and supply its revision, or absent for first use.");
  }
}

function checkRevision(store, expectedRevision) {
  const policy = store.readPolicy();
  if ((policy?.revision ?? null) !== expectedRevision) throw error("STALE_POLICY", "Consent record changed; run consent-preview and confirm the current choices again.");
  return policy;
}

// The organization must be one the license covers after any configured
// narrowing; consent for an organization outside that scope would never apply.
function applyOrganizationConsent({ store, organization, allowedOrgs, expectedRevision, enabled, acknowledged, onCommitted }) {
  checkChoice(enabled, expectedRevision);
  const org = typeof organization === "string" ? organization.trim().toLowerCase() : "";
  if (!org || !allowedOrgs.includes(org)) {
    throw error("ORGANIZATION_UNAVAILABLE", "This organization is not covered by the current license and scope settings; check sign-in and sk-jwt.");
  }
  if (enabled && acknowledged !== true) {
    throw error("ACKNOWLEDGEMENT_REQUIRED", "ON lets Codex on this machine capture repositories of this organization that are also enabled. Review consent-preview, then pass --acknowledge-machine-scope to confirm.");
  }
  checkRevision(store, expectedRevision);
  return store.setOrganizationConsent(org, enabled, { expectedRevision, acknowledged, onCommitted });
}

function applyRepositoryConsent({ cwd, scope, store, repository, expectedRevision, enabled, acknowledged, onCommitted }) {
  checkChoice(enabled, expectedRevision);
  if (!scope.allowed || !scope.repoKey) throw error("REPOSITORY_UNAVAILABLE", "No allowed canonical repository is available; check sign-in, organization scope and Git remotes.");
  if (repository !== scope.repoKey) throw error("REPOSITORY_CHANGED", "Repository differs from the preview; run consent-preview here and confirm again.");
  if (enabled && acknowledged !== true) {
    throw error("ACKNOWLEDGEMENT_REQUIRED", "ON lets Codex on this machine capture every clone or worktree of this repository. Review consent-preview, then pass --acknowledge-machine-scope to confirm.");
  }
  const policy = checkRevision(store, expectedRevision);
  if (enabled) {
    const preview = buildConsentPreview({ cwd, scope, policy });
    if (preview.localChoices.some(choice => ["off", "invalid"].includes(choice.choice))) {
      throw error("LOCAL_CONSENT_CONFLICT", "Local OFF or invalid settings remain a restriction. Inspect consent-preview and resolve them explicitly before enabling this repository.");
    }
    const org = repository.split("/")[1];
    const choice = policy?.organizations?.[org];
    if (choice?.enabled !== true || choice.consent_version !== 2) {
      throw error("ORGANIZATION_CONSENT_REQUIRED", `Enable the organization first: consent-set on --organization ${org} --revision <revision> --acknowledge-machine-scope.`);
    }
  }
  // The store checks the revision again under its lock. Local settings remain
  // untouched, so a concurrent local OFF continues to restrict capture.
  return store.setRepositoryOverride(repository, enabled, { expectedRevision, acknowledged, onCommitted });
}
// Sign-in onboarding for one organization. `inventory` is a fresh
// repository-inventory result; only its repositories of that organization can
// be named, and a checkout with a local OFF or invalid setting cannot be
// turned on here (the same rule as applyRepositoryConsent).
function applyOnboardingSelection({ store, inventory, organization, repositories, repositoriesEnabled, expectedRevision, acknowledged, onCommitted }) {
  checkChoice(repositoriesEnabled, expectedRevision);
  const org = typeof organization === "string" ? organization.trim().toLowerCase() : "";
  if (!org || !inventory.orgs.some(entry => entry.org === org)) {
    throw error("ORGANIZATION_UNAVAILABLE", "This organization is not covered by the current license and scope settings; check sign-in and sk-jwt.");
  }
  const known = new Map(inventory.repositories.filter(repo => repo.org === org).map(repo => [repo.key, repo]));
  const selected = [...new Set(repositories)].map(key => known.get(key));
  if (selected.some(repo => !repo)) {
    throw error("REPOSITORY_CHANGED", "A repository is not in the current list for this organization; run list again and confirm.");
  }
  if (repositoriesEnabled && selected.some(repo => repo.localRestriction)) {
    throw error("LOCAL_CONSENT_CONFLICT", "A selected checkout has a local OFF or invalid setting; leave it out or resolve it first.");
  }
  if (acknowledged !== true) {
    throw error("ACKNOWLEDGEMENT_REQUIRED", "Authorizing an organization lets Codex on this machine capture its enabled repositories in every clone or worktree. Show the scope statement, then pass --acknowledge-machine-scope.");
  }
  checkRevision(store, expectedRevision);
  return store.setOrganizationRepositories(org, selected.map(repo => repo.key), repositoriesEnabled, { expectedRevision, acknowledged, onCommitted });
}

// The telemetry list picker: flip each selected repository from a fresh
// inventory. Repositories without an `action` are reported, not changed.
// Returns null when nothing can change, so no revision is spent.
function applyRepositoryToggles({ store, inventory, repositories, expectedRevision, acknowledged, onCommitted }) {
  checkChoice(true, expectedRevision);
  const known = new Map(inventory.repositories.map(repo => [repo.key, repo]));
  const selected = [...new Set(repositories)].map(key => known.get(key));
  if (!selected.length || selected.some(repo => !repo)) {
    throw error("REPOSITORY_CHANGED", "A repository is not in the current list; run list again and confirm.");
  }
  const changes = Object.fromEntries(selected.filter(repo => repo.action).map(repo => [repo.key, repo.action === "enable"]));
  if (Object.values(changes).some(Boolean) && acknowledged !== true) {
    throw error("ACKNOWLEDGEMENT_REQUIRED", "Turning a repository on lets Codex on this machine capture every clone or worktree of it. Show the scope statement, then pass --acknowledge-machine-scope.");
  }
  if (!Object.keys(changes).length) return null;
  checkRevision(store, expectedRevision);
  return store.setRepositoryChoices(changes, { expectedRevision, acknowledged, onCommitted });
}

module.exports = { applyOrganizationConsent, applyRepositoryConsent, applyOnboardingSelection, applyRepositoryToggles, parseConsentChoiceArgs, CONSENT_SET_USAGE };

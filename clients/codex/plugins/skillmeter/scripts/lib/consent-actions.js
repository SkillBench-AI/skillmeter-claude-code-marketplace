"use strict";
/**
 * The writes behind sign-in onboarding and the telemetry list: `toggle`,
 * `onboard` and `org`, shared by repository_telemetry.js and the MCP server.
 * Each reads a fresh inventory, refuses a stale revision without writing and
 * returns the JSON result the commands print. Errors carry a `code`.
 */

const { loadInventory } = require("./repository-inventory");
const apply = require("./consent-apply");

const sameRevision = (expected, inventory) => expected === (inventory.revision === "absent" ? null : inventory.revision);

/**
 * @param {object} options
 * @param {"toggle"|"onboard"|"org"} options.action
 * @param {number|null} options.expectedRevision null before the first choice
 * @param {string} [options.organization] onboard and org
 * @param {boolean} [options.enabled] onboard (repositories) and org
 * @param {string[]} [options.keys] repository keys from the same inventory
 * @param {boolean} options.acknowledged the scope statement was confirmed
 * @param {string} [options.cwd]
 */
function runConsentAction({ action, expectedRevision, organization, enabled, keys = [], acknowledged, cwd = process.cwd() }) {
  const { store, inventory, logger } = loadInventory({ cwd });
  if (!sameRevision(expectedRevision, inventory)) return { stale: true, revision: inventory.revision };

  let cleaned = false;
  const onCommitted = () => {
    // As in consent-set: observe the saved choice before the writer lock is
    // released. Cleanup failures cannot roll back consent.
    try { cleaned = logger.reconcileConsentRevocations(); logger.observeKnownTranscriptConsent(); }
    catch { cleaned = false; }
  };
  const common = { store, inventory, expectedRevision, acknowledged, onCommitted };
  let policy;
  try {
    if (action === "toggle") {
      policy = apply.applyRepositoryToggles({ ...common, repositories: keys });
    } else if (action === "onboard") {
      policy = apply.applyOnboardingSelection({ ...common, organization, repositories: keys, repositoriesEnabled: enabled });
    } else if (action === "org") {
      policy = apply.applyOrganizationConsent({ ...common, allowedOrgs: inventory.orgs.map(entry => entry.org), organization, enabled });
    } else {
      throw Object.assign(new Error(`Unknown action ${action}.`), { code: "INVALID_ARGUMENTS" });
    }
  } catch (err) {
    if (err.code !== "STALE_POLICY") throw err;
    return { stale: true, revision: loadInventory({ cwd }).inventory.revision };
  }

  const after = loadInventory({ cwd }).inventory;
  const selected = new Set(keys);
  const before = new Map(inventory.repositories.map(repo => [repo.key, repo]));
  const results = after.repositories.filter(repo => selected.has(repo.key)).map(({ key, displayName, effective }) => {
    if (action !== "toggle") return { key, displayName, effective };
    const { action: change, blockedBy } = before.get(key);
    return { key, displayName, changed: Boolean(policy && change), effective, ...(change ? {} : { reason: blockedBy }) };
  });
  // OFF removes queued payloads; report when that cleanup was deferred.
  const turnedOff = action === "toggle" ? keys.some(key => before.get(key)?.action === "disable") : !enabled;
  const summary = { revision: policy ? policy.revision : inventory.revision };
  if (action !== "toggle") {
    const org = organization.trim().toLowerCase();
    Object.assign(summary, { organization: org, consent: after.orgs.find(entry => entry.org === org)?.consent ?? null });
  }
  return {
    ...summary,
    globalPaused: after.globalPaused,
    results,
    cleanupDeferred: Boolean(policy) && turnedOff && !cleaned,
    durabilityUnconfirmed: policy?.durability === "unconfirmed",
  };
}

module.exports = { runConsentAction };

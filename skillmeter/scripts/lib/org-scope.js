/**
 * GitHub org-scope resolution + narrowing.
 *
 * A signed-in account often belongs to several GitHub orgs. By default the
 * plugin captures telemetry for all of them, but a user can narrow scope to a
 * subset (e.g. only "skillbench-ai"). The same configuration is honored in two
 * places:
 *
 *   - at sign-in, to narrow which orgs get persisted into `allowed_github_orgs`
 *     (so the silent `gh` path doesn't silently enroll every org); and
 *   - at runtime, as the repo-scope gate's allow-list (see lib/repo-scope.js
 *     getRepoScopeDecision / getRepoScopeOrgFilter).
 *
 * Narrowing is always an *intersection* with the user's real memberships — it
 * can only restrict the captured set, never widen it.
 */

const { readSettingsFile } = require("./settings");

/** Normalize to lowercase, trimmed, de-duplicated, non-empty org names. */
function normalizeOrgList(orgs) {
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

function splitOrgString(value) {
  return normalizeOrgList(String(value).split(/[,\s]+/));
}

/**
 * Resolve the configured org scope (the narrowing allow-list). Precedence:
 *   1. explicit `cliOrgs` (e.g. from `signin --org skillbench-ai`)
 *   2. SKILLMETER_REPO_SCOPE_ORGS env var (comma/space-separated)
 *   3. skillmeter.repoScopeOrgs in <cwd>/.claude/settings.local.json
 *      (array of org names, or a comma-separated string)
 * Returns a normalized array, or null when nothing is configured (= no
 * narrowing, the default "all signed-in orgs" behavior).
 */
function resolveOrgScope({ cwd = process.cwd(), cliOrgs } = {}) {
  if (Array.isArray(cliOrgs)) {
    const list = normalizeOrgList(cliOrgs);
    if (list.length) return list;
  }

  const fromEnv = process.env.SKILLMETER_REPO_SCOPE_ORGS;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    const list = splitOrgString(fromEnv);
    if (list.length) return list;
  }

  const settings = readSettingsFile(cwd);
  const raw =
    settings && settings.skillmeter ? settings.skillmeter.repoScopeOrgs : undefined;
  if (Array.isArray(raw)) {
    const list = normalizeOrgList(raw);
    return list.length ? list : null;
  }
  if (typeof raw === "string" && raw.trim()) {
    const list = splitOrgString(raw);
    return list.length ? list : null;
  }
  return null;
}

/**
 * Narrow a fetched org/login list to the configured scope (intersection).
 * Returns { orgs, excluded, applied }:
 *   - orgs: the kept set (unchanged from `fetchedOrgs` when no scope)
 *   - excluded: memberships dropped by the scope
 *   - applied: whether a scope was in effect
 */
function narrowOrgsToScope(fetchedOrgs, scope) {
  const fetched = normalizeOrgList(fetchedOrgs);
  if (!scope || scope.length === 0) {
    return { orgs: fetched, excluded: [], applied: false };
  }
  const kept = fetched.filter((o) => scope.includes(o));
  const excluded = fetched.filter((o) => !scope.includes(o));
  return { orgs: kept, excluded, applied: true };
}

module.exports = {
  normalizeOrgList,
  resolveOrgScope,
  narrowOrgsToScope,
};

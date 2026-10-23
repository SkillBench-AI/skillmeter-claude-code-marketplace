/**
 * Resolve the configured organization filter for repository checks. It can only
 * narrow the organizations the license covers; it never adds access.
 */

const { readSettingsFile, SETTINGS_RELATIVE } = require("./settings");
const path = require("path");
const fs = require("fs");

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
 * Walk up the directory tree to find the project root (the directory containing
 * .codex/settings.local.json). Returns the settings content and the root path,
 * or null if not found.
 */
function findProjectSettings(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const settings = readSettingsFile(current);
    if (settings !== null) {
      return { settings, root: current };
    }
    if (current === root) return null;
    current = path.dirname(current);
  }
}

/**
 * Resolve the configured org filter. Precedence:
 *   1. SKILLMETER_REPO_SCOPE_ORGS env var (comma/space-separated)
 *   2. skillmeter.repoScopeOrgs in <cwd>/.codex/settings.local.json
 *      (array of org names, or a comma-separated string)
 * Returns a normalized array, or null when nothing is configured (no
 * narrowing: every organization the license covers).
 */
function resolveOrgScope({ cwd = process.cwd() } = {}) {
  const fromEnv = process.env.SKILLMETER_REPO_SCOPE_ORGS;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    const list = splitOrgString(fromEnv);
    if (list.length) return list;
  }

  const found = findProjectSettings(cwd);
  if (!found) return null;

  const raw =
    found.settings && found.settings.skillmeter ? found.settings.skillmeter.repoScopeOrgs : undefined;
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

module.exports = {
  normalizeOrgList,
  resolveOrgScope,
};

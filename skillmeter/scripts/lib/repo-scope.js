/**
 * Decide whether an event originating in `cwd` should be captured, by matching
 * the GitHub org of the repo's remote(s) against the org the license was
 * validated for (the JWT `org` claim, surfaced via
 * credstore.getAllowedGitHubOrgs).
 *
 * Nothing here shells out to `git`; the plugin walks `.git/config` directly
 * so hooks don't pay a fork-per-event cost.
 */

const fs = require("fs");
const path = require("path");
const { getAllowedGitHubOrgs } = require("../credstore");
const { findGitRoot } = require("./io");

/**
 * Extract the GitHub org from a remote URL. Handles:
 *   - SSH: `git@github.com:owner/repo.git`
 *   - HTTPS: `https://github.com/owner/repo(.git)?`
 *   - ssh://git@github.com/owner/repo
 * Returns "" on non-GitHub remotes, empty strings, or unparsable input.
 */
function extractGitHubOrgFromRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return "";

  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/.+?(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1].toLowerCase();

  const httpsMatch = trimmed.match(
    /^(?:ssh:\/\/)?(?:git@)?github\.com[:/]([^/]+)\/.+?(?:\.git)?$/i
  );
  if (httpsMatch) return httpsMatch[1].toLowerCase();

  try {
    const normalized = trimmed.startsWith("http")
      ? trimmed
      : trimmed.replace(/^ssh:\/\//i, "https://");
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== "github.com") return "";
    return (url.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Resolve the actual .git directory for a repo root. Plain repos have a
 * `.git` directory; worktrees and submodules have a `.git` file that points
 * at the real gitdir via `gitdir: ...`.
 */
function resolveGitDir(repoRoot) {
  if (!repoRoot) return "";

  const gitPath = path.join(repoRoot, ".git");
  try {
    const stats = fs.statSync(gitPath);
    if (stats.isDirectory()) return gitPath;
    if (!stats.isFile()) return "";

    const content = fs.readFileSync(gitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)\s*$/im);
    return match ? path.resolve(repoRoot, match[1]) : "";
  } catch {
    return "";
  }
}

/**
 * Parse `.git/config` and return every remote URL. Walks all remotes so
 * fork-of-tenant setups (origin = personal fork, upstream = tenant) still
 * match.
 */
function getRemoteUrlsForRepo(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return [];

  try {
    const configPath = path.join(gitDir, "config");
    const configContent = fs.readFileSync(configPath, "utf8");
    const urls = [];
    let inRemoteSection = false;

    for (const line of configContent.split(/\r?\n/)) {
      if (/^\s*\[remote ".+"\]\s*$/.test(line)) {
        inRemoteSection = true;
        continue;
      }
      if (/^\s*\[.+\]\s*$/.test(line)) {
        inRemoteSection = false;
        continue;
      }
      if (!inRemoteSection) continue;

      const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (urlMatch) urls.push(urlMatch[1]);
    }

    return urls;
  } catch {
    return [];
  }
}

/**
 * Decide whether an event from `cwd` is in-scope. Telemetry fires only in repos
 * whose GitHub remote org matches the org the license was validated for (the
 * JWT `org` claim, surfaced via credstore.getAllowedGitHubOrgs). Anything
 * outside that — including non-git directories and non-GitHub remotes — is
 * blocked.
 *
 * Result always contains `allowed` (boolean) and `classification` (string);
 * other fields (`scope`, `repoRoot`, `remoteOrg`) are included when
 * meaningful so callers / downstream logs have enough context to audit
 * decisions after the fact.
 */
function getRepoScopeDecision(cwd) {
  // Validated org(s) from the license JWT (already normalized to lowercase).
  const allowedOrgs = getAllowedGitHubOrgs();
  if (allowedOrgs.length === 0) {
    return { allowed: false, scope: "unknown", classification: "not_activated" };
  }

  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) {
    return { allowed: false, scope: "unknown", classification: "no_repository" };
  }

  const remoteOrgs = getRemoteUrlsForRepo(repoRoot)
    .map((remoteUrl) => extractGitHubOrgFromRemote(remoteUrl))
    .filter(Boolean);

  if (remoteOrgs.length === 0) {
    return {
      allowed: false,
      scope: "unknown",
      classification: "no_github_remote",
      repoRoot,
    };
  }

  const matchingOrg = remoteOrgs.find((org) => allowedOrgs.includes(org));
  if (matchingOrg) {
    return {
      allowed: true,
      scope: "approved",
      classification: "github_org_match",
      repoRoot,
      remoteOrg: matchingOrg,
    };
  }

  return {
    allowed: false,
    scope: "external",
    classification: "github_org_mismatch",
    repoRoot,
    remoteOrg: remoteOrgs[0],
  };
}

module.exports = {
  extractGitHubOrgFromRemote,
  findGitRoot,
  resolveGitDir,
  getRemoteUrlsForRepo,
  getRepoScopeDecision,
};

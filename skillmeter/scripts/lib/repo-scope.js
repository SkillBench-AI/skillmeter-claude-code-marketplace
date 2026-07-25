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

let configCache = null;

function readText(filePath) {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Parse Git's `[url "<base>"] insteadOf = <prefix>` rules. A base may have
 * multiple insteadOf entries; each is retained so applyInsteadOf can use Git's
 * longest-prefix selection rule.
 */
function parseInsteadOf(configText) {
  if (typeof configText !== "string") return [];

  const rules = [];
  let base = "";
  for (const line of configText.split(/\r?\n/)) {
    const section = line.match(/^\s*\[url\s+"(.+)"\]\s*$/i);
    if (section) {
      base = section[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      continue;
    }
    if (/^\s*\[.+\]\s*$/.test(line)) {
      base = "";
      continue;
    }
    if (!base) continue;

    const setting = line.match(/^\s*insteadOf\s*=\s*(.+?)\s*$/i);
    if (setting) rules.push({ prefix: setting[1], base });
  }
  return rules;
}

function applyInsteadOf(remoteUrl, rules) {
  if (typeof remoteUrl !== "string" || !Array.isArray(rules)) return remoteUrl;
  let match = null;
  for (const rule of rules) {
    if (
      rule &&
      typeof rule.prefix === "string" &&
      typeof rule.base === "string" &&
      remoteUrl.startsWith(rule.prefix) &&
      (!match || rule.prefix.length > match.prefix.length)
    ) {
      match = rule;
    }
  }
  return match ? match.base + remoteUrl.slice(match.prefix.length) : remoteUrl;
}

/**
 * Parse literal OpenSSH `Host` blocks into alias -> HostName mappings.
 * Wildcard/negated aliases and Match blocks are deliberately ignored because
 * resolving their conditional semantics without invoking ssh would be unsafe.
 */
function parseSshConfig(configText) {
  if (typeof configText !== "string") return {};

  const aliases = {};
  let hosts = [];
  let inMatch = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;

    const hostMatch = line.match(/^Host\s+(.+)$/i);
    if (hostMatch) {
      inMatch = false;
      hosts = hostMatch[1]
        .split(/\s+/)
        .map((host) => host.toLowerCase())
        .filter((host) => host && !/[*?!]/.test(host));
      continue;
    }
    if (/^Match\s+/i.test(line)) {
      inMatch = true;
      hosts = [];
      continue;
    }
    if (inMatch || hosts.length === 0) continue;

    const hostnameMatch = line.match(/^HostName\s+(\S+)$/i);
    if (!hostnameMatch) continue;
    const hostname = hostnameMatch[1].toLowerCase();
    for (const host of hosts) {
      // OpenSSH uses the first obtained value for a parameter.
      if (!(host in aliases)) aliases[host] = hostname;
    }
  }
  return aliases;
}

function configCacheKey() {
  return [
    process.env.HOME || "",
    process.env.GIT_CONFIG_GLOBAL || "",
    process.env.XDG_CONFIG_HOME || "",
  ].join("\0");
}

function loadConfig() {
  const key = configCacheKey();
  if (configCache?.key === key) return configCache;

  const home = process.env.HOME || "";
  const explicitGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : "");
  const gitConfigPaths = explicitGitConfig
    ? [explicitGitConfig]
    : [
        home ? path.join(home, ".gitconfig") : "",
        xdgConfigHome ? path.join(xdgConfigHome, "git", "config") : "",
      ];

  const insteadOf = gitConfigPaths.flatMap((filePath) =>
    parseInsteadOf(readText(filePath))
  );
  const aliases = parseSshConfig(
    home ? readText(path.join(home, ".ssh", "config")) : ""
  );
  configCache = { key, insteadOf, aliases };
  return configCache;
}

function getInsteadOfRules() {
  return loadConfig().insteadOf;
}

function getSshHostAliases() {
  return loadConfig().aliases;
}

function resetConfigCache() {
  configCache = null;
}

/**
 * Extract the GitHub org from a remote URL. Handles:
 *   - SSH: `git@github.com:owner/repo.git`
 *   - HTTPS: `https://github.com/owner/repo(.git)?`
 *   - ssh://git@github.com/owner/repo
 * Returns "" on non-GitHub remotes, empty strings, or unparsable input.
 */
function extractGitHubOrgFromRemote(remoteUrl, options) {
  const repository = extractGitHubRepositoryFromRemote(remoteUrl, options);
  return repository ? repository.split("/")[0] : "";
}

/**
 * Return canonical `owner/repository` for a GitHub remote.
 */
function extractGitHubRepositoryFromRemote(remoteUrl, options) {
  if (!remoteUrl || typeof remoteUrl !== "string") return "";

  const resolution = options || {
    insteadOf: getInsteadOfRules(),
    aliases: getSshHostAliases(),
  };
  const rewritten = applyInsteadOf(
    remoteUrl.trim(),
    resolution.insteadOf || []
  );
  const aliases = resolution.aliases || {};

  if (!rewritten.includes("://")) {
    const scpMatch = rewritten.match(/^(?:[^@\s]+@)?([^:/\s]+):([^/]+)\/.+$/);
    if (scpMatch) {
      const host = aliases[scpMatch[1].toLowerCase()] || scpMatch[1];
      if (host.toLowerCase() !== "github.com") return "";
      const repo = rewritten.slice(rewritten.indexOf(":") + 1)
        .split(/[?#]/, 1)[0]
        .replace(/^\/+|\/+$/g, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
      return /^[^/]+\/[^/]+$/.test(repo) ? repo : "";
    }
  }

  try {
    const url = new URL(rewritten);
    const originalHost = url.hostname.toLowerCase();
    const host = url.protocol.toLowerCase() === "ssh:"
      ? aliases[originalHost] || originalHost
      : originalHost;
    const parts = url.pathname.split("/").filter(Boolean);
    if (host.toLowerCase() !== "github.com" || parts.length < 2) return "";
    return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`.toLowerCase();
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
function getRemoteEntriesForRepo(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return [];

  try {
    let configRoot = gitDir;
    const commonDirText = readText(path.join(gitDir, "commondir")).trim();
    if (commonDirText) configRoot = path.resolve(gitDir, commonDirText);
    const configPath = path.join(configRoot, "config");
    const configContent = fs.readFileSync(configPath, "utf8");
    const entries = [];
    let remoteName = "";

    for (const line of configContent.split(/\r?\n/)) {
      const section = line.match(/^\s*\[remote "(.+)"\]\s*$/);
      if (section) {
        remoteName = section[1];
        continue;
      }
      if (/^\s*\[.+\]\s*$/.test(line)) {
        remoteName = "";
        continue;
      }
      if (!remoteName) continue;

      const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (urlMatch) entries.push({ name: remoteName, url: urlMatch[1] });
    }

    return entries;
  } catch {
    return [];
  }
}

function getRemoteUrlsForRepo(repoRoot) {
  return getRemoteEntriesForRepo(repoRoot).map((entry) => entry.url);
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

  const remotes = getRemoteEntriesForRepo(repoRoot)
    .map((entry) => ({
      ...entry,
      repository: extractGitHubRepositoryFromRemote(entry.url),
    }))
    .filter((entry) => entry.repository);
  const remoteOrgs = remotes.map((entry) => entry.repository.split("/")[0]);

  if (remoteOrgs.length === 0) {
    return {
      allowed: false,
      scope: "unknown",
      classification: "no_github_remote",
      repoRoot,
    };
  }

  const matching = remotes.filter((entry) =>
    allowedOrgs.includes(entry.repository.split("/")[0])
  );
  const originMatches = matching.filter((entry) => entry.name === "origin");
  const candidates = new Set(
    (originMatches.length > 0 ? originMatches : matching)
      .map((entry) => entry.repository)
  );
  if (candidates.size > 1) {
    return {
      allowed: false,
      scope: "unknown",
      classification: "ambiguous_github_repository",
      repoRoot,
    };
  }
  if (candidates.size === 1) {
    const repository = [...candidates][0];
    const matchingOrg = repository.split("/")[0];
    return {
      allowed: true,
      scope: "approved",
      classification: "github_org_match",
      repoRoot,
      remoteOrg: matchingOrg,
      repoKey: `github.com/${repository}`,
      repoName: repository.split("/")[1],
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
  parseInsteadOf,
  applyInsteadOf,
  parseSshConfig,
  getInsteadOfRules,
  getSshHostAliases,
  extractGitHubOrgFromRemote,
  extractGitHubRepositoryFromRemote,
  getRemoteEntriesForRepo,
  getRemoteUrlsForRepo,
  getRepoScopeDecision,
  _resetConfigCache: resetConfigCache,
};

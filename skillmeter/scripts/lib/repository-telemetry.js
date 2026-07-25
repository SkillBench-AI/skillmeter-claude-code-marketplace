/**
 * Repository telemetry inventory for `/skillmeter:telemetry list`.
 *
 * Discovery streams historical transcript JSONL and retains only top-level
 * cwd values long enough to resolve existing git roots. Public results contain
 * a sanitized display name and HMAC id, never the local repository path.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const credstore = require("../credstore");
const { findGitRoot } = require("./io");
const {
  extractGitHubOrgFromRemote,
  getRemoteUrlsForRepo,
  getRepoScopeDecision,
} = require("./repo-scope");
const { hashHmac } = require("./sanitize");
const { getTelemetryOptIn, saveTelemetryOptIn } = require("./settings");
const { resolveTelemetryGate } = require("./telemetry-policy");

const SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function getClaudeProjectsDir({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude");
  return path.join(configDir, "projects");
}

function safeDirectoryEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function canonicalRepositoryRoot(repoRoot) {
  try {
    return fs.realpathSync.native(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

function safeDisplayComponent(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "repository";
}

function repositoryNameFromRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return "";

  let pathname = "";
  const trimmed = remoteUrl.trim().split(/[?#]/, 1)[0];
  try {
    pathname = trimmed.includes("://")
      ? new URL(trimmed).pathname
      : trimmed.slice(trimmed.indexOf(":") + 1);
  } catch {
    return "";
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const name = parts.at(-1).replace(/\.git$/i, "");
  try {
    return safeDisplayComponent(decodeURIComponent(name));
  } catch {
    return safeDisplayComponent(name);
  }
}

function repositoryDisplayName(repoRoot, org) {
  let remoteName = "";
  try {
    const matchingRemote = getRemoteUrlsForRepo(repoRoot).find(
      (remoteUrl) => extractGitHubOrgFromRemote(remoteUrl) === org
    );
    remoteName = repositoryNameFromRemote(matchingRemote);
  } catch {}

  return (
    `@${safeDisplayComponent(org)}/` +
    (remoteName || safeDisplayComponent(path.basename(repoRoot)))
  );
}

async function collectTranscriptCwds(transcriptPath) {
  const cwds = new Set();
  let input;
  let lines;

  try {
    input = fs.createReadStream(transcriptPath, { encoding: "utf8" });
    lines = readline.createInterface({
      input,
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record.cwd === "string" && record.cwd) {
          cwds.add(record.cwd);
        }
      } catch {
        // A partial or malformed record does not make repository discovery fail.
      }
    }
  } catch {
    return [];
  } finally {
    if (lines) lines.close();
    if (input) input.destroy();
  }

  return [...cwds];
}

async function discoverRepositoryRoots({
  projectsDir = getClaudeProjectsDir(),
  currentCwd = process.cwd(),
  findRepoRoot = findGitRoot,
  collectCwds = collectTranscriptCwds,
} = {}) {
  const roots = new Set();
  const cwdCache = new Map();

  function addCwd(cwd) {
    if (!cwd || typeof cwd !== "string") return;
    let repoRoot = cwdCache.get(cwd);
    if (repoRoot === undefined) {
      try {
        repoRoot = findRepoRoot(cwd) || "";
      } catch {
        repoRoot = "";
      }
      cwdCache.set(cwd, repoRoot);
    }
    if (repoRoot) roots.add(canonicalRepositoryRoot(repoRoot));
  }

  addCwd(currentCwd);

  for (const projectEntry of safeDirectoryEntries(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);

    for (const sessionEntry of safeDirectoryEntries(projectDir)) {
      if (!sessionEntry.isFile() || !SESSION_FILE_RE.test(sessionEntry.name)) {
        continue;
      }

      const transcriptPath = path.join(projectDir, sessionEntry.name);
      const cwds = await collectCwds(transcriptPath);
      for (const cwd of cwds) addCwd(cwd);
    }
  }

  return [...roots].sort();
}

function repositoryId(repoRoot, hashSalt) {
  return hashHmac(canonicalRepositoryRoot(repoRoot), hashSalt);
}

function projectSettingLabel(value) {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "inherit";
}

function toggleDescription({ gate, projectSetting, org }) {
  if (gate.capture) {
    const source = projectSetting === true
      ? "Enabled by repository override."
      : `Enabled by @${org}.`;
    return `${source} Select to turn off.`;
  }

  if (gate.mode === "project_disabled") {
    return "Disabled by repository override. Select to turn on.";
  }
  if (gate.mode === "global_disabled") {
    return "Disabled by the global telemetry kill-switch.";
  }
  if (gate.mode === "org_disabled") {
    return `Disabled for @${org}.`;
  }
  if (gate.mode === "org_consent_required") {
    return `Telemetry choice required for @${org}.`;
  }
  if (gate.mode === "not_signed_in") {
    return "Disabled because SkillMeter is not signed in.";
  }
  return `Disabled (${gate.mode}).`;
}

function buildRepositoryTelemetryState(roots, {
  getScopeDecision = getRepoScopeDecision,
  getProjectSetting = getTelemetryOptIn,
  getOrgConsent = credstore.getOrgTelemetryConsent,
  getGlobalDisabled = credstore.getTelemetryDisabled,
  hasValidLicense = credstore.hasValidLicense,
  getHashSalt = credstore.getOrCreateHashSalt,
} = {}) {
  const globalDisabled = getGlobalDisabled();
  const signedIn = hasValidLicense();
  let hashSalt = "";
  const repositories = [];

  for (const repoRoot of roots) {
    let scope;
    try {
      scope = getScopeDecision(repoRoot);
    } catch {
      continue;
    }
    if (!scope || !scope.allowed || !scope.remoteOrg) continue;

    const projectSetting = getProjectSetting(repoRoot);
    const orgConsent = getOrgConsent(scope.remoteOrg);
    const gate = resolveTelemetryGate({
      globalDisabled,
      hasValidLicense: signedIn,
      repoOrgOwned: true,
      orgConsent,
      projectOptIn: projectSetting,
    });
    const action = gate.capture
      ? "disable"
      : gate.mode === "project_disabled"
        ? "enable"
        : null;
    if (!hashSalt) hashSalt = getHashSalt();
    const id = repositoryId(repoRoot, hashSalt);
    const displayName = repositoryDisplayName(repoRoot, scope.remoteOrg);

    repositories.push({
      id,
      repoRoot,
      org: scope.remoteOrg,
      displayName,
      effective: gate.capture ? "enabled" : "disabled",
      mode: gate.mode,
      projectSetting: projectSettingLabel(projectSetting),
      action,
      description: toggleDescription({
        gate,
        projectSetting,
        org: scope.remoteOrg,
      }),
    });
  }

  const displayCounts = new Map();
  for (const repo of repositories) {
    displayCounts.set(
      repo.displayName,
      (displayCounts.get(repo.displayName) || 0) + 1
    );
  }

  for (const repo of repositories) {
    const suffix = displayCounts.get(repo.displayName) > 1
      ? ` · ${repo.id.slice(0, 6)}`
      : "";
    repo.optionLabel =
      `${repo.effective === "enabled" ? "ON" : "OFF"} · ${repo.displayName}${suffix}`;
  }

  repositories.sort((a, b) =>
    a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
  );

  return {
    globalDisabled,
    signedIn,
    repositories,
    summary: {
      enabled: repositories.filter((repo) => repo.effective === "enabled").length,
      disabled: repositories.filter((repo) => repo.effective === "disabled").length,
      actionable: repositories.filter((repo) => repo.action !== null).length,
    },
  };
}

function publicRepositoryState(state) {
  return {
    globalDisabled: state.globalDisabled,
    signedIn: state.signedIn,
    repositories: state.repositories.map((repo) => ({
      id: repo.id,
      org: repo.org,
      displayName: repo.displayName,
      optionLabel: repo.optionLabel,
      effective: repo.effective,
      mode: repo.mode,
      projectSetting: repo.projectSetting,
      action: repo.action,
      description: repo.description,
    })),
    summary: state.summary,
  };
}

function applyRepositoryToggles(ids, state, {
  saveProjectSetting = saveTelemetryOptIn,
} = {}) {
  const repositoriesById = new Map(
    state.repositories.map((repo) => [repo.id, repo])
  );
  const results = [];

  for (const id of [...new Set(ids)]) {
    const repo = repositoriesById.get(id);
    if (!repo) {
      results.push({ id, changed: false, reason: "unknown_repository" });
      continue;
    }
    if (!repo.action) {
      results.push({
        id,
        displayName: repo.displayName,
        changed: false,
        reason: repo.mode,
      });
      continue;
    }

    const enabled = repo.action === "enable";
    try {
      saveProjectSetting(repo.repoRoot, enabled);
      results.push({
        id,
        displayName: repo.displayName,
        changed: true,
        effective: enabled ? "enabled" : "disabled",
      });
    } catch {
      results.push({
        id,
        displayName: repo.displayName,
        changed: false,
        reason: "write_failed",
      });
    }
  }

  return {
    changed: results.filter((result) => result.changed).length,
    results,
  };
}

async function loadRepositoryTelemetryState(options = {}) {
  const roots = await discoverRepositoryRoots(options);
  return buildRepositoryTelemetryState(roots, options);
}

module.exports = {
  SESSION_FILE_RE,
  getClaudeProjectsDir,
  canonicalRepositoryRoot,
  safeDisplayComponent,
  repositoryNameFromRemote,
  repositoryDisplayName,
  collectTranscriptCwds,
  discoverRepositoryRoots,
  repositoryId,
  buildRepositoryTelemetryState,
  publicRepositoryState,
  applyRepositoryToggles,
  loadRepositoryTelemetryState,
};

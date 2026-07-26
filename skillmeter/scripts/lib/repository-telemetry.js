/**
 * Repository telemetry inventory for `/skillmeter:telemetry list`.
 *
 * Discovery streams historical transcript JSONL and retains structured local
 * paths long enough to resolve existing git roots. Public results contain
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
const telemetryStore = require("./telemetry-store");
const { resolveTelemetryGate } = require("./telemetry-policy");
const { purgeRepositoryQueue } = require("./repository-queue");

const SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function getClaudeProjectsDir({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude");
  return path.join(configDir, "projects");
}

function getClaudeStateFile({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  return path.join(env.HOME || homeDir, ".claude.json");
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
        const addStructuredPaths = (value) => {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) {
            for (const item of value) addStructuredPaths(item);
            return;
          }
          for (const [key, child] of Object.entries(value)) {
            if (
              ["file_path", "notebook_path", "filePath", "trackingPath"].includes(key) &&
              typeof child === "string" &&
              child
            ) {
              cwds.add(child);
            } else {
              addStructuredPaths(child);
            }
          }
        };
        addStructuredPaths(record);
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

function collectClaudeStateCwds(stateFile) {
  // Claude Code keeps exact project paths in its machine-local state. This is
  // an optional discovery hint, not a trust boundary: every candidate must
  // still resolve to an existing git root and pass the licensed-remote check.
  // Malformed, relative, or stale entries are ignored.
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return [];
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];

  const cwds = new Set();
  if (
    state.projects &&
    typeof state.projects === "object" &&
    !Array.isArray(state.projects)
  ) {
    for (const projectPath of Object.keys(state.projects)) {
      if (path.isAbsolute(projectPath)) cwds.add(projectPath);
    }
  }
  if (
    state.githubRepoPaths &&
    typeof state.githubRepoPaths === "object" &&
    !Array.isArray(state.githubRepoPaths)
  ) {
    for (const repoPaths of Object.values(state.githubRepoPaths)) {
      if (!Array.isArray(repoPaths)) continue;
      for (const repoPath of repoPaths) {
        if (typeof repoPath === "string" && path.isAbsolute(repoPath)) {
          cwds.add(repoPath);
        }
      }
    }
  }
  return [...cwds];
}

async function discoverRepositoryRoots({
  projectsDir = getClaudeProjectsDir(),
  claudeStateFile = getClaudeStateFile(),
  currentCwd = process.cwd(),
  findRepoRoot = findGitRoot,
  collectCwds = collectTranscriptCwds,
  collectStateCwds = collectClaudeStateCwds,
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
  for (const cwd of collectStateCwds(claudeStateFile)) addCwd(cwd);

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

function repositoryId(repoKey, hashSalt) {
  return hashHmac(repoKey, hashSalt);
}

function projectSettingLabel(value) {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "not_selected";
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
  if (gate.mode === "repository_consent_required") {
    return "Off until this repository is explicitly selected. Select to turn on.";
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
  getProjectSetting = (repoKey, repoRoot) =>
    telemetryStore.getRepositoryOverride(repoKey, repoRoot),
  getOrgConsent = credstore.getOrgTelemetryConsent,
  getGlobalDisabled = credstore.getTelemetryDisabled,
  hasValidLicense = credstore.hasValidLicense,
  getHashSalt = credstore.getOrCreateHashSalt,
  getConfiguredRepositories = () =>
    telemetryStore.readPolicy().repositories,
  getAllowedOrgs = credstore.getAllowedGitHubOrgs,
} = {}) {
  const globalDisabled = getGlobalDisabled();
  const signedIn = hasValidLicense();
  let hashSalt = "";
  const repositories = [];
  const discovered = new Map();

  for (const repoRoot of roots) {
    let scope;
    try {
      scope = getScopeDecision(repoRoot);
    } catch {
      continue;
    }
    if (!scope || !scope.allowed || !scope.remoteOrg) continue;

    // Import every checkout before rendering. A later clone/worktree may carry
    // a legacy OFF value, which must win over an earlier legacy ON.
    getProjectSetting(scope.repoKey, repoRoot);
    if (!discovered.has(scope.repoKey)) {
      discovered.set(scope.repoKey, { repoRoot, scope });
    }
  }

  // The policy SSOT may retain an explicit setting after a checkout or Claude
  // project entry disappears. Keep those configured repositories visible so
  // `/telemetry list` never hides an ON/OFF decision merely because discovery
  // can no longer resolve a local path.
  let configuredRepositories = {};
  try {
    configuredRepositories = getConfiguredRepositories() || {};
  } catch {}
  let allowedOrgs = new Set();
  try {
    allowedOrgs = new Set(getAllowedOrgs());
  } catch {}
  for (const [rawRepoKey, record] of Object.entries(configuredRepositories)) {
    if (typeof record?.enabled !== "boolean") continue;
    const repoKey = telemetryStore.normalizeRepoKey(rawRepoKey);
    const [, org, repoName] = repoKey.split("/");
    if (!repoKey || !allowedOrgs.has(org) || discovered.has(repoKey)) continue;
    discovered.set(repoKey, {
      repoRoot: "",
      scope: {
        allowed: true,
        remoteOrg: org,
        repoKey,
        repoName,
      },
    });
  }

  for (const { repoRoot, scope } of discovered.values()) {
    const projectSetting = getProjectSetting(scope.repoKey, "");
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
      : ["project_disabled", "repository_consent_required"].includes(gate.mode)
        ? "enable"
        : null;
    if (!hashSalt) hashSalt = getHashSalt();
    const id = repositoryId(scope.repoKey, hashSalt);
    const displayName = repoRoot
      ? repositoryDisplayName(repoRoot, scope.remoteOrg)
      : `@${safeDisplayComponent(scope.remoteOrg)}/` +
        safeDisplayComponent(scope.repoName);

    repositories.push({
      id,
      repoRoot,
      repoKey: scope.repoKey,
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
    revision: telemetryStore.getPolicyRevision(),
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
    revision: state.revision,
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
  saveProjectSetting = (repoKey, enabled, revision) =>
    telemetryStore.setRepositoryOverride(repoKey, enabled, revision),
  purgeProjectQueue = purgeRepositoryQueue,
} = {}) {
  const repositoriesById = new Map(
    state.repositories.map((repo) => [repo.id, repo])
  );
  const results = [];

  let revision = state.revision;
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
      saveProjectSetting(repo.repoKey, enabled, revision);
      revision++;
      if (!enabled) purgeProjectQueue(repo.repoKey);
      results.push({
        id,
        displayName: repo.displayName,
        changed: true,
        effective: enabled ? "enabled" : "disabled",
      });
    } catch (err) {
      results.push({
        id,
        displayName: repo.displayName,
        changed: false,
        reason: err?.code === "STALE_POLICY" ? "stale_policy" : "write_failed",
      });
    }
  }

  return {
    revision,
    changed: results.filter((result) => result.changed).length,
    results,
  };
}

function applyOnboardingSelection(org, ids, enabled, state, {
  saveOnboardingSelection = (organization, repoKeys, value, revision) =>
    telemetryStore.authorizeOrganizationRepositories(
      organization,
      repoKeys,
      value,
      revision
    ),
  purgeProjectQueue = purgeRepositoryQueue,
} = {}) {
  const repositoriesById = new Map(
    state.repositories.map((repo) => [repo.id, repo])
  );
  const selected = [];
  for (const id of [...new Set(ids)]) {
    const repo = repositoriesById.get(id);
    if (!repo || repo.org !== org) {
      return {
        revision: state.revision,
        changed: 0,
        results: [{ id, changed: false, reason: "unknown_repository" }],
      };
    }
    selected.push(repo);
  }

  try {
    saveOnboardingSelection(
      org,
      selected.map((repo) => repo.repoKey),
      enabled,
      state.revision
    );
    if (!enabled) {
      for (const repo of selected) purgeProjectQueue(repo.repoKey);
    }
    return {
      revision: state.revision + 1,
      changed: selected.length,
      organizationAuthorized: true,
      results: selected.map((repo) => ({
        id: repo.id,
        displayName: repo.displayName,
        changed: true,
        effective: enabled ? "enabled" : "disabled",
      })),
    };
  } catch (err) {
    const stale = err?.code === "STALE_POLICY";
    return {
      revision: state.revision,
      changed: 0,
      stale,
      results: selected.map((repo) => ({
        id: repo.id,
        displayName: repo.displayName,
        changed: false,
        reason: stale ? "stale_policy" : "write_failed",
      })),
    };
  }
}

async function loadRepositoryTelemetryState(options = {}) {
  const roots = await discoverRepositoryRoots(options);
  return buildRepositoryTelemetryState(roots, options);
}

module.exports = {
  SESSION_FILE_RE,
  getClaudeProjectsDir,
  getClaudeStateFile,
  canonicalRepositoryRoot,
  safeDisplayComponent,
  repositoryNameFromRemote,
  repositoryDisplayName,
  collectTranscriptCwds,
  collectClaudeStateCwds,
  discoverRepositoryRoots,
  repositoryId,
  buildRepositoryTelemetryState,
  publicRepositoryState,
  applyRepositoryToggles,
  applyOnboardingSelection,
  loadRepositoryTelemetryState,
};

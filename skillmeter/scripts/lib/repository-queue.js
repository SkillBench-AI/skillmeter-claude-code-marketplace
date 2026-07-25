/**
 * Repository queue identity, inventory, and policy-driven payload cleanup.
 * Cursors intentionally survive OFF so disabled-period transcripts cannot be
 * uploaded after telemetry is re-enabled.
 */

const fs = require("fs");
const path = require("path");

const credstore = require("../credstore");
const { atomicWriteJson, safeReadJson } = require("./io");
const {
  REPOSITORIES_LOG_DIR,
  repositoryQueuePaths,
} = require("./paths");
const telemetryStore = require("./telemetry-store");

function queueContextForRepository(repoKey, org = "") {
  repoKey = telemetryStore.normalizeRepoKey(repoKey);
  if (!repoKey) return null;
  org = telemetryStore.normalizeOrg(org) || repoKey.split("/")[1];
  const paths = repositoryQueuePaths(
    repoKey,
    credstore.getOrCreateHashSalt()
  );
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    const existing = safeReadJson(paths.metadata, null);
    if (existing && existing.repoKey !== repoKey) return null;
    if (!existing) {
      atomicWriteJson(paths.metadata, {
        repoKey,
        org,
        policyRevision: telemetryStore.getPolicyRevision(),
        createdAt: Date.now(),
      });
    }
  } catch {
    return null;
  }
  return { repoKey, org, ...paths };
}

function listRepositoryQueueContexts() {
  if (!fs.existsSync(REPOSITORIES_LOG_DIR)) return [];
  try {
    return fs.readdirSync(REPOSITORIES_LOG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const root = path.join(REPOSITORIES_LOG_DIR, entry.name);
        const meta = safeReadJson(path.join(root, "repository.json"), null);
        const repoKey = telemetryStore.normalizeRepoKey(meta?.repoKey);
        if (!repoKey) return null;
        return {
          repoKey,
          org: telemetryStore.normalizeOrg(meta.org) || repoKey.split("/")[1],
          root,
          metadata: path.join(root, "repository.json"),
          eventLog: path.join(root, "events.jsonl"),
          chunks: path.join(root, "transcripts", "chunks"),
          cursors: path.join(root, "transcripts", "cursors"),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function queueContextForPath(filePath) {
  return listRepositoryQueueContexts().find((context) =>
    path.resolve(filePath).startsWith(
      `${path.resolve(context.root)}${path.sep}`
    )
  ) || null;
}

function queueDisposition(context) {
  const policy = telemetryStore.readPolicy();
  if (policy.global.enabled === false) return "pause";
  if (policy.organizations[context.org]?.enabled === false) return "delete";
  if (policy.repositories[context.repoKey]?.enabled === false) return "delete";
  return "send";
}

function clearRepositoryPayloads(context) {
  let removed = false;
  try {
    for (const entry of fs.readdirSync(context.root)) {
      if (
        entry === "events.jsonl" ||
        /^events\.jsonl\.\d+(?:\.sent)?$/.test(entry)
      ) {
        fs.rmSync(path.join(context.root, entry), { force: true });
        removed = true;
      }
    }
  } catch {}
  try {
    if (fs.existsSync(context.chunks)) {
      fs.rmSync(context.chunks, { recursive: true, force: true });
      removed = true;
    }
  } catch {}
  return removed;
}

function purgeRepositoryQueue(repoKey) {
  const normalized = telemetryStore.normalizeRepoKey(repoKey);
  if (!normalized) return false;
  let removed = false;
  try {
    const paths = repositoryQueuePaths(
      normalized,
      credstore.getOrCreateHashSalt()
    );
    if (fs.existsSync(paths.root)) {
      removed = clearRepositoryPayloads({
        root: paths.root,
        chunks: paths.chunks,
      });
    }
  } catch {}
  for (const context of listRepositoryQueueContexts()) {
    if (context.repoKey !== normalized) continue;
    removed = clearRepositoryPayloads(context) || removed;
  }
  return removed;
}

function purgeOrganizationQueues(org) {
  const normalized = telemetryStore.normalizeOrg(org);
  let removed = 0;
  for (const context of listRepositoryQueueContexts()) {
    if (context.org !== normalized) continue;
    if (clearRepositoryPayloads(context)) removed++;
  }
  return removed;
}

function purgeDisallowedQueues() {
  let removed = 0;
  for (const context of listRepositoryQueueContexts()) {
    if (queueDisposition(context) !== "delete") continue;
    if (clearRepositoryPayloads(context)) removed++;
  }
  return removed;
}

module.exports = {
  queueContextForRepository,
  listRepositoryQueueContexts,
  queueContextForPath,
  queueDisposition,
  purgeRepositoryQueue,
  purgeOrganizationQueues,
  purgeDisallowedQueues,
};

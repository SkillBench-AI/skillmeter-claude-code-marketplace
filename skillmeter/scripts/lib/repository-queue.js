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
const { isBackfillUploadAuthorized } = require("./backfill-state");
const telemetryStore = require("./telemetry-store");

function queueContextForRepository(repoKey, org = "") {
  repoKey = telemetryStore.normalizeRepoKey(repoKey);
  if (!repoKey) return null;
  org = telemetryStore.normalizeOrg(org) || repoKey.split("/")[1];
  const paths = repositoryQueuePaths(
    repoKey,
    credstore.getOrCreateHashSalt()
  );
  let existing;
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    existing = safeReadJson(paths.metadata, null);
    if (existing && existing.repoKey !== repoKey) return null;
    if (!existing) {
      atomicWriteJson(paths.metadata, {
        repoKey,
        org,
        policyRevision: telemetryStore.getPolicyRevision(),
        revocationsSeen: currentRevocations({ repoKey, org }),
        createdAt: Date.now(),
      });
    }
  } catch {
    return null;
  }
  const context = { repoKey, org, ...paths };
  // Capture-time check: rows queued before an unobserved OFF are purged before
  // new rows join them, so later capture is not lost with them.
  if (existing) reconcileRevocations(context);
  return context;
}

// ADR 004 decision 6. The counters this queue last observed, stored in its
// repository.json. Rows queued before either writer recorded a counter carry
// none and read as 0.
function currentRevocations(context) {
  const state = telemetryStore.readPolicyState();
  if (state.status === "blocked") return null;
  const policy = state.policy;
  return {
    org: telemetryStore.revocationCount(policy.organizations[context.org]),
    repo: telemetryStore.revocationCount(policy.repositories[context.repoKey]),
  };
}

function seenRevocations(context) {
  const seen = safeReadJson(context.metadata, null)?.revocationsSeen;
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { org: count(seen?.org), repo: count(seen?.repo) };
}

// "higher": an OFF happened that this queue did not observe; "lower": the
// policy was restored from an older copy; "equal" otherwise.
function revocationComparison(context) {
  const current = currentRevocations(context);
  if (!current) return "equal";
  const seen = seenRevocations(context);
  if (current.org > seen.org || current.repo > seen.repo) return "higher";
  if (current.org < seen.org || current.repo < seen.repo) return "lower";
  return "equal";
}

function recordRevocationsSeen(context) {
  const current = currentRevocations(context);
  if (!current) return;
  try {
    const meta = safeReadJson(context.metadata, null);
    if (!meta) return;
    atomicWriteJson(context.metadata, { ...meta, revocationsSeen: current });
  } catch {}
}

// Purge rows captured before an unobserved OFF, as an observed OFF would, then
// record the new counters so later capture delivers.
function reconcileRevocations(context) {
  if (revocationComparison(context) !== "higher") return false;
  clearRepositoryPayloads(context);
  recordRevocationsSeen(context);
  return true;
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

// ADR 004, decision 6: an explicit organization or repository OFF purges even
// while the global pause holds everything else; an unset choice holds.
function queueDisposition(context) {
  const state = telemetryStore.readPolicyState();
  if (state.status === "blocked") return "pause";
  const policy = state.policy;
  const org = policy.organizations[context.org];
  const repo = policy.repositories[context.repoKey];
  if (org?.enabled === false || repo?.enabled === false) return "delete";
  const revocations = context.metadata ? revocationComparison(context) : "equal";
  // An OFF/ON cycle this queue never observed revokes what it queued before.
  if (revocations === "higher") return "delete";
  if (policy.global.enabled === false) return "pause";
  if (org?.enabled !== true || repo?.enabled !== true) return "pause";
  // A lower counter means an older policy copy was restored: hold until it
  // catches up; retention still bounds the hold.
  if (revocations === "lower") return "pause";
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
      const preserved = new Set();
      for (const entry of fs.readdirSync(context.chunks)) {
        if (!entry.endsWith(".meta.json")) continue;
        const metaPath = path.join(context.chunks, entry);
        const bodyEntry = entry.replace(/\.meta\.json$/, ".jsonl");
        const meta = safeReadJson(metaPath, null);
        if (
          fs.existsSync(path.join(context.chunks, bodyEntry)) &&
          meta?.promptId === "backfill" &&
          isBackfillUploadAuthorized({
            offerId: meta.backfillOfferId,
            org: context.org,
            repoKey: context.repoKey,
          })
        ) {
          preserved.add(entry);
          preserved.add(bodyEntry);
        }
      }
      for (const entry of fs.readdirSync(context.chunks)) {
        if (preserved.has(entry)) continue;
        fs.rmSync(path.join(context.chunks, entry), {
          recursive: true,
          force: true,
        });
        removed = true;
      }
    }
  } catch {}
  return removed;
}

function purgeRepositoryQueue(repoKey) {
  const result = purgeRepositoryQueuePayloads(repoKey);
  for (const context of listRepositoryQueueContexts()) {
    if (context.repoKey === telemetryStore.normalizeRepoKey(repoKey)) {
      recordRevocationsSeen(context);
    }
  }
  return result;
}

function purgeRepositoryQueuePayloads(repoKey) {
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
        repoKey: normalized,
        org: normalized.split("/")[1],
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

// Sign-out: nothing recorded under the sign-in stays queued for upload.
// Accepted historical-import chunks are kept, as everywhere else here; their
// consent is separate from repository telemetry.
function purgeAllRepositoryQueues() {
  let removed = 0;
  for (const context of listRepositoryQueueContexts()) {
    if (clearRepositoryPayloads(context)) removed++;
  }
  return removed;
}

function purgeDisallowedQueues() {
  let removed = 0;
  for (const context of listRepositoryQueueContexts()) {
    if (queueDisposition(context) !== "delete") continue;
    if (clearRepositoryPayloads(context)) removed++;
    recordRevocationsSeen(context);
  }
  return removed;
}

module.exports = {
  queueContextForRepository,
  listRepositoryQueueContexts,
  queueContextForPath,
  queueDisposition,
  reconcileRevocations,
  purgeRepositoryQueue,
  purgeOrganizationQueues,
  purgeAllRepositoryQueues,
  purgeDisallowedQueues,
};

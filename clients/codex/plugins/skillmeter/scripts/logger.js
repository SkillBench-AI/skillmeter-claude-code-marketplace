#!/usr/bin/env node
/**
 * Shared hook logging, transcript staging and durable uploads.
 * Hooks append sanitized NDJSON; detached workers gzip and send queued data.
 */

const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { sanitizeEventData, redactDeep } = require("./sanitizer");
const credstore = require("./credstore");
const transcriptQueue = require("./lib/transcript-delta");
const { createRepositoryQueue } = require("./lib/repository-queue");
const { createConsentReader } = require("./lib/consent-reader");
const { readTelemetryChoice, SETTINGS_RELATIVE } = require("./lib/settings");
const {
  getEndpointFromToken,
  getEndpointFromTokenAllowExpired,
  isJwtExpired,
  decodeJwtPayload,
} = require("./lib/jwt");
const licenseActivation = require("./lib/license-activation");
const { resolveOrgScope } = require("./lib/org-scope");
const { consentPolicyFile } = require("./lib/consent-policy");
const canonicalScope = require("./lib/repo-scope");

// Codex sets PLUGIN_ROOT and PLUGIN_DATA for plugin hooks. The CLAUDE_PLUGIN_*
// copies it also exports are ignored: a shell inside Claude Code inherits
// Claude's values, and Codex state must never land in Claude's directories.
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || path.resolve(__dirname, "..");

// PLUGIN_DATA is a writable per-plugin directory Codex provides to hooks.
// Without it the host layout decides; queues are never kept in the installation.
const { resolvePluginDataRoot } = require("./lib/plugin-data-root");
const PLUGIN_DATA = resolvePluginDataRoot(PLUGIN_ROOT);

const LOG_DIR = path.join(PLUGIN_DATA, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");
// Named for Codex's own record: the marker left by the former shared record
// must not make this record look deleted.
const CONSENT_OBSERVED_FILE = path.join(LOG_DIR, "consent-policy-observed");
const { readGlobalConsent, readRepositoryConsent } =
  createConsentReader(CONSENT_OBSERVED_FILE);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");

// Staged transcripts awaiting upload live here. Sanitized snapshots are written
// before any network call so a failed upload can be retried from disk by the
// detached drain / retry monitor instead of being lost when the hook exits.
const TRANSCRIPTS_PENDING_DIR = path.join(LOG_DIR, "transcripts", "pending");

const TRANSCRIPT_CHUNKS_DIR = path.join(LOG_DIR, "transcripts", "chunks-v1");
const TRANSCRIPT_CAPTURES_DIR = path.join(LOG_DIR, "transcripts", "captures-v1");

const repositoryQueue = createRepositoryQueue(LOG_DIR, getOrCreateHashSalt, cwd => {
  credstore.refreshFromDisk();
  return resolveTelemetryGate(getTelemetryOptIn(cwd), getRepoScopeDecision(cwd).allowed).capture;
}, (cwd, knownKey) => {
  const scope = getRepoScopeDecision(cwd);
  // Queued records retain their original repository identity even when the
  // checkout disappears or changes remotes. This never authorizes capture.
  if (knownKey) {
    return readRepositoryConsent({ allowed: true, repoKey: knownKey, remoteOrg: knownKey.split("/")[1] });
  }
  return readRepositoryConsent(scope);
});

const AGENT_NAME = "codex";

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
        "utf8"
      )
    );
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
})();

function getDeviceId() { return credstore.getDeviceId(); }
function getOrCreateHashSalt() { return credstore.getOrCreateHashSalt(); }
function getLicenseToken() { return credstore.getLicenseToken(); }
// The upload path's name for the same read: the session is read from disk on
// every call, so a long-lived drain sees another process renew or sign out.
function getLicenseTokenUncached() { return credstore.getLicenseToken(); }

// The global pause lives in Codex's consent record and pauses only Codex.
function getTelemetryGloballyDisabled() {
  return readGlobalConsent().disabled;
}

function setTelemetryGloballyDisabled(disabled) {
  // Record even an off/on cycle with no intervening hook in this plugin.
  fs.mkdirSync(TRANSCRIPT_CAPTURES_DIR, { recursive: true, mode: 0o700 });
  transcriptQueue.writeDurable(path.join(TRANSCRIPT_CAPTURES_DIR, "global-boundary.json"), JSON.stringify(crypto.randomUUID()));
  const { createConsentStore } = require("./lib/consent-store");
  const store = createConsentStore({ file: consentPolicyFile(), observedFile: CONSENT_OBSERVED_FILE });
  const current = store.readPolicy();
  const result = store.setGlobalEnabled(!disabled, { expectedRevision: current?.revision ?? null });
  observeKnownTranscriptConsent();
  return result;
}

// The one renewal path (ADR 005): the drains and the retry sweep call this
// before sending. A rejection by the collector forces a renewal of a license
// that still looks fresh locally. Failures leave queued data for later.
async function tryRefreshLicense(deviceId) {
  const before = credstore.getLicenseToken();
  const token = await licenseActivation.ensureFreshLicense(deviceId, {
    force: isLicenseRejected(),
    onRevoked: () => purgeEventLogs(),
  });
  if (token && token !== before) clearLicenseRejected();
  return token;
}

// Event batches are not bound to the license they were recorded under, so a
// session that ends for good (sign-out, or a workspace that no longer licenses
// the user) deletes them rather than sending them under the next sign-in.
// Transcripts need no purge: their queue owner includes the license's tenant
// and user, and delivery refuses a mismatch. Batches locked by an upload in
// flight are left; returns false when any were.
function eventQueueNames() {
  try { return fs.readdirSync(LOG_DIR); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function purgeEventLogs() {
  let complete = true;
  const names = eventQueueNames();
  for (const name of names) {
    if (!/^events\.jsonl(?:\.\d+)?(?:\.sent)?$/.test(name)) continue;
    const file = path.join(LOG_DIR, name);
    const batch = file.replace(/\.sent$/, "");
    const release = transcriptQueue.acquireLock(`${batch}.lock`);
    if (!release) { complete = false; continue; }
    try {
      fs.rmSync(file, { force: true });
      clearBatchMeta(batch);
    } catch { complete = false; }
    finally { release(); }
  }
  return complete;
}

// Sent artifacts cannot be replayed. Pending files, including empty active
// files, conservatively require review for an already-created broker session.
function eventQueueEmpty() {
  return !eventQueueNames().some(name => /^events\.jsonl(?:\.\d+)?$/.test(name));
}

function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

function findGitRoot(startPath) {
  if (!startPath || typeof startPath !== "string") return "";

  let currentPath = path.resolve(startPath);
  try {
    if (!fs.statSync(currentPath).isDirectory()) {
      currentPath = path.dirname(currentPath);
    }
  } catch {
    currentPath = path.dirname(currentPath);
  }

  while (true) {
    const gitPath = path.join(currentPath, ".git");
    if (fs.existsSync(gitPath)) return currentPath;

    const parent = path.dirname(currentPath);
    if (parent === currentPath) return "";
    currentPath = parent;
  }
}

// Configured repository filters (environment before project settings). They
// can only narrow the license's organizations.
function getRepoScopeOrgFilter(cwd) {
  return resolveOrgScope({ cwd });
}

// Allow GitHub repositories owned by an organization the license covers (its
// `orgs` claim), optionally narrowed by configured filters. No license, a
// license covering none, non-Git directories, non-GitHub remotes and other
// owners are excluded.
function getRepoScopeDecision(cwd) {
  const signedInOrgs = credstore.getAllowedGitHubOrgs();
  if (signedInOrgs.length === 0) {
    return { allowed: false, scope: "unknown", classification: "not_activated" };
  }

  // Narrow to the configured org allow-list when present (intersection only —
  // never widens the signed-in set). An empty intersection means every repo
  // falls through to the github_org_mismatch path below.
  const orgFilter = getRepoScopeOrgFilter(cwd);
  const allowedOrgs = orgFilter
    ? signedInOrgs.filter((org) => orgFilter.includes(org))
    : signedInOrgs;

  canonicalScope._resetConfigCache();
  return canonicalScope.getRepoScopeDecision(cwd, allowedOrgs, findGitRoot);
}

// Compatibility helper for callers that sanitize tool data independently.
// Hook builders pass raw fields to runHook's single sanitization boundary.
function sanitizeToolData(obj, hashSalt) {
  return redactDeep(obj, [], hashSalt);
}

function getTimestamp() {
  return new Date().toISOString();
}

// Transfer configuration

// The Codex ingest path mirrors /logs/claude but on a sibling /logs/codex
// route. The collector lambda treats `${backendUrl}/transcript` as the
// transcript handler.
const INGEST_ROUTE = "/logs/codex";

// Resolve the ingest URL from a trusted override, then the token audience,
// then the default below. Both overrides and token-derived URLs are validated.
// An expired audience can supply routing information, but sending still requires
// a fresh license; an override does not bypass authentication.
const DEFAULT_BACKEND_URL = "https://api.meter.skillbench.ai/logs/codex";

// Trusted domain patterns for backend URL validation. Prod tenants are on
// *.meter.skillbench.ai; dev/non-prod on *.meter.dev.skillbench.com (the
// legacy *.meter.skillbench.com patterns are retained for back-compat).
const TRUSTED_BACKEND_PATTERNS = [
  /^https:\/\/api\.meter\.skillbench\.ai\//,
  /^https:\/\/[a-z0-9-]+\.meter\.skillbench\.ai\//,
  /^https:\/\/api\.meter\.skillbench\.com\//,
  /^https:\/\/[a-z0-9-]+\.meter\.skillbench\.com\//,
  /^https:\/\/[a-z0-9-]+\.skillbench\.com\//,
  /^https:\/\/[a-z0-9-]+\.meter\.dev\//,
  /^https:\/\/[a-z0-9-]+\.meter\.dev\.skillbench\.com\//,
];

function isValidBackendUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    // Only allow https for security
    if (parsed.protocol !== "https:") return false;
    // Check against trusted patterns
    return TRUSTED_BACKEND_PATTERNS.some((pattern) => pattern.test(parsed.href));
  } catch {
    return false;
  }
}

/**
 * Resolve routing from the same token used for authorization, so a concurrent
 * sign-in cannot pair one tenant's endpoint with another tenant's token.
 *
 * @param {string|null} token
 * @returns {string} validated HTTPS ingest URL.
 */
function getBackendUrlForToken(token) {
  const override = process.env.SKILLMETER_BACKEND_URL;
  if (override) {
    if (!isValidBackendUrl(override)) {
      console.error(
        `[skillmeter] SKILLMETER_BACKEND_URL rejected (untrusted domain), using default`
      );
      return DEFAULT_BACKEND_URL;
    }
    return override;
  }

  // Per-tenant routing: a signed-in user's license JWT carries the tenant's
  // meter host in its `aud` (audience) claim. Prefer a fresh token, but fall
  // back to the claim of an expired one (allow-expired) so a drain still reaches
  // the correct tenant host while a refresh is pending. Append the Codex ingest
  // route, then fall through to the prod default when there's no usable token.
  const endpoint =
    getEndpointFromToken(token) || getEndpointFromTokenAllowExpired(token);
  if (endpoint) {
    const fullUrl = `${endpoint}${INGEST_ROUTE}`;
    if (!isValidBackendUrl(fullUrl)) {
      console.error(
        `[skillmeter] JWT-derived endpoint rejected (untrusted domain), using default`
      );
      return DEFAULT_BACKEND_URL;
    }
    return fullUrl;
  }

  return DEFAULT_BACKEND_URL;
}

/**
 * Ingest URL for the currently stored license. Convenience wrapper for callers
 * that have no token in hand; the upload path uses getBackendUrlForToken with
 * its own uncached read instead.
 *
 * @returns {string} a validated https ingest URL.
 */
function getBackendUrl() {
  return getBackendUrlForToken(getLicenseToken());
}

const EVENT_TIMEOUT =
  parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
const TRANSCRIPT_TIMEOUT = 30_000;

// Retention for sealed/sent event logs, poison batches and orphaned sidecars.
// Transcript chunks and legacy snapshots are excluded from automatic cleanup.
const CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Event retry bounds
// Transient failures are quarantined at the attempt or age limit. Permanent
// rejections first attempt partial salvage, then quarantine. Poison batches remain
// until the cleanup retention limit. Transcript retention is separate.
const POISON_DIR = path.join(LOG_DIR, "poison");

const MAX_BATCH_RETRIES =
  parseInt(process.env.SKILLMETER_MAX_BATCH_RETRIES || "", 10) || 25;

const BATCH_MAX_AGE_MS =
  parseInt(process.env.SKILLMETER_BATCH_MAX_AGE_MS || "", 10) ||
  14 * 24 * 60 * 60 * 1000;

// An active `events.jsonl` that hasn't been touched in this long is assumed to
// belong to a crashed/abandoned session (a live session writes events far more
// often) and is sealed at SessionStart so its events are recovered and drained.
const ACTIVE_LOG_STALE_MS =
  parseInt(process.env.SKILLMETER_ACTIVE_LOG_STALE_MS || "", 10) || 5 * 60 * 1000;

// Final-session hooks request detached delivery. Workers own this lock until
// completion or process death; completed triggers cannot cause another pass.
const DRAIN_ONCE_LOCK_FILE = path.join(LOG_DIR, ".drain-once.worker.lock");
const DRAIN_ONCE_REQUEST_FILE = path.join(LOG_DIR, ".drain-once.request");
const DRAIN_ONCE_COMPLETED_FILE = path.join(LOG_DIR, ".drain-once.completed");

// Ingest 401/403 forces refresh even if the token has not expired locally.
// Successful rotation or upload clears the marker.
const LICENSE_REJECTED_FILE = path.join(LOG_DIR, ".license-rejected");

/** Record that the ingest edge rejected the stored license. */
function markLicenseRejected(status) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_REJECTED_FILE, `${status} ${Date.now()}\n`);
  } catch {}
}

/** Clear the rejection marker once the license is known to work. */
function clearLicenseRejected() {
  try { fs.unlinkSync(LICENSE_REJECTED_FILE); } catch {}
}

/** True while a rejection is outstanding, i.e. a refresh is owed. */
function isLicenseRejected() {
  try {
    return fs.existsSync(LICENSE_REJECTED_FILE);
  } catch {
    return false;
  }
}

// Retry-monitor singleton lock: ensures at most one long-running retry daemon
// runs across concurrent Codex sessions on this machine. The daemon refreshes
// the lock mtime as a heartbeat and removes it on exit.
const RETRY_DAEMON_LOCK_FILE = path.join(LOG_DIR, ".retry-daemon.lock");
const RETRY_DAEMON_LOCK_STALE_MS =
  parseInt(process.env.SKILLMETER_RETRY_DAEMON_STALE_MS || "", 10) || 5 * 60 * 1000;

// Build the shared upload headers. The license JWT is passed explicitly (not
// read here), keeping routing and authorization on the same snapshot. Upload
// callers retain queued data when authentication is unavailable or rejected.
function commonHeaders(token, extra = {}) {
  const headers = {
    "Content-Type": "application/x-ndjson",
    "Content-Encoding": "gzip",
    "X-Plugin-Version": PLUGIN_VERSION,
    "X-Agent": AGENT_NAME,
    ...extra,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// Atomic write helpers
//
// Hooks from concurrent Codex processes can write to the queue at the same
// time, and a process can be killed mid-write. Both can leave interleaved or
// half-written ("invalid") lines that later poison an upload. These helpers
// keep on-disk artifacts line-atomic and whole-file-atomic respectively.

// Append a single newline-terminated record in one O_APPEND write. POSIX makes
// each write() to an append-mode fd advance the offset atomically, so a single
// write of the whole record can't interleave with another writer's record —
// preventing the spliced lines that would make a batch un-parseable.
function atomicAppendLine(file, line) {
  const buf = Buffer.from(line.endsWith("\n") ? line : `${line}\n`);
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, buf, 0, buf.length, null);
  } finally {
    fs.closeSync(fd);
  }
}

// Write a whole file by staging to a unique temp path and renaming into place.
// rename(2) is atomic within a filesystem, so readers/drains never observe a
// partially written file — they see either the old contents or the new ones.
function atomicWriteFileSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`
  );
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// HTTP outcomes: retain auth failures (401/402/403) without spending retry budget.
// Retry 408, 429 and 5xx; other 4xx enter partial salvage or quarantine.
function isAuthHttpStatus(status) {
  return status === 401 || status === 402 || status === 403;
}

function isPermanentHttpStatus(status) {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

// Upload one sealed event log. Resolves to an outcome the queue layer acts on:
//   "sent"   — 2xx; acknowledged rows removed, held rows remain queued.
//   "poison" — permanent server rejection; the payload will never be accepted.
//   "retry"  — transient failure (5xx / 408 / 429 / network / timeout).
//   "auth"   — no valid license, or the edge rejected the token (401/402/403);
//              the batch stays queued and its retry budget is untouched.
//   "held"   — repository routing unavailable; retain without retry charge.
//   "skip"   — nothing to do (missing file).
// Standalone callers can ignore the value; processSealedBatch uses it to decide
// between salvage, quarantine, and a bounded retry.
async function withEventLogLock(logFile, action) {
  if (!logFile || !fs.existsSync(logFile) || getTelemetryGloballyDisabled()) return "skip";
  const release = transcriptQueue.acquireLock(`${logFile}.lock`);
  if (!release) return "held";
  try {
    return await action();
  } finally {
    // Disable may have skipped this live lock. Only this batch needs another
    // revocation pass; the control command already scanned the rest of the queue.
    try {
      for (const file of [logFile, `${logFile}.sent`, path.join(POISON_DIR, path.basename(logFile))]) {
        repositoryQueue.pruneFile(file, false);
      }
    } catch { console.error("[skillmeter] Repository payload cleanup deferred; routing unavailable"); }
    finally { release(); }
  }
}

async function transferEventLog(logFile, backendUrl, timeoutMs = EVENT_TIMEOUT) {
  return withEventLogLock(logFile, () => transferAuthorizedEventLog(logFile, backendUrl, timeoutMs));
}

function transferAuthorizedEventLog(logFile, backendUrl, timeoutMs = EVENT_TIMEOUT, filtered) {
  if (!logFile || !fs.existsSync(logFile)) return Promise.resolve("skip");
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Event log transfer skipped (telemetry globally disabled)`);
    return Promise.resolve("skip");
  }

  const baseName = path.basename(logFile);

  // Read a fresh token from disk. Missing or expired credentials leave the
  // batch queued without a request or a retry-budget charge.
  const token = getLicenseTokenUncached();
  if (!token || isJwtExpired(token)) {
    console.error(
      `[skillmeter] Event log: no valid license JWT — ${baseName} kept queued`
    );
    return Promise.resolve("auth");
  }

  // Route by the SAME token we are about to authenticate with, unless the
  // caller pinned a URL (tests, SKILLMETER_BACKEND_URL). A drain that resolved
  // the host up front could otherwise pair tenant A's endpoint with tenant B's
  // JWT after a concurrent sign-in.
  const url = backendUrl || getBackendUrlForToken(token);

  try { filtered = filtered || repositoryQueue.pruneFile(logFile); }
  catch { console.error("[skillmeter] Event delivery held; repository routing unavailable"); }
  if (!filtered || filtered.wire === null) return Promise.resolve("held");
  if (!filtered.wire) return Promise.resolve("skip");
  const compressed = zlib.gzipSync(filtered.wire);

  const markSent = () => {
    // Keep held rows at the original path. A durable replacement must complete
    // before reporting success; a failed local acknowledgment remains retryable.
    if (filtered.held) transcriptQueue.writeDurable(logFile, filtered.held);
    else fs.renameSync(logFile, `${logFile}.sent`);
  };

  console.error(
    `[skillmeter] Transferring event log: ${baseName} (${compressed.length} bytes gzipped)`
  );

  return fetch(url, {
    method: "POST",
    headers: commonHeaders(token),
    body: compressed,
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then((res) => {
      if (res.ok) {
        // Proof the stored credential works: drop any outstanding rejection.
        clearLicenseRejected();
        console.error(`[skillmeter] Event log transferred: ${baseName}`);
        markSent();
        return "sent";
      }
      // Keep the session token and queued batch on ingest rejection.
      // Credential recovery belongs to the refresh/activation path.
      if (isAuthHttpStatus(res.status)) {
        // 402 is the organization's license state, which no rotation can fix;
        // 401/403 mean this credential needs replacing, so owe a refresh.
        if (res.status !== 402) markLicenseRejected(res.status);
        console.error(
          `[skillmeter] Event log auth rejected (HTTP ${res.status}) — license kept, ${baseName} kept queued`
        );
        return "auth";
      }
      console.error(`[skillmeter] Event log transfer failed: HTTP ${res.status}`);
      return isPermanentHttpStatus(res.status) ? "poison" : "retry";
    })
    .catch((err) => {
      console.error(`[skillmeter] Event log transfer error: ${err.message}`);
      return "retry";
    });
}

// Transcript staging + upload
//
// Immutable sanitized chunks and their cursor commit before any network call.
// Legacy TRANSCRIPTS_PENDING_DIR snapshots remain available for selected recovery.

function transcriptScope(cwd, token, observeOnly = false) {
  credstore.refreshFromDisk?.();
  if ((!observeOnly && getTelemetryGloballyDisabled()) || credstore.getSignedOut()) return null;
  token = token || getLicenseTokenUncached();
  if (!token || (!observeOnly && isJwtExpired(token))) return null;
  const decision = getRepoScopeDecision(cwd);
  if (!decision.repoRoot) return null;
  const salt = getOrCreateHashSalt(), deviceId = getDeviceId();
  if (!salt || !deviceId) return null;
  const claims = decodeJwtPayload(token);
  // A broker license (ADR 005) names the user in broker_sub and the tenant in
  // sub. Without a stable principal, token rotation cannot reuse this queue.
  // Never deliver one principal's queued transcript as another user.
  const identity = claims.broker_sub;
  const owner = transcriptQueue.hmac(salt, JSON.stringify([claims.iss, claims.aud, claims.sub, identity || token]));
  let route;
  try { route = repositoryQueue.register(cwd, decision.repoRoot); }
  catch {
    console.error("[skillmeter] Transcript routing unavailable; capture deferred");
    return null;
  }
  if (!observeOnly && (!decision.allowed || !resolveTelemetryGate(getTelemetryOptIn(cwd), true).capture)) return null;
  return { cwd: path.resolve(cwd), repoRoot: decision.repoRoot, org: decision.remoteOrg, deviceId, owner,
    queueEpoch: route.epoch, sharedStamp: route.sharedDeliveryToken, sharedPolicySeen: route.sharedPolicySeen,
    // A changed repository identity must start a separate queue even before
    // any consent is recorded; held chunks must not block the new identity.
    consentStamp: owner + decision.repoRoot + (route.epoch || "") +
      (route.sharedPolicySeen || route.previousRepositories?.length ? route.sharedDeliveryToken : "") };
}
function scopeStillAllowed(scope, token) {
  const current = transcriptScope(scope.cwd, token);
  if (current && current.sharedStamp !== scope.sharedStamp &&
      (scope.sharedStamp !== undefined || current.sharedPolicySeen)) return false;
  return current && (current.queueEpoch || 0) === (scope.queueEpoch || 0) && ["repoRoot", "org", "deviceId", "owner"].every(k => current[k] === scope[k]);
}
// Local settings and the global decision identify transitions without
// depending on token rotation or unrelated repository policy revisions.
function transcriptConsentStamp(cwd) {
  const root = findGitRoot(cwd) || path.resolve(cwd), revisions = [];
  let current = path.resolve(cwd);
  while (true) {
    try {
      const stat = fs.statSync(path.join(current, SETTINGS_RELATIVE), { bigint: true });
      revisions.push([current, String(stat.ino), String(stat.mtimeNs), String(stat.ctimeNs)]);
    } catch (error) { if (error.code !== "ENOENT") throw error; revisions.push([current, null]); }
    if (current === root || path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  const globalFile = path.join(TRANSCRIPT_CAPTURES_DIR, "global-boundary.json");
  const globalRevision = fs.existsSync(globalFile) ? JSON.parse(fs.readFileSync(globalFile, "utf8")) : null;
  // Existing signout/signin generation changes even for the same principal;
  // ordinary refresh leaves it intact. Read it without changing the session.
  const authGeneration = credstore.recoverySnapshot?.()?.generation ?? null;
  const stamp = [revisions, getTelemetryGloballyDisabled(), globalRevision, authGeneration];
  const globalChoice = readGlobalConsent();
  if (globalChoice.boundary !== null) stamp.push(globalChoice.boundary);
  const repository = readRepositoryConsent(getRepoScopeDecision(cwd));
  if (repository.reason !== "absent") stamp.push(repository.stamp);
  return JSON.stringify(stamp);
}
function observeTranscriptConsent(source, cwd, verifyReplacement = false) {
  const scope = transcriptScope(cwd, undefined, true);
  if (!scope || !source || !fs.existsSync(source)) return null;
  const allowed = !getTelemetryGloballyDisabled() &&
    resolveTelemetryGate(getTelemetryOptIn(cwd), getRepoScopeDecision(cwd).allowed).capture;
  return transcriptQueue.observeConsent(TRANSCRIPT_CHUNKS_DIR, source, scope,
    getOrCreateHashSalt(), allowed, transcriptConsentStamp(cwd), false, verifyReplacement);
}
function observeKnownTranscriptConsent(repoRoot) {
  // An unselected hook has no upload hint, but its consent journal already
  // knows the source. Enable must move that boundary before the next prompt.
  for (const dir of transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR)) {
    const file = path.join(dir, "consent.json");
    if (!fs.existsSync(file)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (repoRoot && state.repoRoot !== repoRoot) continue;
      if (state.source && state.cwd) observeTranscriptConsent(state.source, state.cwd);
    } catch { console.error("[skillmeter] Consent boundary deferred for an unavailable source journal"); }
  }
}
function stageTranscriptForUpload(transcriptPath, context = {}) {
  const cwd = context.cwd || process.cwd();
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const consent = observeTranscriptConsent(transcriptPath, cwd, true);
    const scope = transcriptScope(cwd);
    if (!consent || !scope || (context.scope && !scopeStillAllowed(context.scope))) return null;
    const result = transcriptQueue.stage(TRANSCRIPT_CHUNKS_DIR, transcriptPath, scope, getOrCreateHashSalt(), {
      consent,
      preserveSessionMetadata: true,
      authorizeCommit: () => scopeStillAllowed(scope) && consent.stamp === transcriptConsentStamp(cwd),
      authorizeRecord: record => {
        const identity = ["session_meta", "session_continuation"].includes(record.type);
        if (identity && record.payload?.originator === "codex_work_desktop") return false;
        if (!(identity || record.type === "turn_context") || !record.payload?.cwd) return true;
        const sourceScope = transcriptScope(record.payload.cwd);
        return sourceScope && sourceScope.repoRoot === scope.repoRoot && sourceScope.owner === scope.owner;
      },
    });
    return result.files[0] || null;
  } catch {
    console.error("[skillmeter] Transcript staging failed; source/cursor retained, see queue diagnostic");
    return null;
  }
}

async function sendTranscriptChunk(meta, compressed, backendUrl, timeoutMs) {
  const token = getLicenseTokenUncached();
  if (!token || isJwtExpired(token) || !scopeStillAllowed(meta.scope, token)) return "skip";
  try {
    const res = await fetch(`${backendUrl || getBackendUrlForToken(token)}/transcript`, {
      method: "POST",
      headers: commonHeaders(token, {
        "X-Device-ID": meta.scope.deviceId,
        "X-Transcript-ID": meta.transcriptId,
        "X-Transcript-Protocol": "chunks-v1",
        "X-Chunk-Seq": String(meta.seq),
        "X-Chunk-Reset": String(meta.reset),
      }),
      body: compressed,
      signal: AbortSignal.timeout(timeoutMs || TRANSCRIPT_TIMEOUT),
    });
    if (res.ok) {
      clearLicenseRejected();
      return "sent";
    }
    if (res.status === 409 && (await res.json()).error === "transcript-baseline-missing") return "reset-required";
    if (isAuthHttpStatus(res.status) && res.status !== 402) markLicenseRejected(res.status);
    // Auth rejection must not clear the session or fall back to anonymous
    // transcript upload. Keep this chunk and all later chunks for scoped retry.
    if (meta.queueDir) transcriptQueue.recordFailure(meta.queueDir, "delivery", `http-${res.status}`, { seq: meta.seq });
    console.error(`[skillmeter] Transcript chunk ${meta.seq}: HTTP ${res.status}; retained`);
    return isAuthHttpStatus(res.status) ? "auth" : "retry";
  } catch { return "retry"; }
}

async function uploadPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs) {
  if (!pendingPath || !fs.existsSync(pendingPath)) return "skip";
  if (!path.resolve(pendingPath).startsWith(TRANSCRIPT_CHUNKS_DIR + path.sep)) {
    // Legacy snapshots have no sequence/scope journal. Preserve for selected
    // recovery; never auto-migrate or quarantine historical data on startup.
    return "skip";
  }
  const dir = path.dirname(path.dirname(pendingPath));
  try {
    const meta = transcriptQueue.metadata(pendingPath);
    if (deviceId !== meta.scope.deviceId) return "skip";
    let outcome = "skip";
    await drainTranscriptDirectory(dir, async (chunk, body) => {
      outcome = await sendTranscriptChunk({ ...chunk, queueDir: dir }, body, backendUrl, timeoutMs);
      return outcome;
    });
    return outcome;
  } catch {
    recordTranscriptQueueFailure(dir);
    return "retry";
  }
}

function recordTranscriptQueueFailure(dir) {
  console.error("[skillmeter] Transcript queue unavailable; retained for retry");
  try {
    transcriptQueue.recordFailure(dir, "delivery", "queue-unavailable");
  } catch {
    console.error("[skillmeter] Could not persist transcript queue diagnostic");
  }
}

function transferTranscript(transcriptPath, deviceId, backendUrl, context = {}) {
  const pending = stageTranscriptForUpload(transcriptPath, context);
  return pending ? uploadPendingTranscript(pending, deviceId, backendUrl) : Promise.resolve("skip");
}

// Small durable capture hints keep all raw reading/gzip work off hook deadlines.
// Only currently authorized lifecycle paths enter this index; it does not scan
// historical sessions. Rechecks run again at capture and at every chunk send.
function requestTranscriptCapture(input, options = {}) {
  const cwd = input?.cwd || process.cwd(), scope = transcriptScope(cwd);
  if (!scope) return 0;
  fs.mkdirSync(TRANSCRIPT_CAPTURES_DIR, { recursive: true, mode: 0o700 });
  const salt = getOrCreateHashSalt();
  const cacheKey = transcriptQueue.hmac(salt, String(input.session_id || "unknown"));
  let paths = collectTranscriptPaths(input, { ...options, discover: options.discover !== false });
  if (!paths.length) {
    // Read old session hints as well as the new independent source hints.
    for (const name of fs.readdirSync(TRANSCRIPT_CAPTURES_DIR)) {
      if (name !== `${cacheKey}.json` && !new RegExp(`^${cacheKey}-[a-f0-9]{64}\\.json$`).test(name)) continue;
      try {
        const cached = JSON.parse(fs.readFileSync(path.join(TRANSCRIPT_CAPTURES_DIR, name), "utf8"));
        if (scopeStillAllowed(cached.scope)) paths.push(...cached.paths);
      } catch { /* Another valid source hint can still recover this session. */ }
    }
  }
  paths = [...new Set(paths)];
  // Separate source keys avoid lost updates when parent/subagent hooks race.
  // A later parent-only hook must not remove the subagent's capture request.
  for (const source of paths) {
    if (!observeTranscriptConsent(source, cwd)) continue;
    const sourceKey = transcriptQueue.hmac(salt, path.resolve(source));
    const cachePath = path.join(TRANSCRIPT_CAPTURES_DIR, `${cacheKey}-${sourceKey}.json`);
    transcriptQueue.writeDurable(cachePath, JSON.stringify({ scope, paths: [source] }));
  }
  return paths.length;
}
function stageRequestedTranscripts() {
  if (!fs.existsSync(TRANSCRIPT_CAPTURES_DIR)) return;
  for (const name of fs.readdirSync(TRANSCRIPT_CAPTURES_DIR).filter(n => /^[a-f0-9]{64}(?:-[a-f0-9]{64})?\.json$/.test(n))) {
    try {
      const capture = JSON.parse(fs.readFileSync(path.join(TRANSCRIPT_CAPTURES_DIR, name), "utf8"));
      if (!scopeStillAllowed(capture.scope)) continue;
      for (const source of capture.paths) {
        try {
          // Stage all slices even if the retry daemon has exited. Bound the
          // loop by the initial size so a growing source cannot hold this
          // detached drain forever; later hooks capture subsequent growth.
          const maxSlices = Math.ceil(fs.statSync(source).size / transcriptQueue.STAGE_BYTES) + 1;
          for (let slice = 0; slice < maxSlices; slice++) {
            if (!stageTranscriptForUpload(source, { cwd: capture.scope.cwd, scope: capture.scope })) break;
          }
        } catch { console.error("[skillmeter] Capture source unavailable; other sources continue"); }
      }
    } catch { console.error("[skillmeter] Capture hint unavailable; retained for retry"); }
  }
}

// Event-log sealing + crash recovery

/**
 * Seal the active event log into a retryable batch (`events.jsonl.<ts>`). This
 * is a local durable-queue transition only; uploading is handled separately by
 * the drain functions. Returns the sealed path, or null when there was nothing
 * to seal.
 */
function sealEventLog() {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`[skillmeter] No event log to seal`);
    return null;
  }

  const baseTimestamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const sealedFile = `${LOG_FILE}.${baseTimestamp + attempt}`;
    if (fs.existsSync(sealedFile)) continue;
    try {
      fs.renameSync(LOG_FILE, sealedFile);
      console.error(`[skillmeter] Sealed event log: ${path.basename(sealedFile)}`);
      return sealedFile;
    } catch (err) {
      if (err && err.code === "ENOENT") {
        console.error(`[skillmeter] No event log to seal`);
        return null;
      }
      if (err && err.code === "EEXIST") continue;
      console.error(`[skillmeter] Event log seal failed: ${err.message}`);
      return null;
    }
  }
  console.error(`[skillmeter] Event log seal failed: no unique batch name`);
  return null;
}

/**
 * Recover an un-rotated `events.jsonl` left behind by a crashed/abandoned
 * session. A live session writes events frequently, so an active log that has
 * been idle beyond ACTIVE_LOG_STALE_MS is assumed orphaned and is sealed so its
 * events join the drain queue. Sealing only splits the stream — it never
 * duplicates events — so an over-eager seal of a quiet-but-live session is
 * harmless. Returns the sealed path, or null.
 */
function recoverStaleActiveLog() {
  let st;
  try {
    st = fs.statSync(LOG_FILE);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const age = Date.now() - st.mtimeMs;
  if (age < ACTIVE_LOG_STALE_MS) return null;

  console.error(
    `[skillmeter] Recovering un-rotated event log (idle ${Math.round(age / 1000)}s) from a prior session`
  );
  return sealEventLog();
}

// Backwards-compatible flush: seal the active log and upload it immediately.
function flushEventLog(backendUrl) {
  const sealed = sealEventLog();
  if (!sealed) return Promise.resolve();
  return transferEventLog(sealed, backendUrl);
}

// Durable-queue listing + draining

function listSealedEventLogs() {
  if (!fs.existsSync(LOG_DIR)) return [];
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((file) => /^events\.jsonl\.\d+$/.test(file))
      .map((file) => path.join(LOG_DIR, file))
      .filter((filePath) => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

function listPendingTranscripts() {
  return transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR).flatMap(transcriptQueue.pendingFiles);
}

// Poison-batch handling: attempt tracking, partial-rejection salvage, quarantine

// Per-batch attempt counter. Kept in a `.meta` sidecar rather than the filename
// so the batch path (and the drain-list regex) stays stable across retries.
function batchMetaPath(batchPath) {
  return `${batchPath}.meta`;
}

function readBatchMeta(batchPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(batchMetaPath(batchPath), "utf8"));
    return { attempts: Number(meta.attempts) || 0, ...(meta.payload ? { payload: meta.payload } : {}) };
  } catch {
    return { attempts: 0 };
  }
}

function writeBatchMeta(batchPath, meta) {
  try {
    atomicWriteFileSync(batchMetaPath(batchPath), JSON.stringify(meta) + "\n");
  } catch {}
}

function clearBatchMeta(batchPath) {
  try { fs.unlinkSync(batchMetaPath(batchPath)); } catch {}
}

// Seal timestamp encoded in `events.jsonl.<ts>` — used as the batch's
// first-seen time for the max-age give-up. Returns null for unexpected names.
function batchSealTimeMs(batchPath) {
  const m = path.basename(batchPath).match(/^events\.jsonl\.(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// Move an undeliverable file aside into POISON_DIR so it stops being retried
// but survives for forensics until the 30-day cleanup removes it. Deletion is a
// last resort only if the move fails (e.g. cross-device) so a poison batch can
// never wedge the queue.
function quarantineFile(filePath, reason) {
  const baseName = path.basename(filePath);
  try {
    fs.mkdirSync(POISON_DIR, { recursive: true });
    const dest = path.join(POISON_DIR, baseName);
    try { fs.unlinkSync(dest); } catch {}
    fs.renameSync(filePath, dest);
    console.error(`[skillmeter] Quarantined poison batch ${baseName}: ${reason}`);
  } catch (err) {
    console.error(
      `[skillmeter] Quarantine of ${baseName} failed (${err.message}); deleting to unblock queue`
    );
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// Partial batch rejection: an NDJSON batch can be poisoned by a few malformed
// lines (e.g. a half-written record from a crashed writer). Re-parse line by
// line, keep only the valid JSON records, and rewrite the batch atomically when
// — and only when — some lines were actually invalid. Returns a summary the
// caller uses to decide whether a salvage retry is worthwhile.
function salvageBatch(batchPath, filtered) {
  let raw;
  try {
    raw = filtered ? filtered.ready : fs.readFileSync(batchPath, "utf8");
  } catch {
    return { rewrote: false, kept: 0, dropped: 0 };
  }

  const valid = [];
  let dropped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      valid.push(line);
    } catch {
      dropped++;
    }
  }

  // Every line is well-formed JSON, so the rejection isn't about parse-ability
  // — there's nothing to salvage and the batch is genuinely poison.
  if (dropped === 0) return { rewrote: false, kept: valid.length, dropped: 0 };
  // Nothing salvageable; let the caller quarantine the whole batch.
  if (valid.length === 0) return { rewrote: false, kept: 0, dropped };

  try {
    transcriptQueue.writeDurable(batchPath, valid.join("\n") + "\n" + (filtered?.held || ""));
    return { rewrote: true, kept: valid.length, dropped };
  } catch {
    return { rewrote: false, kept: valid.length, dropped };
  }
}

// Upload a sealed event log with full poison-batch protection. This is the
// queue-aware wrapper around transferEventLog used by the drains; it enforces
// the max-age and max-retry bounds and performs partial-rejection salvage.
async function processSealedBatch(batchPath, backendUrl, timeoutMs) {
  return withEventLogLock(batchPath, () => processLockedBatch(batchPath, backendUrl, timeoutMs));
}

function quarantinePartition(batchPath, filtered, reason) {
  const dest = path.join(POISON_DIR, path.basename(batchPath));
  if (!filtered.held && !fs.existsSync(dest)) return quarantineFile(batchPath, reason);
  // Publish the rejected portion before removing it from the source. A crash
  // between these writes can repeat rejection, but cannot lose held records.
  // A later rejected subset must not overwrite an earlier quarantine.
  fs.mkdirSync(POISON_DIR, { recursive: true });
  const previous = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  transcriptQueue.writeDurable(dest, previous + filtered.ready);
  if (filtered.held) transcriptQueue.writeDurable(batchPath, filtered.held);
  else fs.unlinkSync(batchPath);
  console.error(`[skillmeter] Quarantined deliverable portion: ${reason}`);
}

async function processLockedBatch(batchPath, backendUrl, timeoutMs) {
  if (!fs.existsSync(batchPath)) return "skip";
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Batch processing skipped (telemetry globally disabled)`);
    return "skip";
  }

  const token = getLicenseTokenUncached();
  if (!token || isJwtExpired(token)) return "auth";

  const baseName = path.basename(batchPath);
  let filtered;
  try { filtered = repositoryQueue.pruneFile(batchPath); }
  catch { return "held"; }
  if (!filtered || filtered.wire === null) return "held";
  if (!filtered.wire) { clearBatchMeta(batchPath); return "skip"; }

  // Max-age give-up: a batch we still can't deliver after BATCH_MAX_AGE_MS is
  // treated as undeliverable. Held rows are outside this delivery attempt.
  const sealTime = batchSealTimeMs(batchPath);
  if (sealTime != null && Date.now() - sealTime > BATCH_MAX_AGE_MS) {
    quarantinePartition(batchPath, filtered, `exceeded max age (${Math.round(BATCH_MAX_AGE_MS / 86400000)}d)`);
    clearBatchMeta(batchPath);
    return "poison";
  }

  const outcome = await transferAuthorizedEventLog(batchPath, backendUrl, timeoutMs, filtered);

  if (outcome === "sent" || outcome === "skip") {
    clearBatchMeta(batchPath);
    return outcome;
  }

  // Rejected at the authorizer (or never sent for want of a license): the
  // payload was never judged, so the batch keeps its place in the queue and its
  // attempt counter is left untouched. A signed-out week must not quarantine a
  // batch the collector would happily accept.
  if (outcome === "auth" || outcome === "held") return outcome;

  if (outcome === "poison") {
    const salv = salvageBatch(batchPath, filtered);
    if (salv.rewrote) {
      console.error(
        `[skillmeter] Salvaged ${baseName}: dropped ${salv.dropped} invalid line(s), retrying ${salv.kept} valid`
      );
      // Recheck consent after the first request, before sending the salvage.
      try { filtered = repositoryQueue.pruneFile(batchPath); } catch { return "held"; }
      if (!filtered || filtered.wire === null) return "held";
      if (!filtered.wire) { clearBatchMeta(batchPath); return "skip"; }
      const retryOutcome = await transferAuthorizedEventLog(batchPath, backendUrl, timeoutMs, filtered);
      if (retryOutcome === "sent") {
        clearBatchMeta(batchPath);
        return "sent";
      }
      if (retryOutcome === "retry" || retryOutcome === "auth" || retryOutcome === "held" || retryOutcome === "skip") {
        // The salvaged batch was never judged on its merits — a transient
        // failure, or the license aged out between the two posts. Keep it.
        return retryOutcome;
      }
      quarantinePartition(batchPath, filtered, "still rejected after partial-rejection salvage");
      clearBatchMeta(batchPath);
      return "poison";
    }
    quarantinePartition(
      batchPath, filtered,
      salv.dropped > 0 ? "no salvageable lines remain" : "server rejected payload (permanent)"
    );
    clearBatchMeta(batchPath);
    return "poison";
  }

  // Transient failure: bump the attempt counter and quarantine once we've
  // burned through the retry budget.
  const meta = readBatchMeta(batchPath);
  // A repository becoming eligible must not inherit another subset's retries.
  const payload = crypto.createHash("sha256").update(filtered.ready).digest("hex");
  if ((meta.payload && meta.payload !== payload) || (!meta.payload && filtered.held)) meta.attempts = 0;
  meta.payload = payload;
  meta.attempts += 1;
  if (meta.attempts >= MAX_BATCH_RETRIES) {
    quarantinePartition(batchPath, filtered, `exceeded ${MAX_BATCH_RETRIES} retries`);
    clearBatchMeta(batchPath);
    return "poison";
  }
  writeBatchMeta(batchPath, meta);
  return "retry";
}

// Compatibility entry point for callers holding a durable gzip chunk path.
async function processPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs) {
  return uploadPendingTranscript(pendingPath, deviceId, backendUrl, timeoutMs);
}

async function drainFailedLogs(backendUrl, timeoutMs) {
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Event-log drain skipped (telemetry globally disabled)`);
    return 0;
  }
  const files = listSealedEventLogs();
  if (files.length === 0) return 0;
  console.error(`[skillmeter] Draining ${files.length} sealed event log(s)`);
  await Promise.allSettled(
    files.map((filePath) => processSealedBatch(filePath, backendUrl, timeoutMs))
  );
  return files.length;
}

// One bounded recovery attempt per sweep. The durable reset request survives
// process death, a missing raw source, consent changes and network failures.
async function drainTranscriptDirectory(dir, send) {
  transcriptQueue.purgeRevoked(dir, repositoryQueue.revokedScope);
  try { await transcriptQueue.drainDirectory(dir, send); }
  finally { transcriptQueue.purgeRevoked(dir, repositoryQueue.revokedScope); }
  const request = path.join(dir, "reset-request.json"), cursorFile = path.join(dir, "cursor.json");
  if (fs.existsSync(request) && fs.existsSync(cursorFile)) {
    const cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    const reset = JSON.parse(fs.readFileSync(request, "utf8"));
    if (reset.baseline >= cursor.baseline && cursor.source && scopeStillAllowed(cursor.scope)) {
      const staged = stageTranscriptForUpload(cursor.source, { cwd: cursor.scope.cwd, scope: cursor.scope });
      if (staged) await transcriptQueue.drainDirectory(dir, send);
    }
  }
}

async function drainPendingTranscripts(backendUrl, timeoutMs) {
  if (getTelemetryGloballyDisabled() || credstore.getSignedOut()) return 0;
  stageRequestedTranscripts();
  let count = 0;
  for (const dir of transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR)) {
    try {
      // The retry monitor needs work found, including failed uploads. Counting
      // only acknowledgments would make an outage look like an idle queue.
      count += transcriptQueue.pendingFiles(dir).length;
      await drainTranscriptDirectory(dir, (meta, body) => sendTranscriptChunk({ ...meta, queueDir: dir }, body, backendUrl, timeoutMs));
    } catch {
      recordTranscriptQueueFailure(dir);
    }
  }
  return count;
}

// Local reconciliation only: no transmission or credential changes.
function reconcileConsentRevocations() {
  let complete = true;
  try {
    if (repositoryQueue.hasRevoked(LOG_FILE)) sealEventLog();
    if (!repositoryQueue.purgeEvents()) complete = false;
  } catch { complete = false; console.error("[skillmeter] Event revocation deferred; routing unavailable"); }
  for (const dir of transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR)) {
    try { if (!transcriptQueue.purgeRevoked(dir, repositoryQueue.revokedScope)) complete = false; }
    catch { complete = false; console.error("[skillmeter] Transcript revocation deferred; routing unavailable"); }
  }
  return complete;
}

/** Drain both queues once; return the pre-drain count of queued items. */
async function drainQueuesOnce(backendUrl, timeoutMs) {
  cleanupStaleFiles();
  reconcileConsentRevocations();
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] Queue drain skipped (telemetry globally disabled)`);
    return 0;
  }
  const logs = await drainFailedLogs(backendUrl, timeoutMs);
  const transcripts = await drainPendingTranscripts(backendUrl, timeoutMs);
  return logs + transcripts;
}

// Backwards-compatible alias retained for existing callers/tests.
function retryFailedLogs(backendUrl) {
  void drainFailedLogs(backendUrl);
}

// Detached drain spawn (one-shot)

function readDrainMarker(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function getDrainOnceRequest() {
  return readDrainMarker(DRAIN_ONCE_REQUEST_FILE);
}

function shouldSpawnDrainOnce() {
  const request = getDrainOnceRequest();
  if (request && request === readDrainMarker(DRAIN_ONCE_COMPLETED_FILE)) return false;
  try {
    const owner = JSON.parse(fs.readFileSync(DRAIN_ONCE_LOCK_FILE, "utf8"));
    if (isProcessAlive(owner.pid)) return false;
  } catch {}
  // A child acquires the exclusive lock before reading the queues. Concurrent
  // spawns are harmless; only the owner can drain or record completion.
  return true;
}

function beginDrainOnce(requestedOnly = false) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const release = transcriptQueue.acquireLock(DRAIN_ONCE_LOCK_FILE);
  if (!release) return null;
  try {
    const request = getDrainOnceRequest();
    if (requestedOnly && request && request === readDrainMarker(DRAIN_ONCE_COMPLETED_FILE)) {
      release();
      return null;
    }
    return { request, release };
  } catch (error) { release(); throw error; }
}

function finishDrainOnce(run) {
  if (!run?.release) return;
  const release = run.release;
  run.release = null;
  try {
    // Completion means this trigger was serviced, even if delivery failed.
    // A failed upload waits for a new hook or the existing retry monitor.
    if (run.request) transcriptQueue.writeDurable(DRAIN_ONCE_COMPLETED_FILE, run.request);
  } finally { release(); }
  if (getDrainOnceRequest() !== run.request) startDetachedDrain();
}

/**
 * Spawn a detached drain that resolves credentials and routing when it sends.
 * Do not freeze a tenant endpoint into the child's environment.
 */
function spawnDetachedDrain() {
  // Persist even coalesced triggers. A final hook can arrive after the active
  // worker has enumerated/staged its queues, with no later hook to wake it.
  fs.mkdirSync(LOG_DIR, { recursive: true });
  transcriptQueue.writeDurable(DRAIN_ONCE_REQUEST_FILE, crypto.randomUUID());
  return startDetachedDrain();
}

function startDetachedDrain() {
  if (!shouldSpawnDrainOnce()) return false;

  const script = path.join(PLUGIN_ROOT, "scripts", "drain_once.js");
  try {
    const child = spawn(process.execPath, [script, "--requested"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    console.error(`[skillmeter] Drain trigger spawned: pid=${child.pid}`);
    return true;
  } catch (err) {
    console.error(`[skillmeter] Drain trigger spawn failed: ${err.message}`);
    return false;
  }
}

// Retry monitor
// SessionStart launches a detached worker coordinated by a heartbeat lock.
// Idle and maximum-lifetime limits bound its lifetime.

function isProcessAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function readRetryDaemonLock() {
  try {
    const raw = fs.readFileSync(RETRY_DAEMON_LOCK_FILE, "utf8").trim();
    const pid = parseInt(raw.split(/\s+/)[0], 10);
    const st = fs.statSync(RETRY_DAEMON_LOCK_FILE);
    return { pid, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function isRetryDaemonRunning() {
  const lock = readRetryDaemonLock();
  if (!lock) return false;
  if (Date.now() - lock.mtimeMs > RETRY_DAEMON_LOCK_STALE_MS) return false;
  return isProcessAlive(lock.pid);
}

function writeRetryDaemonLock(pid) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(RETRY_DAEMON_LOCK_FILE, `${pid} ${Date.now()}\n`);
    return true;
  } catch {
    return false;
  }
}

function refreshRetryDaemonLock(pid = process.pid) {
  return writeRetryDaemonLock(pid);
}

function ownsRetryDaemonLock(pid = process.pid) {
  const lock = readRetryDaemonLock();
  return !!lock && lock.pid === pid;
}

function clearRetryDaemonLock(pid = process.pid) {
  if (!ownsRetryDaemonLock(pid)) return;
  try { fs.unlinkSync(RETRY_DAEMON_LOCK_FILE); } catch {}
}

/**
 * Launch the long-running retry monitor if one isn't already running. Returns
 * true when a new daemon was spawned.
 */
function spawnRetryDaemon() {
  if (isRetryDaemonRunning()) {
    console.error(`[skillmeter] Retry monitor already running`);
    return false;
  }

  const script = path.join(PLUGIN_ROOT, "scripts", "monitors", "retry_daemon.js");
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    // Claim the lock immediately so a concurrent SessionStart doesn't also
    // spawn one; the daemon refreshes this heartbeat as it runs.
    writeRetryDaemonLock(child.pid);
    child.unref();
    console.error(`[skillmeter] Retry monitor spawned: pid=${child.pid}`);
    return true;
  } catch (err) {
    console.error(`[skillmeter] Retry monitor spawn failed: ${err.message}`);
    return false;
  }
}

// Cleanup + final-session sealing

/**
 * Delete old sealed/sent event logs, poison batches and orphaned event files.
 * Keep transcript chunks and legacy snapshots available for selected recovery.
 */
function cleanupStaleFiles() {
  const now = Date.now();
  const candidates = [];

  if (fs.existsSync(LOG_DIR)) {
    try {
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (/^events\.jsonl\.\d+$/.test(f)) {
          const batch = path.join(LOG_DIR, f);
          // Partitioning a mixed batch rewrites its mtime. Its seal timestamp
          // remains fixed, so a hold cannot extend retention on every retry.
          if (now - batchSealTimeMs(batch) <= CLEANUP_MAX_AGE_MS) continue;
          const release = transcriptQueue.acquireLock(`${batch}.lock`);
          if (!release) continue;
          try {
            if (fs.existsSync(batch)) fs.unlinkSync(batch);
            clearBatchMeta(batch);
            console.error("[skillmeter] Expired sealed event batch after 30-day retention");
          } finally { release(); }
          continue;
        }
        // Uploaded batches, plus orphaned attempt-meta sidecars whose batch has
        // already been sent or quarantined (so they never leak).
        if (/^events\.jsonl\.\d+\.sent$/.test(f)) {
          candidates.push(path.join(LOG_DIR, f));
        } else if (/^events\.jsonl\.\d+\.meta$/.test(f)) {
          const batch = path.join(LOG_DIR, f.replace(/\.meta$/, ""));
          if (!fs.existsSync(batch)) candidates.push(path.join(LOG_DIR, f));
        } else if (/\.tmp-\d+-[0-9a-f]+$/.test(f)) {
          // Orphaned atomic-write temp file from a crash mid-rename.
          candidates.push(path.join(LOG_DIR, f));
        }
      }
    } catch {}
  }

  // Quarantined poison batches: kept for forensics, but bounded by the same
  // 30-day retention so they can't accumulate indefinitely either.
  if (fs.existsSync(POISON_DIR)) {
    try {
      for (const f of fs.readdirSync(POISON_DIR)) {
        if (/^events\.jsonl\.\d+(?:\.meta)?$/.test(f)) candidates.push(path.join(POISON_DIR, f));
      }
    } catch {}
  }

  // Legacy transcript snapshots/poison and new chunks require selected recovery.
  // Never expire the only retained copy automatically during this migration.

  let deleted = 0;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && now - st.mtimeMs > CLEANUP_MAX_AGE_MS) {
        fs.unlinkSync(p);
        deleted++;
      }
    } catch {}
  }

  if (deleted > 0) {
    console.error(`[skillmeter] Cleaned up ${deleted} stale file(s) older than 30 days`);
  }
}

function safeTranscriptCandidate(candidate) {
  if (!candidate || typeof candidate !== "string") return "";
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? path.resolve(candidate)
      : "";
  } catch {
    return "";
  }
}

function transcriptFileMatchesSession(filePath, sessionId) {
  if (path.basename(filePath).includes(sessionId)) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    let firstLine = "";
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      firstLine = buf.toString("utf8", 0, bytes).split("\n", 1)[0];
    } finally {
      fs.closeSync(fd);
    }
    if (!firstLine) return false;
    const record = JSON.parse(firstLine);
    return record && record.payload && record.payload.id === sessionId;
  } catch {
    return false;
  }
}

function findCodexTranscriptBySessionId(sessionId, sessionsDir = CODEX_SESSIONS_DIR) {
  if (!sessionId || typeof sessionId !== "string") return "";
  if (!fs.existsSync(sessionsDir)) return "";

  const stack = [sessionsDir];
  const candidates = [];
  let visited = 0;
  const maxVisited = 5000;

  while (stack.length > 0 && visited < maxVisited) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visited++ >= maxVisited) break;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (transcriptFileMatchesSession(p, sessionId)) {
        try {
          candidates.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {}
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ? candidates[0].path : "";
}

function collectTranscriptPaths(input, options = {}) {
  const paths = [];
  const seen = new Set();
  const add = (candidate) => {
    const p = safeTranscriptCandidate(candidate);
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };

  if (input) {
    // SubagentStop has its own transcript in addition to the parent session
    // transcript. Stage both when available so subagent conversations are not
    // hidden behind the common transcript_path field.
    add(input.agent_transcript_path);
    add(input.transcript_path);

    if (paths.length === 0 && options.discover !== false) {
      add(findCodexTranscriptBySessionId(input.session_id, options.sessionsDir));
    }
  }

  return paths;
}

/**
 * Seal final-session artifacts into durable queues and kick off a detached
 * drain. Uploading is left to the drain / retry monitor so the hook returns
 * quickly instead of blocking on network I/O.
 */
function sealFinalSessionArtifacts(input) {
  const sealed = sealEventLog();

  const captured = requestTranscriptCapture(input, { discover: false });
  if (sealed || captured) spawnDetachedDrain();
}

function sealEventLogAndTriggerDrain() {
  if (sealEventLog()) spawnDetachedDrain();
}

// Replaces the old synchronous flush+upload: seal locally, then hand off to a
// detached drain so the Stop / SubagentStop hook isn't blocked on the network.
function flushAndTransfer(input) {
  sealFinalSessionArtifacts(input);
  return Promise.resolve();
}

function logStructured(level, event, sessionId, data, deviceId, route) {
  if (!deviceId) return;

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const logEntry = {
    timestamp: getTimestamp(),
    level,
    hook_event_name: event,
    session_id: sessionId,
    device_id: deviceId,
    agent: AGENT_NAME,
    data,
    _queue: route || repositoryQueue.eventRoute(data),
  };

  // Atomic single-write append so concurrent hook processes can't splice
  // partial records into the active log and produce an un-parseable batch.
  atomicAppendLine(LOG_FILE, JSON.stringify(logEntry));
}

function getTranscriptId(transcriptPath) {
  if (!transcriptPath) return "";
  return path.basename(transcriptPath);
}

const logInfo = (event, sessionId, data, deviceId, route) =>
  logStructured("info", event, sessionId, data, deviceId, route);

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on("error", reject);
  });
}

// Explicit repository consent, following Claude's default-off capture rule.
// Acknowledged organization and repository ON grant capture; local restrictions still apply.

function telemetryCliCommand(action) {
  return `node ${JSON.stringify(path.join(PLUGIN_ROOT, "scripts", "telemetry.js"))} ${action}`;
}

function getRepositoryPolicyDecision(cwd) {
  // A record deleted after it was observed is reported by the reader through
  // the observation marker, not through routing state.
  return readRepositoryConsent(getRepoScopeDecision(cwd));
}

function getTelemetryOptIn(cwd) {
  const record = getRepositoryPolicyDecision(cwd);
  if (record.revoked) return false;
  // Local settings only restrict; the grant is the acknowledged record. A local
  // OFF reports as an opt-out even before any record exists.
  const local = getLocalTelemetryChoice(cwd);
  if (local === "off") return false;
  if (!record.allowed || local === "invalid") return null;
  return record.acknowledged ? true : null;
}

function getLocalTelemetryChoice(cwd) {
  const root = findGitRoot(cwd) || path.resolve(cwd);
  let current = path.resolve(cwd);
  while (current !== root) {
    const choice = readTelemetryChoice(current);
    if (choice === "off" || choice === "invalid") return choice;
    const parent = path.dirname(current);
    if (parent === current) return "invalid";
    current = parent;
  }
  return readTelemetryChoice(root);
}

function saveTelemetryOptIn(cwd, value) {
  if (typeof value !== "boolean") throw new Error("Telemetry choice must be boolean.");
  const settingsPath = path.join(findGitRoot(cwd) || cwd, SETTINGS_RELATIVE);
  const repoRoot = findGitRoot(cwd) || path.resolve(cwd);
  repositoryQueue.register(cwd, repoRoot, !value, () => {
    let content = {};
    if (fs.existsSync(settingsPath)) {
      content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (!content || typeof content !== "object" || Array.isArray(content) ||
          (content.skillmeter !== undefined && (!content.skillmeter || typeof content.skillmeter !== "object" || Array.isArray(content.skillmeter)))) {
        throw new Error("Invalid project settings; repair the file before changing consent.");
      }
    }
    // A local setting only restricts, so clearing the restriction removes the
    // key instead of writing an ON that would grant nothing.
    const skillmeter = { ...content.skillmeter };
    if (value) delete skillmeter.telemetry;
    else skillmeter.telemetry = false;
    content.skillmeter = skillmeter;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    return () => transcriptQueue.writeDurable(settingsPath, JSON.stringify(content, null, 2) + "\n");
  });
  observeKnownTranscriptConsent(repoRoot);
  if (!value) {
    sealEventLog();
    let complete = repositoryQueue.purgeEvents();
    for (const dir of transcriptQueue.queueDirectories(TRANSCRIPT_CHUNKS_DIR)) {
      try { if (!transcriptQueue.purgeRevoked(dir, repositoryQueue.revokedScope)) complete = false; }
      catch { complete = false; }
    }
    if (!complete) console.error("[skillmeter] Some local payload cleanup is deferred; queued data remains subject to delivery checks");
  }
}

// In-context consent notice: printed to a Codex hook's stderr channel when a
// project has no consent. No decision is saved until the user records one.
function writeTelemetryConsentFallback(cwd, stream = process.stderr) {
  const record = getRepositoryPolicyDecision(cwd);
  if (record.revoked || ["consent_record_missing", "invalid"].includes(record.reason)) {
    stream.write("SkillMeter: The organization or repository consent record blocks capture. Check telemetry status; unrestrict cannot override it.\n");
    return;
  }
  stream.write(
    [
      `SkillMeter: Telemetry is not configured for ${cwd}`,
      "SkillMeter: Choose telemetry with $skillmeter:signin, or check it with:",
      `  ${telemetryCliCommand("status")}`,
      "",
    ].join("\n")
  );
}

/**
 * Resolve project consent: explicit false stops capture; explicit true enables
 * it subject to repository scope. An unset choice never authorizes capture.
 *
 * @param {boolean|null} optIn - getTelemetryOptIn(cwd) result
 * @param {boolean} repoOrgOwned - repoScopeDecision.allowed
 * @returns {{capture: boolean, mode: "opted_out"|"opted_in"|"out_of_scope"|"not_enabled"}}
 */
function resolveTelemetryGate(optIn, repoOrgOwned) {
  if (optIn === false) return { capture: false, mode: "opted_out" };
  if (repoOrgOwned !== true) return { capture: false, mode: "out_of_scope" };
  if (optIn === true) return { capture: true, mode: "opted_in" };
  return { capture: false, mode: "not_enabled" };
}

// Default stderr messaging for the resolved gate, used by every hook that
// doesn't supply an onGate reactor (i.e. every hook except SessionStart).
function defaultGateMessaging(eventName, gate) {
  if (!gate.capture) {
    const reason =
      gate.mode === "opted_out"
        ? "telemetry disabled for this project"
        : gate.mode === "out_of_scope" ? "repository out of scope" : "telemetry not enabled";
    console.error(`[skillmeter] ${eventName}: skipped (${reason})`);
    return;
  }
}

// runHook — shared driver for every Codex hook script

/**
 * Common runtime for hook scripts.
 *
 * @param {string} eventName - Codex hook event name
 * @param {function} buildData - (input, ctx) => event-specific data
 * @param {object} [options]
 * @param {function} [options.beforeStdin] - Called after device id resolves, before stdin
 * @param {function} [options.onGate] - Gate reactor: ({ gate, repoScopeDecision, cwd, input, eventName }) => void.
 *   Runs after the gate is resolved (for banners/side-effects). The capture decision stays central —
 *   runHook exits when gate.capture is false regardless. Without it, default stderr messaging is used.
 * @param {function} [options.afterLog] - Called after logInfo (e.g. flush)
 * @param {boolean} [options.requireJsonStdout] - If true, write `{}` to stdout
 *   before any exit. Required by Codex for Stop and SubagentStop.
 */
async function runHook(eventName, buildData, options = {}) {
  const requireJsonStdout = !!options.requireJsonStdout;
  const exit = (code) => {
    if (requireJsonStdout) {
      try { process.stdout.write("{}\n"); } catch {}
    }
    process.exit(code);
  };

  const deviceId = getDeviceId();
  if (!deviceId) {
    console.error(`[skillmeter] ${eventName}: skipped (no device ID)`);
    return exit(0);
  }

  if (options.beforeStdin) options.beforeStdin(deviceId);

  let input;
  try {
    input = await readStdin();
  } catch (err) {
    console.error(`[skillmeter] ${eventName}: stdin parse failed (${err.message})`);
    return exit(0);
  }
  if (!input) {
    console.error(`[skillmeter] ${eventName}: skipped (no stdin input)`);
    return exit(0);
  }

  const cwd = path.resolve(input.cwd || process.cwd());
  try {
    for (const source of collectTranscriptPaths(input, { discover: false })) {
      observeTranscriptConsent(source, cwd);
    }
  } catch {
    console.error("[skillmeter] Transcript consent observation failed; capture deferred");
    return exit(0);
  }
  if (readRepositoryConsent(getRepoScopeDecision(cwd)).revoked) reconcileConsentRevocations();
  if (getTelemetryGloballyDisabled()) {
    console.error(`[skillmeter] ${eventName}: skipped (telemetry globally disabled)`);
    return exit(0);
  }

  // Repository scope and explicit consent must both permit capture.
  const repoScopeDecision = getRepoScopeDecision(cwd);

  // Callers react via onGate (banners/side-effects); the capture
  // decision stays central — runHook exits below when gate.capture is false.
  // Hooks without an onGate get the default stderr messaging. (Replaces the
  // former OS consent dialog + per-hook checkOptIn override.)
  const gate = resolveTelemetryGate(getTelemetryOptIn(cwd), repoScopeDecision.allowed);
  if (options.onGate) {
    options.onGate({ gate, repoScopeDecision, cwd, input, eventName });
  } else {
    defaultGateMessaging(eventName, gate);
  }
  if (!gate.capture) return exit(0);

  const sessionId = input.session_id || "unknown";
  const hashSalt = getOrCreateHashSalt();
  if (!hashSalt) {
    console.error(`[skillmeter] ${eventName}: skipped (no hash salt)`);
    return exit(0);
  }

  let route;
  try { route = repositoryQueue.register(cwd, repoScopeDecision.repoRoot); }
  catch {
    console.error(`[skillmeter] ${eventName}: skipped (repository routing unavailable)`);
    return exit(0);
  }
  if (!resolveTelemetryGate(getTelemetryOptIn(cwd), getRepoScopeDecision(cwd).allowed).capture) return exit(0);
  const ctx = { hashSalt, cwd, sanitizeToolData, getTranscriptId };
  const eventData = buildData ? buildData(input, ctx) : {};

  const rawData = {
    transcript_path: getTranscriptId(input.transcript_path),
    cwd,
    repo_scope: repoScopeDecision.scope,
    repo_classification: repoScopeDecision.classification,
    repo_root: repoScopeDecision.repoRoot
      ? hashHmac(repoScopeDecision.repoRoot, hashSalt)
      : undefined,
    repo_remote_org: repoScopeDecision.remoteOrg
      ? hashHmac(repoScopeDecision.remoteOrg, hashSalt)
      : undefined,
    permission_mode: input.permission_mode,
    model: input.model,
    turn_id: input.turn_id,
    ...eventData,
  };

  // Sanitize every hook field before writing to the durable event queue.
  // Attach redaction counts and detector types, without matched values.
  const { value: data, meta } = sanitizeEventData(rawData, hashSalt);
  if (meta.secrets > 0 || meta.pii > 0) {
    console.error(
      `[skillmeter] ${eventName}: redacted ${meta.secrets} secret(s) and ${meta.pii} identifier(s) before upload`
    );
  }

  logInfo(eventName, sessionId, data, deviceId, { epoch: route.epoch, sharedStamp: route.sharedDeliveryToken });
  console.error(
    `[skillmeter] ${eventName}: logged (session=${String(sessionId).slice(0, 8)}…)`
  );

  try {
    if (requestTranscriptCapture(input, { discover: !["SessionEnd", "Interrupt", "Stop", "SubagentStop"].includes(eventName) })) {
      spawnDetachedDrain();
    }
  } catch { console.error("[skillmeter] Capture hint failed; next lifecycle event can retry"); }

  if (options.afterLog) {
    const result = options.afterLog(input, deviceId);
    if (result && typeof result.then === "function") {
      await result;
    }
  }

  return exit(0);
}

module.exports = {
  getDeviceId,
  getOrCreateHashSalt,
  getLicenseToken,
  getLicenseTokenUncached,
  getTelemetryGloballyDisabled,
  setTelemetryGloballyDisabled,
  tryRefreshLicense,
  purgeEventLogs,
  eventQueueEmpty,
  hashHmac,
  sanitizeToolData,
  getTimestamp,
  logStructured,
  logInfo,
  readStdin,
  getTranscriptId,
  retryFailedLogs,
  transferEventLog,
  transferTranscript,
  flushEventLog,
  flushAndTransfer,
  // Durable queue: sealing + crash recovery
  sealEventLog,
  recoverStaleActiveLog,
  sealFinalSessionArtifacts,
  sealEventLogAndTriggerDrain,
  // Durable queue: transcript staging
  safeTranscriptCandidate,
  transcriptFileMatchesSession,
  findCodexTranscriptBySessionId,
  collectTranscriptPaths,
  stageTranscriptForUpload,
  observeTranscriptConsent,
  observeKnownTranscriptConsent,
  reconcileConsentRevocations,
  requestTranscriptCapture,
  stageRequestedTranscripts,
  TRANSCRIPT_CHUNKS_DIR,
  TRANSCRIPT_CAPTURES_DIR,
  uploadPendingTranscript,
  // Durable queue: listing + draining
  listSealedEventLogs,
  listPendingTranscripts,
  drainFailedLogs,
  drainPendingTranscripts,
  drainQueuesOnce,
  // Poison-batch handling + atomic writes
  atomicAppendLine,
  atomicWriteFileSync,
  isAuthHttpStatus,
  isPermanentHttpStatus,
  salvageBatch,
  quarantineFile,
  processSealedBatch,
  processPendingTranscript,
  readBatchMeta,
  writeBatchMeta,
  clearBatchMeta,
  batchMetaPath,
  POISON_DIR,
  MAX_BATCH_RETRIES,
  BATCH_MAX_AGE_MS,
  // Detached drain (one-shot)
  shouldSpawnDrainOnce,
  beginDrainOnce,
  getDrainOnceRequest,
  finishDrainOnce,
  spawnDetachedDrain,
  // Retry monitor (long-running singleton)
  isRetryDaemonRunning,
  spawnRetryDaemon,
  refreshRetryDaemonLock,
  ownsRetryDaemonLock,
  clearRetryDaemonLock,
  // Cleanup
  cleanupStaleFiles,
  getTelemetryOptIn,
  getLocalTelemetryChoice,
  readGlobalConsent,
  getRepositoryPolicyDecision,
  saveTelemetryOptIn,
  writeTelemetryConsentFallback,
  resolveTelemetryGate,
  defaultGateMessaging,
  getRepoScopeDecision,
  findGitRoot,
  getRepoScopeOrgFilter,
  runHook,
  PLUGIN_ROOT,
  PLUGIN_DATA,
  PLUGIN_VERSION,
  LOG_DIR,
  LOG_FILE,
  CONSENT_OBSERVED_FILE,
  CODEX_HOME,
  CODEX_SESSIONS_DIR,
  TRANSCRIPTS_PENDING_DIR,
  CLEANUP_MAX_AGE_MS,
  ACTIVE_LOG_STALE_MS,
  DRAIN_ONCE_LOCK_FILE,
  RETRY_DAEMON_LOCK_FILE,
  DEFAULT_BACKEND_URL,
  getBackendUrl,
  getBackendUrlForToken,
  markLicenseRejected,
  clearLicenseRejected,
  isLicenseRejected,
  AGENT_NAME,
  SETTINGS_RELATIVE,
};

/**
 * Organization-scoped exclusion-audit queue.
 *
 * Repository-blocked hook payloads never enter this queue. It accepts only the
 * small TelemetryCaptureExcluded schema built by logger.js and binds every
 * batch to the current license tenant (sorted org set + JWT audience).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const credstore = require("../credstore");
const { atomicWriteJson, safeReadJson } = require("./io");
const { getLicenseAudiences, getLicenseOrgs } = require("./jwt");
const {
  ORGANIZATION_AUDIT_LOG_DIR,
  organizationAuditQueuePaths,
} = require("./paths");
const { sanitizeEventData } = require("./sanitize");
const telemetryStore = require("./telemetry-store");

const QUEUE_SCHEMA_VERSION = 1;

function tenantFingerprint(token, hashSalt) {
  if (!token || !hashSalt) return "";
  const orgs = [...new Set(getLicenseOrgs(token))].sort();
  if (orgs.length === 0) return "";
  const audiences = getLicenseAudiences(token);
  const identity = JSON.stringify({ audiences, orgs });
  return crypto.createHmac("sha256", hashSalt)
    .update(identity)
    .digest("hex")
    .slice(0, 24);
}

function currentTenantFingerprint() {
  return tenantFingerprint(
    credstore.getLicenseTokenUncached(),
    credstore.getHashSalt()
  );
}

function currentOrganizationAuditContext({ create = false } = {}) {
  const fingerprint = currentTenantFingerprint();
  if (!fingerprint) return null;
  const paths = organizationAuditQueuePaths(fingerprint);
  const context = { tenantFingerprint: fingerprint, ...paths };
  if (!create) return context;

  try {
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    const existing = safeReadJson(paths.metadata, null);
    if (
      existing &&
      (
        existing.schemaVersion !== QUEUE_SCHEMA_VERSION ||
        existing.tenantFingerprint !== fingerprint
      )
    ) {
      return null;
    }
    if (!existing) {
      atomicWriteJson(paths.metadata, {
        schemaVersion: QUEUE_SCHEMA_VERSION,
        telemetryScope: "organization",
        tenantFingerprint: fingerprint,
        policyRevision: telemetryStore.getPolicyRevision(),
        createdAt: Date.now(),
      });
    }
    return context;
  } catch {
    return null;
  }
}

function appendCaptureExcluded({
  sourceEventName,
  gateMode,
  sessionId,
  cwd,
  deviceId,
  hashSalt,
}) {
  if (!deviceId || !hashSalt || !credstore.hasValidLicense()) return false;
  if (!credstore.isTelemetryTransmissionAllowed("")) return false;

  const queue = currentOrganizationAuditContext({ create: true });
  if (!queue) return false;
  const { value: data } = sanitizeEventData({
    source_hook_event_name: sourceEventName,
    gate_mode: gateMode,
    cwd,
  }, hashSalt);

  try {
    if (!credstore.isTelemetryTransmissionAllowed("")) return false;
    const current = currentOrganizationAuditContext();
    if (
      !current ||
      current.tenantFingerprint !== queue.tenantFingerprint
    ) {
      return false;
    }
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      hook_event_name: "TelemetryCaptureExcluded",
      telemetry_scope: "organization",
      session_id: sessionId,
      device_id: deviceId,
      data,
    };
    fs.appendFileSync(queue.eventLog, JSON.stringify(logEntry) + "\n");
    return true;
  } catch {
    return false;
  }
}

function listOrganizationAuditQueueContexts() {
  if (!fs.existsSync(ORGANIZATION_AUDIT_LOG_DIR)) return [];
  try {
    return fs.readdirSync(ORGANIZATION_AUDIT_LOG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const root = path.join(ORGANIZATION_AUDIT_LOG_DIR, entry.name);
        const metadata = path.join(root, "tenant.json");
        const meta = safeReadJson(metadata, null);
        if (
          meta?.schemaVersion !== QUEUE_SCHEMA_VERSION ||
          typeof meta.tenantFingerprint !== "string" ||
          !/^[0-9a-f]{24}$/.test(meta.tenantFingerprint) ||
          meta.tenantFingerprint !== entry.name
        ) {
          return null;
        }
        return {
          tenantFingerprint: meta.tenantFingerprint,
          root,
          metadata,
          eventLog: path.join(root, "events.jsonl"),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function organizationAuditContextForPath(filePath) {
  const resolved = path.resolve(filePath);
  return listOrganizationAuditQueueContexts().find((context) =>
    resolved.startsWith(`${path.resolve(context.root)}${path.sep}`)
  ) || null;
}

function organizationAuditDisposition(context) {
  if (!context) return "delete";
  if (telemetryStore.getGlobalDisabled()) return "pause";
  const current = currentTenantFingerprint();
  if (!current || current !== context.tenantFingerprint) return "delete";
  return credstore.isTelemetryTransmissionAllowed("") ? "send" : "delete";
}

function clearOrganizationAuditPayloads(context) {
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
  return removed;
}

function purgeOrganizationAuditQueues() {
  let removed = 0;
  for (const context of listOrganizationAuditQueueContexts()) {
    if (clearOrganizationAuditPayloads(context)) removed++;
  }
  return removed;
}

function purgeDisallowedOrganizationAuditQueues() {
  let removed = 0;
  for (const context of listOrganizationAuditQueueContexts()) {
    if (organizationAuditDisposition(context) !== "delete") continue;
    if (clearOrganizationAuditPayloads(context)) removed++;
  }
  return removed;
}

module.exports = {
  tenantFingerprint,
  currentOrganizationAuditContext,
  appendCaptureExcluded,
  listOrganizationAuditQueueContexts,
  organizationAuditContextForPath,
  organizationAuditDisposition,
  clearOrganizationAuditPayloads,
  purgeOrganizationAuditQueues,
  purgeDisallowedOrganizationAuditQueues,
};

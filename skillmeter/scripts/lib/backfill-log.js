/**
 * Privacy-safe structured diagnostics for the detached backfill pipeline.
 *
 * This log is local-only and intentionally excludes transcript content, local
 * paths, JWTs, device IDs, and backend endpoints. Each append is one NDJSON
 * record so the plugin monitor can tail it without owning the worker process.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { LOG_DIR } = require("./paths");

const BACKFILL_LOG_FILE = path.join(LOG_DIR, "backfill.ndjson");
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/;

function compactString(value, key) {
  let compact = value.replace(/[\r\n\t]/g, " ");
  if (key === "error") {
    compact = compact
      .replaceAll(os.homedir(), "[HOME]")
      .replace(/https?:\/\/\S+/gi, "[ENDPOINT]")
      .replace(/(?:\/[^ /\s:]+){2,}/g, "[PATH]");
  }
  return compact.slice(0, 300);
}

function compactValue(value, key = "") {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return compactString(value, key);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => compactValue(item, key));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([childKey, item]) => [
          childKey,
          compactValue(item, childKey),
        ])
        .filter(([, item]) => item !== undefined)
    );
  }
  return String(value).slice(0, 300);
}

function appendBackfillLog(event, details = {}) {
  if (!EVENT_RE.test(event)) return null;
  const record = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    event,
    pid: process.pid,
    ...compactValue(details),
  };
  try {
    fs.mkdirSync(path.dirname(BACKFILL_LOG_FILE), {
      recursive: true,
      mode: 0o700,
    });
    fs.appendFileSync(
      BACKFILL_LOG_FILE,
      JSON.stringify(record) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
    return record;
  } catch {
    return null;
  }
}

module.exports = {
  BACKFILL_LOG_FILE,
  appendBackfillLog,
};

/**
 * Sanitisation primitives for logs and transcripts. Consolidates the
 * previously-separate sanitizer.js module plus the tool-data path hashing
 * that used to live inline in logger.js.
 */

const crypto = require("crypto");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Deterministic Tier 1 / Tier 2 content sanitization (SANITIZATION_EPIC.md,
// 3-tier policy). Mirrors the SkillMeter Codex collector's detector library so
// both client surfaces scrub secrets identically. The harness-metadata feature
// (SBEE-165, Phase 2) routes its collected block through this boundary, and the
// `containsTier1` helper backs harness.js's fail-closed name scanning.
//
// Design rules drawn from the epic:
//   - Tier 1 is fail-closed: when a value looks like a secret we redact it.
//     Over-redacting is acceptable; leaking is not.
//   - We never store or log the original secret value — only its detector type,
//     tier, and the action taken.
//   - Detection is deterministic regex, with a small allow-list for obvious
//     placeholders to limit false positives without weakening recall.
// ---------------------------------------------------------------------------

const POLICY_VERSION = "1.0.0";

const SECRET_PLACEHOLDER = "[REDACTED_SECRET]";
const EMAIL_PLACEHOLDER = "[EMAIL]";

// Obvious non-secret stand-ins. A matched value that is exactly one of these
// (case-insensitive) is left in place so example/doc text and fixtures don't
// get needlessly redacted. Kept deliberately small — anything ambiguous errs
// toward redaction.
const PLACEHOLDER_ALLOWLIST = new Set([
  "example",
  "examples",
  "dummy",
  "test",
  "test-token",
  "testtoken",
  "placeholder",
  "redacted",
  "changeme",
  "your-token",
  "your-api-key",
  "your_api_key",
  "xxx",
  "xxxx",
  "xxxxxxxx",
  "none",
  "null",
  "undefined",
  "true",
  "false",
]);

function isPlaceholderValue(value) {
  if (!value) return true;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return true;
  if (PLACEHOLDER_ALLOWLIST.has(trimmed)) return true;
  // All-x / all-asterisk masks like "xxxxxxxxxxxx" or "************".
  if (/^[x*•]+$/i.test(trimmed)) return true;
  // Repeated single character (e.g. "aaaaaaaa") carries no real entropy.
  if (/^(.)\1{5,}$/.test(trimmed)) return true;
  return false;
}

// Tier 1 detectors. `value` describes which capture group holds the sensitive
// token: `whole` redacts the entire match; a number keeps the surrounding
// structure and redacts only that group (so `KEY=value` / `Authorization:`
// keep the field name/scheme while the credential is removed).
const TIER1_DETECTORS = [
  {
    type: "private_key",
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    value: "whole",
  },
  { type: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, value: "whole" },
  { type: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, value: "whole" },
  { type: "api_key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g, value: "whole" },
  { type: "api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, value: "whole" },
  { type: "aws_access_key", re: /\bA(?:KIA|SIA|IDA|GPA|ROA|NPA|NVA)[A-Z0-9]{16}\b/g, value: "whole" },
  { type: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, value: "whole" },
  {
    type: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    value: "whole",
  },
  {
    type: "database_url",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:/@]+:[^\s:/@]+@[^\s'"]+/g,
    value: "whole",
  },
  {
    type: "auth_header",
    re: /\b(Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    value: 2,
  },
  {
    type: "env_secret",
    re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|ACCESS[_-]?KEY|API[_-]?KEY))\s*[:=]\s*["']?([^\s"'`]{4,})["']?/gi,
    value: 2,
  },
];

// Tier 2 detectors (identity). Intentionally conservative: only emails, which
// are reliably detectable. Names / customer dictionaries are out of scope here.
const TIER2_DETECTORS = [
  {
    type: "email",
    tier: "tier2",
    placeholder: EMAIL_PLACEHOLDER,
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    value: "whole",
  },
];

/**
 * Scan a single string and redact every Tier 1 secret then Tier 2 identifier.
 * Returns `{ value, redactions }` where `redactions` is an array of
 * `{ type, tier, action }` events. Tier 1 runs first so a secret is removed
 * before the broader Tier 2 email pass can ever see it. No original secret
 * value is ever returned, logged, or stored.
 */
function redactString(input) {
  if (typeof input !== "string" || input.length === 0) {
    return { value: input, redactions: [] };
  }

  let value = input;
  const redactions = [];

  const runDetector = ({ type, re, value: group, placeholder, tier }) => {
    const replacement = placeholder || SECRET_PLACEHOLDER;
    re.lastIndex = 0;
    value = value.replace(re, (match, ...groups) => {
      const captures = groups.slice(0, -2);
      const candidate = group === "whole" ? match : captures[group - 1];
      if (isPlaceholderValue(candidate)) return match;

      redactions.push({ type, tier: tier || "tier1", action: "redacted" });

      if (group === "whole") return replacement;
      const idx = match.lastIndexOf(candidate);
      if (idx === -1) return replacement;
      return match.slice(0, idx) + replacement + match.slice(idx + candidate.length);
    });
  };

  for (const detector of TIER1_DETECTORS) runDetector(detector);
  for (const detector of TIER2_DETECTORS) runDetector(detector);

  return { value, redactions };
}

/**
 * True when a string contains at least one Tier 1 secret. Convenience wrapper
 * around redactString for fail-closed checks (used by harness name scanning).
 */
function containsTier1(input) {
  return redactString(input).redactions.some((r) => r.tier === "tier1");
}

/**
 * Recursively walk any value (string / array / object) and redact every string
 * leaf, accumulating redaction metadata. Keys are structural and never scanned;
 * non-string scalars pass through untouched.
 */
function redactDeep(value, redactions = []) {
  if (typeof value === "string") {
    const res = redactString(value);
    for (const r of res.redactions) redactions.push(r);
    return res.value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, redactions));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactDeep(val, redactions);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize an event-data object before it is logged/uploaded. Returns the
 * sanitized clone plus a compact metadata summary (`{ policyVersion, tier1,
 * tier2, types }`) — counts and detector types only, never original values.
 */
function sanitizeEventData(data) {
  const redactions = [];
  const value = redactDeep(data, redactions);
  const tier1 = redactions.filter((r) => r.tier === "tier1").length;
  const tier2 = redactions.filter((r) => r.tier === "tier2").length;
  const types = [...new Set(redactions.map((r) => r.type))].sort();
  return {
    value,
    redactions,
    meta: { policyVersion: POLICY_VERSION, tier1, tier2, types },
  };
}

/**
 * Hash a string using HMAC-SHA256 with salt (first 12 chars).
 * Matches the VS Code extension's HashingService.hash() so the same input
 * salt + string produces the same token across client surfaces.
 */
function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

// Keys in tool_input / tool_response whose values contain sensitive paths
// and should be HMAC-hashed before the event ships off the machine.
const PATH_KEYS = new Set(["file_path", "filePath", "path", "command"]);

/**
 * Sanitize a tool object by hashing path values.
 * Leaves non-path keys and non-string values untouched.
 */
function sanitizeToolData(obj, hashSalt) {
  if (!obj || typeof obj !== "object") return obj;

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (PATH_KEYS.has(key) && typeof val === "string") {
      result[key] = hashHmac(val, hashSalt);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Sanitize a single parsed transcript line by hashing the cwd field.
 */
function sanitizeLine(obj, hashSalt) {
  if (obj.cwd && typeof obj.cwd === "string") {
    obj.cwd = hashHmac(obj.cwd, hashSalt);
  }
  return obj;
}

/**
 * Sanitize a JSONL transcript file, returning the sanitized content as a
 * Buffer. Malformed lines are skipped individually so a single corrupt
 * entry (e.g. trailing partial line from a crashed writer) doesn't abort
 * the whole upload.
 */
function sanitizeTranscript(transcriptPath, hashSalt) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");
  const output = [];
  let malformed = 0;

  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      output.push(JSON.stringify(sanitizeLine(obj, hashSalt)));
    } catch {
      malformed++;
    }
  }

  if (malformed > 0) {
    process.stderr.write(
      `[skillmeter] transcript: dropped ${malformed} malformed line(s) during sanitize\n`
    );
  }

  return Buffer.from(output.join("\n") + "\n", "utf8");
}

module.exports = {
  PATH_KEYS,
  POLICY_VERSION,
  SECRET_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  hashHmac,
  redactString,
  containsTier1,
  redactDeep,
  sanitizeEventData,
  sanitizeToolData,
  sanitizeLine,
  sanitizeTranscript,
};

/**
 * Sanitisation primitives for logs and transcripts.
 *
 * Two orthogonal protections, applied together by the scrub helpers:
 *   1. Content redaction — secrets (credentials) and PII (emails) are matched by
 *      the unified rule table in ./rules.js and replaced with placeholders.
 *   2. Path hashing — the user's home-directory prefix (which carries the OS
 *      username) is HMAC-hashed everywhere it appears, and known path-bearing
 *      tool fields are hashed wholesale.
 *
 * Design rules:
 *   - Fail-closed: when a value looks like a secret we redact it. Over-redacting
 *     is acceptable; leaking is not.
 *   - We never store or log an original secret value — only its detector id,
 *     category, and the action taken.
 *   - Detection is deterministic regex + Shannon-entropy gating, with a small
 *     stopword allow-list to limit false positives without weakening recall.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

const { RULES, STOPWORDS, SECRET_PLACEHOLDER } = require("./rules");

// Bump when the detection policy (rules, entropy gating, path hashing) changes
// in a way analysis consumers should be able to distinguish.
const POLICY_VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Content redaction
// ---------------------------------------------------------------------------

/**
 * Shannon entropy (bits per character) of a string. Used to reject low-entropy
 * false positives for rules that opt in via a numeric `entropy` floor.
 */
function shannonEntropy(str) {
  if (!str) return 0;
  const freq = Object.create(null);
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  const len = str.length;
  for (const ch in freq) {
    const p = freq[ch] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * True for obvious non-secret stand-ins: a stopword, an all-mask string
 * (xxxx / ****), or empty. Such captures are left in place.
 */
function isStopword(value) {
  if (!value) return true;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return true;
  if (STOPWORDS.has(trimmed)) return true;
  if (/^[x*•]+$/i.test(trimmed)) return true;
  return false;
}

/**
 * Scan a single string against every rule and redact matches. Rules run in
 * table order (secrets before the broad email pass). Returns `{ value,
 * redactions }` where each redaction is `{ id, category, action:"redacted" }`.
 * No original secret value is ever returned, logged, or stored.
 */
function redactString(input) {
  if (typeof input !== "string" || input.length === 0) {
    return { value: input, redactions: [] };
  }

  let value = input;
  const redactions = [];
  const lower = input.toLowerCase();

  for (const rule of RULES) {
    // Cheap keyword pre-filter: skip a rule whose trigger substrings are absent.
    if (rule.keywords && !rule.keywords.some((k) => lower.includes(k))) continue;

    rule.re.lastIndex = 0;
    value = value.replace(rule.re, (match, ...groups) => {
      const captures = groups.slice(0, -2);
      const candidate = rule.group ? captures[rule.group - 1] : match;
      if (candidate == null) return match;
      if (isStopword(candidate)) return match;
      if (rule.entropy && shannonEntropy(candidate) < rule.entropy) return match;

      redactions.push({ id: rule.id, category: rule.category, action: "redacted" });

      if (!rule.group) return rule.replacement;
      const idx = match.lastIndexOf(candidate);
      if (idx === -1) return rule.replacement;
      return (
        match.slice(0, idx) + rule.replacement + match.slice(idx + candidate.length)
      );
    });
  }

  return { value, redactions };
}

/**
 * True when a string contains at least one secret (not just PII).
 * Convenience wrapper around redactString for fail-closed checks (used by
 * harness.js name scanning to drop identifiers that embed a credential).
 */
function containsSecret(input) {
  return redactString(input).redactions.some((r) => r.category === "secret");
}

// Field names that should force secret redaction on their string values, even
// when the value doesn't match a pattern (context from structured JSON such as
// MCP env blocks or tool inputs). Precise and low false-positive in the
// object-key position, so retained as a complement to the pattern rules.
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /credentials?/i,
  // Anchored so "author"/"authored_by"/"author_email" are NOT force-redacted;
  // still matches "auth", "authToken", and "authorization"/"authorize".
  /\bauth(?:\b|oriz)/i,
  /bearer/i,
  /access[_-]?key/i,
];

function isSecretKey(key) {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

// ---------------------------------------------------------------------------
// Path hashing
// ---------------------------------------------------------------------------

/**
 * Hash a string using HMAC-SHA256 with salt (first 12 hex chars). Matches the
 * VS Code extension's HashingService.hash() so the same salt + input yields the
 * same token across client surfaces.
 */
function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Keys whose string values are paths and are HMAC-hashed WHOLESALE (structure
// removed) wherever they appear — including nested occurrences, since scrubDeep
// applies this at every depth. `command` is deliberately NOT here: it is scrubbed
// as content instead, so command shape is preserved while secrets are redacted.
const PATH_KEYS = new Set(["file_path", "filePath", "path", "notebook_path", "cwd"]);

// Precompute the home-directory prefix matcher once. The OS home path carries
// the username and appears throughout transcript content, tool commands, and
// file paths — hashing the prefix removes the identity while keeping the
// relative structure below it intact for analysis.
const HOME_DIR = os.homedir();
const HOME_DIR_RE =
  HOME_DIR && HOME_DIR !== "/" ? new RegExp(escapeRegExp(HOME_DIR), "g") : null;

// Memoize the home-dir HMAC per salt — the home dir is constant per process, so
// this avoids re-hashing it for every string leaf of a large transcript.
let homeHashMemo = { salt: null, hash: "" };

/**
 * Replace every occurrence of the user's home-directory prefix with its HMAC
 * hash. No-op when no salt is available (redaction still runs; only the
 * path-identity hashing is skipped).
 */
function hashHomePaths(str, hashSalt) {
  if (!hashSalt || !HOME_DIR_RE || typeof str !== "string") return str;
  if (!str.includes(HOME_DIR)) return str;
  if (homeHashMemo.salt !== hashSalt) {
    homeHashMemo = { salt: hashSalt, hash: hashHmac(HOME_DIR, hashSalt) };
  }
  return str.replace(HOME_DIR_RE, homeHashMemo.hash);
}

// ---------------------------------------------------------------------------
// Combined content-scrub (redaction + home-path hashing)
// ---------------------------------------------------------------------------

/**
 * The single string-scrub primitive: redact secrets/PII, then hash the home
 * path. Used by every upload path (event log, transcript, harness metadata).
 */
function scrubString(str, hashSalt, redactions) {
  if (typeof str !== "string" || str.length === 0) return str;
  const res = redactString(str);
  if (redactions) for (const r of res.redactions) redactions.push(r);
  return hashHomePaths(res.value, hashSalt);
}

/**
 * Recursively walk any value and scrub every string leaf. Object keys provide
 * context: a secret-labelled key forces redaction of its string value even if
 * the value matches no pattern. Non-string scalars pass through untouched.
 */
function scrubDeep(value, hashSalt, redactions = [], parentKey = null) {
  if (typeof value === "string") {
    // Secret-labelled key → force redaction regardless of the value's content.
    if (parentKey && isSecretKey(parentKey) && !isStopword(value)) {
      redactions.push({ id: "labelled-secret", category: "secret", action: "redacted" });
      return SECRET_PLACEHOLDER;
    }
    // Path-bearing key → HMAC-hash the whole value (covers nested paths too).
    if (parentKey && PATH_KEYS.has(parentKey)) {
      return hashHmac(value, hashSalt);
    }
    return scrubString(value, hashSalt, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, hashSalt, redactions, parentKey));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      // Keys can themselves be sensitive — some transcript entries use absolute
      // file paths as map keys, which carry the home-dir/username. Scrub the key
      // (redact + home-path hash) but decide `isSecretKey` value-forcing from the
      // ORIGINAL key name.
      const scrubbedKey = scrubString(key, hashSalt);
      out[scrubbedKey] = scrubDeep(val, hashSalt, redactions, key);
    }
    return out;
  }
  return value;
}

/**
 * Scrub an event-data object before it is logged/uploaded. Returns the scrubbed
 * clone plus a compact metadata summary (`{ policyVersion, secrets, pii, ids }`)
 * — counts and detector ids only, never original values.
 */
function sanitizeEventData(data, hashSalt) {
  const redactions = [];
  const value = scrubDeep(data, hashSalt, redactions);
  const secrets = redactions.filter((r) => r.category === "secret").length;
  const pii = redactions.filter((r) => r.category === "pii").length;
  const ids = [...new Set(redactions.map((r) => r.id))].sort();
  return {
    value,
    redactions,
    meta: { policyVersion: POLICY_VERSION, secrets, pii, ids },
  };
}

// ---------------------------------------------------------------------------
// Transcript helper
// ---------------------------------------------------------------------------

/**
 * Sanitize a single parsed transcript line by scrubbing the whole object:
 * secret/PII redaction + home-path hashing on content, and wholesale HMAC of
 * path-bearing keys (incl. `cwd`) via scrubDeep's PATH_KEYS branch. Returns a
 * scrubbed copy; the input is not mutated.
 */
function sanitizeLine(obj, hashSalt) {
  return scrubDeep(obj, hashSalt);
}

/**
 * Sanitize a JSONL transcript file, returning the sanitized content as a
 * Buffer. Malformed lines are skipped individually so a single corrupt entry
 * (e.g. a trailing partial line from a crashed writer) doesn't abort the whole
 * upload.
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
  POLICY_VERSION,
  hashHmac,
  redactString,
  containsSecret,
  scrubString,
  scrubDeep,
  sanitizeEventData,
  sanitizeLine,
  sanitizeTranscript,
};

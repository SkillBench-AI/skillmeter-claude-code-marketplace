/**
 * Sanitisation primitives for logs and transcripts.
 *
 * Two orthogonal protections, applied together by the scrub helpers:
 *   1. Content redaction — secrets (credentials) and the stage-1 PII categories
 *      (email, VCS author names, phone, IP, national id, payment card) are
 *      matched by the unified rule table in ./rules.js and replaced with typed
 *      placeholders: the category survives, the value does not.
 *   2. Path hashing — the user's home-directory prefix (which carries the OS
 *      username) is HMAC-hashed everywhere it appears, and known path-bearing
 *      tool fields are hashed wholesale, with the file extension and directory
 *      depth recorded as separate fields before hashing.
 *
 * Design rules (ADR 002):
 *   - Fail-closed: when a value looks like a secret we redact it. Over-redacting
 *     is acceptable; leaking is not.
 *   - We never store or log an original secret value — only its detector id,
 *     category, and the action taken.
 *   - Detection is deterministic regex + Shannon-entropy gating + format
 *     validators, with a small stopword allow-list to limit false positives
 *     without weakening recall.
 *   - Idempotent: a placeholder is never re-matched, so sanitizing already
 *     sanitized data changes nothing and adds no redaction counts.
 *   - Key-name forced redaction applies to identifier-like keys only; free-text
 *     keys (questions, labels) are scrubbed by content rules alone.
 */

const crypto = require("crypto");
const os = require("os");
const path = require("path");

const { RULES, STOPWORDS, KINDS, PLACEHOLDER_RE, SECRET_PLACEHOLDER } = require("./rules");

// Bump when the detection policy (rules, entropy gating, path hashing) changes
// in a way analysis consumers should be able to distinguish. 3.0.0 = ADR 002
// stage 1: typed PII placeholders, idempotency, identifier-only key heuristic,
// path features, per-record reporting.
const POLICY_VERSION = "3.0.0";

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
 * True when a value is exactly one of the policy's placeholders (`[EMAIL]`,
 * `[REDACTED_SECRET]`, ...). Such values are never re-matched or force-redacted,
 * which makes sanitization idempotent.
 */
function isPlaceholder(value) {
  return typeof value === "string" && PLACEHOLDER_RE.test(value.trim());
}

/**
 * Scan a single string against every rule and redact matches. Rules run in
 * table order (secrets first, then the PII rules). Returns `{ value,
 * redactions }` where each redaction is `{ id, category, kind,
 * action:"redacted" }`. No original secret value is ever returned, logged, or
 * stored.
 */
function redactString(input) {
  if (typeof input !== "string" || input.length === 0) {
    return { value: input, redactions: [] };
  }
  if (isPlaceholder(input)) return { value: input, redactions: [] };

  let value = input;
  const redactions = [];
  const lower = input.toLowerCase();

  for (const rule of RULES) {
    // Cheap pre-filters: skip a rule whose trigger substrings are absent, or
    // whose digit shape does not occur in the string at all.
    if (rule.keywords && !rule.keywords.some((k) => lower.includes(k))) continue;
    if (rule.precheck && !rule.precheck.test(input)) continue;

    rule.re.lastIndex = 0;
    value = value.replace(rule.re, (match, ...groups) => {
      const captures = groups.slice(0, -2);
      const candidate = rule.group ? captures[rule.group - 1] : match;
      if (candidate == null) return match;
      if (isStopword(candidate) || isPlaceholder(candidate)) return match;
      if (rule.entropy && shannonEntropy(candidate) < rule.entropy) return match;
      if (rule.validate && !rule.validate(candidate)) return match;

      redactions.push({
        id: rule.id,
        category: rule.category,
        kind: rule.kind || rule.category,
        action: "redacted",
      });

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

// The key heuristic exists for structured inputs (env blocks, tool parameters,
// config objects) whose keys are identifiers. Free-text keys — Claude Code
// stores AskUserQuestion answers keyed by the question sentence — are excluded,
// so a question containing "authorized" no longer redacts its answer
// (ADR 002, decision 4). Free-text keys and their values still go through the
// content rules.
const IDENTIFIER_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function isIdentifierKey(key) {
  return typeof key === "string" && IDENTIFIER_KEY_RE.test(key);
}

function isSecretKey(key) {
  return isIdentifierKey(key) && SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
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

/**
 * True when a record already carries this module's `_sanitization` metadata,
 * which is the provenance signal that it has been through a pass. Path values
 * in such a record are not hashed again and no path features are added, so a
 * second pass is a no-op. Provenance rather than value shape is used on
 * purpose: a raw relative path that happens to be twelve hex characters must
 * still be hashed.
 */
function hasSanitizationMarker(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      obj._sanitization &&
      typeof obj._sanitization === "object" &&
      typeof obj._sanitization.policyVersion === "string"
  );
}

const FRESH = Object.freeze({ rehash: true });

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Keys whose string values are paths and are HMAC-hashed WHOLESALE (structure
// removed) wherever they appear — including nested occurrences, since scrubDeep
// applies this at every depth. `command` is deliberately NOT here: it is scrubbed
// as content instead, so command shape is preserved while secrets are redacted.
const PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "cwd",
  "old_cwd",
  "new_cwd",
]);

// Path keys that name files. Their extension and depth are recorded beside the
// hash (ADR 002, decision 4). The cwd family names directories, feeds the
// allow-listed exclusion-audit record, and stays hash-only.
const FILE_KEYS = new Set(["file_path", "filePath", "path", "notebook_path"]);

/**
 * Coarse, non-identifying features of a file path, recorded next to the hash
 * so analysis can keep extension and depth statistics without the path
 * itself: `depth` = number of segments, `ext` = lowercase extension without
 * the dot (empty for dotfiles and extension-less names).
 */
function pathFeatures(p) {
  const segments = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
  const base = segments.length ? segments[segments.length - 1] : "";
  let ext = "";
  if (base && !base.startsWith(".")) {
    const raw = path.posix.extname(base).slice(1).toLowerCase();
    if (/^[a-z0-9]{1,10}$/.test(raw)) ext = raw;
  }
  return { depth: segments.length, ext };
}

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
function scrubDeep(value, hashSalt, redactions = [], parentKey = null, opts = FRESH) {
  if (typeof value === "string") {
    // Secret-labelled identifier key → force redaction regardless of the
    // value's content, unless the value is already a placeholder.
    if (parentKey && isSecretKey(parentKey) && !isStopword(value) && !isPlaceholder(value)) {
      redactions.push({
        id: "labelled-secret",
        category: "secret",
        kind: "secret",
        action: "redacted",
      });
      return SECRET_PLACEHOLDER;
    }
    // Path-bearing key → HMAC-hash the whole value (covers nested paths too).
    // A record that already carries `_sanitization` has been through this
    // once; its path values are hashes and are left alone.
    if (parentKey && PATH_KEYS.has(parentKey)) {
      return opts.rehash ? hashHmac(value, hashSalt) : value;
    }
    return scrubString(value, hashSalt, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, hashSalt, redactions, parentKey, opts));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      // Keys can themselves be sensitive — some transcript entries use absolute
      // file paths as map keys, which carry the home-dir/username. Scrub the key
      // (redact + home-path hash) but decide `isSecretKey` value-forcing from the
      // ORIGINAL key name.
      const scrubbedKey = scrubString(key, hashSalt);
      out[scrubbedKey] = scrubDeep(val, hashSalt, redactions, key, opts);
      // A string under a file-path key is hashed above; record its coarse
      // features beside the hash (never clobbering a field the source has).
      if (opts.rehash && FILE_KEYS.has(key) && typeof val === "string" && val) {
        const { depth, ext } = pathFeatures(val);
        const depthKey = `${key}_depth`;
        const extKey = `${key}_ext`;
        if (!(depthKey in value)) out[depthKey] = depth;
        if (ext && !(extKey in value)) out[extKey] = ext;
      }
    }
    return out;
  }
  return value;
}

/**
 * Tally redaction events into the `_sanitization` metadata: policy version,
 * secret/PII totals, a per-category count map with every category present,
 * and the sorted detector ids. Counts and ids only, never original values.
 */
function summarizeRedactions(redactions) {
  const counts = {};
  for (const k of KINDS) counts[k] = 0;
  let secrets = 0;
  let pii = 0;
  for (const r of redactions) {
    if (r.category === "secret") secrets++;
    else if (r.category === "pii") pii++;
    const kind = r.kind || r.category;
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const ids = [...new Set(redactions.map((r) => r.id))].sort();
  return { policyVersion: POLICY_VERSION, secrets, pii, counts, ids };
}

/**
 * Scrub a record and, when it is a plain object, stamp the metadata summary
 * (`{ policyVersion, secrets, pii, counts, ids }`) on it as `_sanitization`.
 * The stamp goes on every record, including when nothing was redacted, so
 * redaction rates per category are a plain query downstream, and it is the
 * provenance a later pass reads to leave hashes alone. A record that already
 * carries a stamp keeps it: the stamp describes the pass that saw the raw
 * data, and a re-run adds nothing.
 */
function sanitizeRecord(record, hashSalt) {
  const redactions = [];
  const marked = hasSanitizationMarker(record);
  const value = scrubDeep(record, hashSalt, redactions, null, { rehash: !marked });
  const meta = summarizeRedactions(redactions);
  if (value && typeof value === "object" && !Array.isArray(value) && !marked) {
    value._sanitization = meta;
  }
  return { value, redactions, meta };
}

/**
 * Scrub an event-data object before it is logged/uploaded. Returns the scrubbed
 * clone (stamped with `_sanitization`) plus the metadata summary.
 */
function sanitizeEventData(data, hashSalt) {
  return sanitizeRecord(data, hashSalt);
}

// ---------------------------------------------------------------------------
// Transcript helper
// ---------------------------------------------------------------------------

/**
 * Sanitize a single parsed transcript line by scrubbing the whole object:
 * secret/PII redaction + home-path hashing on content, and wholesale HMAC of
 * path-bearing keys (incl. `cwd`) via scrubDeep's PATH_KEYS branch. The line
 * is stamped with `_sanitization` like every other record. Returns a scrubbed
 * copy; the input is not mutated.
 */
function sanitizeLine(obj, hashSalt) {
  return sanitizeRecord(obj, hashSalt).value;
}

module.exports = {
  POLICY_VERSION,
  hashHmac,
  redactString,
  containsSecret,
  scrubString,
  sanitizeEventData,
  sanitizeLine,
  summarizeRedactions,
  pathFeatures,
  isPlaceholder,
  isSecretKey,
  hasSanitizationMarker,
};

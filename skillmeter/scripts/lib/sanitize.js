/**
 * Apply the on-device policy in ADR002: typed secret/PII redaction and HMAC paths.
 * File-path fields keep structure, extensions and technical vocabulary; directory
 * fields and generic path keys are hashed whole. Free text hashes the home prefix.
 *
 * Placeholders are not redacted again. Path values are hashed on every pass;
 * their shape does not prove prior sanitization. Forced key-name redaction applies
 * only to identifier-like keys. Metadata records counts/types, not matched values.
 */

const crypto = require("crypto");
const os = require("os");

const { RULES, STOPWORDS, KINDS, PLACEHOLDER_RE, SECRET_PLACEHOLDER } = require("./rules");
const VOCABULARY = require("./path-vocabulary.json");

// Bump when the detection policy (rules, entropy gating, path hashing) changes
// in a way analysis consumers should be able to distinguish. 3.0.0 = ADR 002
// stage 1: typed PII placeholders, idempotency, identifier-only key heuristic,
// per-record reporting. 3.1.0 = segment-wise hashing of file-path fields with
// the shared vocabulary, and `counts.path` (ADR 002 amendment, decision 6).
// 3.1.1 preserves distinct entries whose object keys redact to the same string.
const POLICY_VERSION = "3.1.1";

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
 * True when a record already carries this module's `_sanitization` metadata.
 * The stamp describes the pass that saw the raw data and is kept as is on a
 * later pass. It does not gate any transformation: value shape is never used
 * as provenance, so a later pass hashes path values again (a hash of a hash
 * discloses nothing) while placeholders, being fixed literals, are left alone.
 */
function hasSanitizationMarker(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      obj._sanitization &&
      typeof obj._sanitization === "object" &&
      typeof obj._sanitization.policyVersion === "string" &&
      /^\d+\.\d+\.\d+$/.test(obj._sanitization.policyVersion)
  );
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Keys whose string values are filesystem paths. Two treatments:
//   - SEGMENT_KEYS (the keys Claude Code's own file tools use) are hashed per
//     segment: structure, extension and shared-vocabulary segments survive,
//     every other segment becomes its own HMAC (ADR 002 amendment, decision 6).
//   - WHOLE_KEYS are hashed wholesale: `cwd` and friends identify a directory
//     for the audit record and correlation; the generic `path` key appears in
//     arbitrary tool/MCP payloads where it may be an API route, not a file.
// `command` is deliberately in neither set: it is scrubbed as content, so the
// command shape is preserved while secrets are redacted and the home prefix
// is hashed.
const SEGMENT_KEYS = new Set(["file_path", "filePath", "notebook_path"]);
const WHOLE_KEYS = new Set(["path", "cwd", "old_cwd", "new_cwd"]);
const PATH_KEYS = new Set([...SEGMENT_KEYS, ...WHOLE_KEYS]);

// Every HMAC applied to a path element is tallied under `counts.path`. It is a
// transformation, not a detection, so it carries no detector id.
const PATH_HASH = Object.freeze({ id: "path-hash", category: "path", kind: "path", action: "hashed" });

// Precompute the home-directory prefix matcher once. The OS home path carries
// the username and appears throughout transcript content, tool commands, and
// file paths — hashing the prefix removes the identity while keeping the
// relative structure below it intact for analysis.
const HOME_DIR = os.homedir();
const HOME_DIR_RE =
  HOME_DIR && HOME_DIR !== "/" ? new RegExp(escapeRegExp(HOME_DIR), "g") : null;
const HOME_DIR_NORM = HOME_DIR ? HOME_DIR.replace(/\\/g, "/") : "";

// Memoize the home-dir HMAC per salt — the home dir is constant per process, so
// this avoids re-hashing it for every string leaf of a large transcript.
let homeHashMemo = { salt: null, hash: "" };

function homeHash(hashSalt) {
  if (homeHashMemo.salt !== hashSalt) {
    homeHashMemo = { salt: hashSalt, hash: hashHmac(HOME_DIR, hashSalt) };
  }
  return homeHashMemo.hash;
}

/**
 * Replace every occurrence of the user's home-directory prefix with its HMAC
 * hash, counting each replacement under `counts.path`. No-op when no salt is
 * available (redaction still runs; only the path-identity hashing is skipped).
 */
function hashHomePaths(str, hashSalt, redactions) {
  if (!hashSalt || !HOME_DIR_RE || typeof str !== "string") return str;
  if (!str.includes(HOME_DIR)) return str;
  const hash = homeHash(hashSalt);
  return str.replace(HOME_DIR_RE, () => {
    if (redactions) redactions.push(PATH_HASH);
    return hash;
  });
}

// ---------------------------------------------------------------------------
// Segment-wise path hashing (shared vocabulary)
// ---------------------------------------------------------------------------

const DIR_VOCAB = new Set(VOCABULARY.directories.map((s) => s.toLowerCase()));
const FILE_VOCAB = new Set(VOCABULARY.files.map((s) => s.toLowerCase()));
const COMPOUND_EXTS = VOCABULARY.compound_extensions
  .map((s) => s.toLowerCase())
  .sort((a, b) => b.length - a.length);
const VERSION_RE = new RegExp(VOCABULARY.version_pattern);
const STRUCTURAL_RE = new RegExp(VOCABULARY.structural_pattern);
const SIMPLE_EXT_RE = /^\.[A-Za-z0-9]{1,10}$/;

/** A segment kept in clear: shared vocabulary, version-like, or structural. */
function isClearSegment(seg) {
  const lower = seg.toLowerCase();
  return DIR_VOCAB.has(lower) || FILE_VOCAB.has(lower) || VERSION_RE.test(seg) || STRUCTURAL_RE.test(seg);
}

/** Split a file name into base and extension; dotfiles have no extension. */
function splitExtension(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith(".")) return { base: name, ext: "" };
  for (const ce of COMPOUND_EXTS) {
    if (lower.length > ce.length && lower.endsWith(ce)) {
      return { base: name.slice(0, -ce.length), ext: name.slice(-ce.length) };
    }
  }
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return { base: name, ext: "" };
  const ext = name.slice(i);
  if (!SIMPLE_EXT_RE.test(ext)) return { base: name, ext: "" };
  return { base: name.slice(0, i), ext };
}

/**
 * Hash a filesystem path segment by segment. The home-directory prefix is one
 * unit (the same HMAC used inside free text); every other segment is hashed
 * individually unless it is on the shared vocabulary list, version-like or
 * structural; the last segment keeps its extension. Separators are preserved,
 * so depth and hierarchy stay readable and two paths that share a directory
 * share its hashed segment.
 *
 *   /Users/jane/work/acme-portal/src/billing/invoice-acme.ts
 *   → 000687bf6f7f/7788990011aa/2a1b3c4d5e6f/src/billing/1122334455aa.ts
 */
function hashPathSegments(p, hashSalt, redactions) {
  if (!hashSalt) return "";
  let rest = String(p).replace(/\\/g, "/");
  let prefix = "";
  if (
    HOME_DIR_NORM &&
    HOME_DIR_NORM !== "/" &&
    rest.startsWith(HOME_DIR_NORM) &&
    (rest.length === HOME_DIR_NORM.length || rest[HOME_DIR_NORM.length] === "/")
  ) {
    prefix = homeHash(hashSalt);
    if (redactions) redactions.push(PATH_HASH);
    rest = rest.slice(HOME_DIR_NORM.length);
  }
  // Root and trailing separators are structure and are kept: one leading
  // slash for POSIX absolute paths, two for UNC paths (`\\host\share`), and a
  // trailing slash on a directory path. Repeated inner separators collapse.
  const leading = rest.startsWith("//") ? "//" : rest.startsWith("/") ? "/" : "";
  const trailing = rest.length > leading.length && rest.endsWith("/") ? "/" : "";
  const segments = rest.split("/").filter(Boolean);
  const out = segments.map((seg, i) => {
    if (isClearSegment(seg)) return seg;
    if (i === segments.length - 1 && !trailing) {
      const { base, ext } = splitExtension(seg);
      if (redactions) redactions.push(PATH_HASH);
      return hashHmac(base, hashSalt) + ext;
    }
    if (redactions) redactions.push(PATH_HASH);
    return hashHmac(seg, hashSalt);
  });
  const joined = out.join("/") + (out.length ? trailing : "");
  if (prefix) {
    // `${HOME}` → hash; `${HOME}/` → hash followed by the directory marker.
    if (!joined) return leading ? `${prefix}/` : prefix;
    return `${prefix}/${joined}`;
  }
  return leading + joined;
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
  return hashHomePaths(res.value, hashSalt, redactions);
}

/**
 * Recursively walk any value and scrub every string leaf. Object keys provide
 * context: a secret-labelled key forces redaction of its string value even if
 * the value matches no pattern. Non-string scalars pass through untouched.
 */
function scrubDeep(value, hashSalt, redactions = [], parentKey = null) {
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
    // File-path key → segment-wise hash (structure and vocabulary kept). Always
    // applied: a value's shape is never taken as proof that it was hashed
    // before, so a raw path can never be preserved by looking like a hash.
    if (parentKey && SEGMENT_KEYS.has(parentKey)) {
      return hashPathSegments(value, hashSalt, redactions);
    }
    // Directory / generic path key → HMAC-hash the whole value, always.
    if (parentKey && WHOLE_KEYS.has(parentKey)) {
      // Count only when a hash is actually produced (hashHmac yields "" for an
      // empty value or a missing salt).
      if (hashSalt && value) redactions.push(PATH_HASH);
      return hashHmac(value, hashSalt);
    }
    return scrubString(value, hashSalt, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, hashSalt, redactions, parentKey));
  }
  if (value && typeof value === "object") {
    const out = {};
    const entries = Object.entries(value).map(([key, val]) => ({
      key, val, scrubbedKey: scrubString(key, hashSalt, redactions),
    }));
    // Reserve every scrubbed input key before allocating suffixes, including
    // literal keys that already look like generated disambiguators.
    const reserved = new Set(entries.map(entry => entry.scrubbedKey));
    const nextOrdinal = new Map();
    for (const { key, val, scrubbedKey } of entries) {
      let outputKey = scrubbedKey;
      if (Object.hasOwn(out, outputKey)) {
        const basename = scrubbedKey.slice(Math.max(scrubbedKey.lastIndexOf("/"), scrubbedKey.lastIndexOf("\\")) + 1);
        const { ext } = splitExtension(basename);
        const stem = scrubbedKey.slice(0, scrubbedKey.length - ext.length);
        let ordinal = nextOrdinal.get(scrubbedKey) || 2;
        do {
          outputKey = `${stem}[key-${ordinal++}]${ext}`;
        } while (reserved.has(outputKey));
        nextOrdinal.set(scrubbedKey, ordinal);
        reserved.add(outputKey);
      }
      // Define data properties so a JSON key such as __proto__ cannot invoke a
      // setter. Value-forcing still uses the original, unsanitized key name.
      Object.defineProperty(out, outputKey, {
        value: scrubDeep(val, hashSalt, redactions, key),
        enumerable: true, configurable: true, writable: true,
      });
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
  // Detector ids only: path hashing is a transformation and would otherwise
  // appear on nearly every record.
  const ids = [...new Set(redactions.filter((r) => r.category !== "path").map((r) => r.id))].sort();
  return { policyVersion: POLICY_VERSION, secrets, pii, counts, ids };
}

/**
 * Scrub a record and, when it is a plain object, stamp the metadata summary
 * (`{ policyVersion, secrets, pii, counts, ids }`) on it as `_sanitization`.
 * The stamp goes on every record, including when nothing was redacted, so
 * redaction rates per category are a plain query downstream. A record that
 * already carries a stamp keeps it: the stamp describes the pass that saw the
 * raw data. Content is idempotent (placeholders are never re-matched); path
 * values are hashed on every pass, so a second pass yields a hash of a hash
 * rather than trusting the value's shape.
 */
function sanitizeRecord(record, hashSalt) {
  const redactions = [];
  const marked = hasSanitizationMarker(record);
  const value = scrubDeep(record, hashSalt, redactions);
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
 * Sanitize a parsed transcript record without mutating the input.
 * Apply content redaction and field-specific path hashing, then attach
 * _sanitization metadata as for hook events.
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
  isPlaceholder,
  isSecretKey,
  hasSanitizationMarker,
  hashPathSegments,
  splitExtension,
  isClearSegment,
};

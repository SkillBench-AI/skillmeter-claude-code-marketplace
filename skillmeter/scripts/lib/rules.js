/**
 * Secret / PII detection rules.
 *
 * The secret patterns below are ported from the Gitleaks default ruleset
 * (https://github.com/gitleaks/gitleaks, config/gitleaks.toml), which is MIT
 * licensed. See the repo `NOTICE` for attribution. Gitleaks patterns target
 * Go's RE2 engine, which is a strict subset of JavaScript's regex syntax
 * (no lookaround / backreferences), so porting is mechanical: a leading `(?i)`
 * inline flag is dropped and expressed as the RegExp `i` flag instead.
 *
 * Each rule:
 *   - id          unique detector name (reported in redaction metadata)
 *   - category    "secret" (credentials) | "pii" (identity)
 *   - re          global-flagged RegExp
 *   - keywords    optional lowercase substrings; the rule is skipped unless the
 *                 scanned string contains one of them (cheap pre-filter)
 *   - entropy     optional Shannon-entropy floor; a candidate whose entropy is
 *                 below this is treated as a false positive and left in place
 *   - group       optional 1-based capture group holding the secret (keeps the
 *                 surrounding structure, e.g. `KEY=` / `Authorization:`, intact)
 *   - replacement the literal that replaces a matched secret
 *   - kind        optional placeholder category reported in `_sanitization.counts`
 *                 (defaults to `category`; PII rules set email / person / phone /
 *                 ip / id_number / card)
 *   - precheck    optional non-global RegExp; the rule is skipped unless the
 *                 scanned string matches it (cheap pre-filter for digit-based
 *                 rules that have no fixed keyword)
 *   - validate    optional predicate on the candidate; a candidate it rejects is
 *                 left in place (format checks a regex cannot express, e.g. Luhn)
 *
 * Rules are deliberately curated (high-signal vendors + a couple of structural
 * catch-alls), not the full ~200-rule Gitleaks set: the long tail is noisy
 * without Gitleaks' per-rule allowlist machinery, and this client scrubs on
 * hot paths where fewer, sharper rules matter more than exhaustive recall.
 */

const SECRET_PLACEHOLDER = "[REDACTED_SECRET]";
const EMAIL_PLACEHOLDER = "[EMAIL]";
const PERSON_PLACEHOLDER = "[PERSON]";
const PHONE_PLACEHOLDER = "[PHONE]";
const IP_PLACEHOLDER = "[IP]";
const ID_NUMBER_PLACEHOLDER = "[ID_NUMBER]";
const CARD_PLACEHOLDER = "[CARD]";

// Every placeholder this policy (stage 1) or the server-side stage 2 can emit.
// A candidate or value that is exactly one of these is never re-matched and is
// never force-redacted by key name, which keeps sanitization idempotent
// (ADR 002, decision 4). The guard trusts placeholder shape, not provenance.
const PLACEHOLDER_RE =
  /^\[(?:REDACTED_[A-Z_]+|EMAIL|PERSON|PHONE|IP|ID_NUMBER|CARD|ADDRESS|CUSTOMER|ORG)\]$/;

// Placeholder categories reported in `_sanitization.counts`, in this order, so
// the metadata has a stable shape (every key present, zero when nothing hit).
// `path` counts HMACs applied to path elements (hashed segments, whole-value
// hashes, home-prefix replacements in text); it is neither a secret nor PII.
const KINDS = ["secret", "email", "person", "phone", "ip", "id_number", "card", "path"];

// ---------------------------------------------------------------------------
// Validators for the digit-based PII rules (format checks a regex cannot do)
// ---------------------------------------------------------------------------

const digitsOf = (s) => s.replace(/\D/g, "");

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Issuer identification ranges of the major card networks. A 13-19 digit
// Luhn-valid number outside these ranges (invoice numbers, millisecond
// timestamps, tracking ids) is left in place.
function knownCardIssuer(d) {
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  if (d[0] === "4") return true; // Visa
  if (p2 >= 51 && p2 <= 55) return true; // Mastercard
  if (p4 >= 2221 && p4 <= 2720) return true; // Mastercard 2-series
  if (p2 === 34 || p2 === 37) return true; // American Express
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)) return true; // Discover
  if (p4 >= 3528 && p4 <= 3589) return true; // JCB
  return false;
}

// Lengths each network actually issues. A Luhn-valid 17-digit number with a
// leading 4 is not a Visa card.
function issuerLengthOk(d) {
  const n = d.length;
  const p2 = Number(d.slice(0, 2));
  const p4 = Number(d.slice(0, 4));
  if (d[0] === "4") return n === 13 || n === 16 || n === 19; // Visa
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return n === 16; // Mastercard
  if (p2 === 34 || p2 === 37) return n === 15; // American Express
  return n >= 16 && n <= 19; // Discover, JCB
}

// Card numbers are written contiguous, or grouped by one consistent separator
// as 4-4-4-4(-3) or 4-6-5 (Amex). Anything else (`2-4860-8414-7239`,
// `22350729-2259-4`, mixed spaces and dashes) is an identifier, a timestamp
// run or a coincidence, not a card.
function cardGroupingOk(candidate) {
  if (/^\d+$/.test(candidate)) return true;
  const seps = new Set(candidate.replace(/\d/g, ""));
  if (seps.size !== 1) return false;
  const groups = candidate.split(/[ -]/).map((g) => g.length);
  if (groups.length === 3) return groups[0] === 4 && groups[1] === 6 && groups[2] === 5;
  if (groups.length < 4 || groups.length > 5) return false;
  const last = groups[groups.length - 1];
  return groups.slice(0, -1).every((g) => g === 4) && last >= 1 && last <= 4;
}

function validCard(candidate) {
  const d = digitsOf(candidate);
  if (d.length < 13 || d.length > 19) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  if (!cardGroupingOk(candidate)) return false;
  return knownCardIssuer(d) && issuerLengthOk(d) && luhnValid(d);
}

// 9 to 15 digits (E.164 bound); no ISO-style date anywhere in the run (`44
// 2026-09-05`, `2026-09-11 01`); and dot-separated runs need the five groups
// of the French style, since `169.254.100` is a network fragment, not a phone.
const ISO_DATE_RE = /(?:^|[ .-])(?:19|20)\d{2}[ .-](?:0\d|1[0-2])[ .-](?:[0-2]\d|3[01])(?!\d)/;
function validPhone(candidate) {
  const d = digitsOf(candidate);
  if (d.length < 9 || d.length > 15) return false;
  const c = candidate.trim();
  if (ISO_DATE_RE.test(c)) return false;
  const seps = c.replace(/[\d+()]/g, "");
  if (seps.length > 0 && /^\.+$/.test(seps) && c.split(".").length < 5) return false;
  return true;
}

// Loopback, unspecified, broadcast and the RFC 5737 documentation ranges are
// not identifying and are kept.
function validIpv4(candidate) {
  const [a, b, c] = candidate.split(".").map(Number);
  if (a === 0 || a === 127) return false;
  if (a === 255 && b === 255 && c === 255) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

// `::`, `::1` and the RFC 3849 documentation prefix are kept. So are `::`
// forms with fewer than two groups or without a single digit (`1::`, `a::b`,
// `fe::add`): those are namespace paths in Rust, C++ or Perl source far more
// often than addresses.
function validIpv6(candidate) {
  const v = candidate.toLowerCase();
  if (v === "::" || v === "::1") return false;
  if (/^2001:0?db8:/.test(v)) return false;
  const groups = v.split(":").filter(Boolean);
  if (groups.length < 2) return false;
  if (!/\d/.test(v)) return false;
  return true;
}

// Obvious non-secret stand-ins. A capture that is exactly one of these
// (case-insensitive), or an all-mask string like "xxxxxxxx"/"********", is left
// in place so doc/example/fixture text isn't needlessly redacted. Anything
// ambiguous errs toward redaction. Sourced from the Gitleaks stopword allowlist
// plus SkillMeter's own placeholder set.
const STOPWORDS = new Set([
  "example", "examples", "dummy", "test", "tests", "testing", "test-token",
  "testtoken", "placeholder", "redacted", "changeme", "your-token",
  "your-api-key", "your_api_key", "your-secret", "yourkey", "xxx", "xxxx",
  "xxxxxxxx", "none", "null", "nil", "undefined", "true", "false", "sample",
  "secret", "token", "password", "apikey", "api-key", "api_key", "default",
  "root", "admin", "user", "username", "foo", "bar", "baz", "abc", "abc123",
  "123456", "process", "env", "string", "number", "boolean", "value",
]);

const SECRET = SECRET_PLACEHOLDER;

const RULES = [
  // --- Asymmetric / block keys -------------------------------------------
  {
    id: "private-key",
    category: "secret",
    // Body span is upper-bounded (8192) so an unterminated BEGIN header can't
    // force a lazy scan to EOF on every match attempt.
    re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,8192}?KEY(?: BLOCK)?-----/gi,
    keywords: ["-----begin"],
    replacement: SECRET,
  },

  // --- GitHub / GitLab ----------------------------------------------------
  {
    id: "github-token",
    category: "secret",
    re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
    keywords: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    entropy: 3,
    replacement: SECRET,
  },
  {
    id: "github-fine-grained-pat",
    category: "secret",
    re: /\bgithub_pat_[0-9A-Za-z_]{82}\b/g,
    keywords: ["github_pat_"],
    replacement: SECRET,
  },
  {
    id: "gitlab-pat",
    category: "secret",
    re: /\bglpat-[0-9A-Za-z_-]{20}\b/g,
    keywords: ["glpat-"],
    replacement: SECRET,
  },

  // --- Cloud providers ----------------------------------------------------
  {
    id: "aws-access-token",
    category: "secret",
    re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g,
    keywords: ["akia", "asia", "abia", "acca", "a3t"],
    entropy: 3,
    replacement: SECRET,
  },
  {
    id: "google-api-key",
    category: "secret",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    keywords: ["aiza"],
    replacement: SECRET,
  },
  {
    id: "google-oauth-client",
    category: "secret",
    re: /\b[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com\b/g,
    keywords: ["googleusercontent"],
    replacement: SECRET,
  },

  // --- AI / API vendors ---------------------------------------------------
  {
    id: "anthropic-api-key",
    category: "secret",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    keywords: ["sk-ant-"],
    replacement: SECRET,
  },
  {
    id: "openai-api-key",
    category: "secret",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    keywords: ["sk-"],
    entropy: 3,
    replacement: SECRET,
  },
  {
    id: "stripe-access-token",
    category: "secret",
    re: /\b(?:sk|rk)_(?:test|live|prod)_[0-9A-Za-z]{10,99}\b/g,
    keywords: ["sk_", "rk_"],
    replacement: SECRET,
  },

  // --- Messaging / comms --------------------------------------------------
  {
    id: "slack-token",
    category: "secret",
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    keywords: ["xox"],
    replacement: SECRET,
  },
  {
    id: "slack-webhook",
    category: "secret",
    re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,60}/g,
    keywords: ["hooks.slack.com"],
    replacement: SECRET,
  },
  {
    id: "twilio-api-key",
    category: "secret",
    // No keyword pre-filter: "sk" is a substring of common words (task/ask/disk)
    // so it wouldn't filter anything; the specific regex + entropy gate suffice.
    re: /\bSK[0-9a-fA-F]{32}\b/g,
    entropy: 3,
    replacement: SECRET,
  },
  {
    id: "sendgrid-api-key",
    category: "secret",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    keywords: ["sg."],
    replacement: SECRET,
  },
  {
    id: "mailgun-api-key",
    category: "secret",
    re: /\bkey-[0-9a-zA-Z]{32}\b/g,
    keywords: ["key-"],
    entropy: 3,
    replacement: SECRET,
  },

  // --- Package registries -------------------------------------------------
  {
    id: "npm-access-token",
    category: "secret",
    re: /\bnpm_[0-9A-Za-z]{36}\b/g,
    keywords: ["npm_"],
    replacement: SECRET,
  },
  {
    id: "pypi-upload-token",
    category: "secret",
    re: /\bpypi-AgEIcHlwaS[A-Za-z0-9_-]{50,}\b/g,
    keywords: ["pypi-ageichlwas"],
    replacement: SECRET,
  },

  // --- Infra / hosting ----------------------------------------------------
  {
    id: "digitalocean-token",
    category: "secret",
    re: /\bdo[oprv]_v1_[a-f0-9]{64}\b/g,
    keywords: ["dop_v1_", "doo_v1_", "dor_v1_", "dov_v1_"],
    replacement: SECRET,
  },
  {
    id: "hashicorp-vault-token",
    category: "secret",
    re: /\bhv[bs]\.[A-Za-z0-9_-]{90,}\b/g,
    keywords: ["hvs.", "hvb."],
    replacement: SECRET,
  },

  // --- Standards / structural --------------------------------------------
  {
    id: "jwt",
    category: "secret",
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    keywords: ["eyj"],
    replacement: SECRET,
  },
  {
    id: "database-url",
    category: "secret",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:/@]+:[^\s:/@]+@[^\s'"]+/g,
    keywords: ["://"],
    replacement: SECRET,
  },
  {
    id: "basic-auth-url",
    category: "secret",
    re: /\bhttps?:\/\/[^\s:/@]+:[^\s:/@]+@[^\s'"]+/g,
    keywords: ["://"],
    replacement: SECRET,
  },
  {
    id: "authorization-header",
    category: "secret",
    re: /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    keywords: ["authorization"],
    group: 1,
    replacement: SECRET,
  },
  {
    id: "env-secret",
    category: "secret",
    // Prefix and value spans are upper-bounded to avoid O(n^2) backtracking on
    // long alphanumeric blobs (base64, minified JS) that never reach a `:`/`=`.
    re: /\b[A-Za-z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|ACCESS[_-]?KEY|API[_-]?KEY)\s*[:=]\s*["']?([^\s"'`]{6,512})["']?/gi,
    group: 1,
    entropy: 3,
    replacement: SECRET,
  },

  // --- PII -----------------------------------------------------------------
  // Stage 1 of ADR 002: the categories a format identifies without context.
  // Each has a typed placeholder so the category survives and the value does
  // not. Names in free text, postal addresses and customer names are stage 2
  // (server-side engine) and deliberately not attempted here.
  {
    // Unicode-aware: letters of any script in the local part and in domain
    // labels (IDN), so `josé@example.com` is replaced whole instead of leaving
    // the accented prefix behind. The top-level label may also be the ASCII
    // A-label form of an IDN (`xn--p1ai`).
    id: "email",
    category: "pii",
    kind: "email",
    re: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+(?:\p{L}{2,}|xn--[a-z0-9-]{2,})(?![\p{L}\p{N}-])/giu,
    keywords: ["@"],
    replacement: EMAIL_PLACEHOLDER,
  },
  {
    // Payment card: 13-19 digits with optional single spaces or dashes between
    // digits, Luhn-valid, known issuer prefix.
    id: "payment-card",
    category: "pii",
    kind: "card",
    re: /(?<![\p{N}-])(?:\d[ -]?){12,18}\d(?![\p{N}-])/gu,
    precheck: /\d{4}/,
    validate: validCard,
    replacement: CARD_PLACEHOLDER,
  },
  {
    // Korean resident registration number: YYMMDD-SNNNNNN with a plausible
    // date and a valid first digit of the serial. Only the dashed form is
    // matched; 13 contiguous digits are too close to millisecond timestamps.
    id: "kr-rrn",
    category: "pii",
    kind: "id_number",
    re: /(?<![\p{N}-])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-8]\d{6}(?![\p{N}-])/gu,
    precheck: /\d{6}-\d/,
    replacement: ID_NUMBER_PLACEHOLDER,
  },
  {
    // US Social Security number in the dashed form, excluding the never-issued
    // area, group and serial values.
    id: "us-ssn",
    category: "pii",
    kind: "id_number",
    re: /(?<![\p{N}-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\p{N}-])/gu,
    precheck: /\d{3}-\d{2}-\d{4}/,
    replacement: ID_NUMBER_PLACEHOLDER,
  },
  {
    // IPv4 literal (four octets, each 0-255). A leading `v` (`v1.2.3.4`) marks
    // a version string and is skipped; a bare four-part version such as
    // `10.0.0.1` is indistinguishable from an address and is redacted
    // (accepted false positive, ADR 002 decision 3).
    id: "ipv4",
    category: "pii",
    kind: "ip",
    re: /(?<![\p{N}.]|\bv)(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\p{N}.])/gu,
    precheck: /\d\.\d/,
    validate: validIpv4,
    replacement: IP_PLACEHOLDER,
  },
  {
    // IPv6: the full eight-group form or a `::`-compressed form. Times
    // (`01:16:33`) and MAC addresses have no `::` and fewer than eight groups.
    id: "ipv6",
    category: "pii",
    kind: "ip",
    re: /(?<![\p{L}\p{N}:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\p{L}\p{N}:.])/giu,
    keywords: [":"],
    validate: validIpv6,
    replacement: IP_PLACEHOLDER,
  },
  {
    // Phone: optional `+` country code, then 3 to 5 digit groups joined by a
    // space, dot or dash (the first may be parenthesised). Bare digit runs,
    // `1.2.3.4` versions and ISO dates do not qualify; a separator-formatted
    // numeric id of 9+ digits does and is an accepted false positive.
    id: "phone",
    category: "pii",
    kind: "phone",
    re: /(?<![\p{L}\p{N}_@./:-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})(?:[ .-]\d{2,4}){2,4}(?![\p{L}\p{N}_:/-])/gu,
    precheck: /\d{2}[ .-]\(?\d{2}/,
    validate: validPhone,
    replacement: PHONE_PLACEHOLDER,
  },
  {
    // Person name in VCS metadata as it appears in `git log` / patch output:
    // the name before `<` on Author / Committer / Signed-off-by /
    // Co-authored-by lines. The address after `<` is handled by the email rule.
    id: "vcs-author",
    category: "pii",
    kind: "person",
    // The name is bounded (no quotes, brackets or backslashes, at most 80
    // characters) so a stray `<` far down a JSON blob cannot turn a paragraph
    // into a "name".
    re: /\b(Author|Committer|Signed-off-by|Co-authored-by):[ \t]+([^<>\n"\\]{1,80}?)[ \t]*(?=<)/gi,
    keywords: ["author:", "committer:", "signed-off-by:", "co-authored-by:"],
    group: 2,
    replacement: PERSON_PLACEHOLDER,
  },
];

module.exports = {
  RULES,
  STOPWORDS,
  KINDS,
  PLACEHOLDER_RE,
  SECRET_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  PERSON_PLACEHOLDER,
  PHONE_PLACEHOLDER,
  IP_PLACEHOLDER,
  ID_NUMBER_PLACEHOLDER,
  CARD_PLACEHOLDER,
  // exported for tests
  luhnValid,
  validCard,
  validPhone,
  validIpv4,
  validIpv6,
};

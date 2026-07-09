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
 *
 * Rules are deliberately curated (high-signal vendors + a couple of structural
 * catch-alls), not the full ~200-rule Gitleaks set: the long tail is noisy
 * without Gitleaks' per-rule allowlist machinery, and this client scrubs on
 * hot paths where fewer, sharper rules matter more than exhaustive recall.
 */

const SECRET_PLACEHOLDER = "[REDACTED_SECRET]";
const EMAIL_PLACEHOLDER = "[EMAIL]";

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
  {
    id: "email",
    category: "pii",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: EMAIL_PLACEHOLDER,
  },
];

module.exports = {
  RULES,
  STOPWORDS,
  SECRET_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
};

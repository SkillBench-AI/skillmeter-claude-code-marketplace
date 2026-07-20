"use strict";

// Unit coverage for the unified secret/PII sanitizer.
// Run: node --test skillmeter/test/sanitize.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const s = require("../scripts/lib/sanitize");
const { RULES } = require("../scripts/lib/rules");

const SALT = "deadbeefcafe";

// High-entropy filler of an exact length (deterministic; mixed case + digits).
const HI = "aB3dEf6hIj9kLm2nOp5qRs8tUvWxYz0AbC4dEfGhIjKlMnOp";
const hi = (n) => HI.slice(0, n);

// Realistic, high-entropy sample credentials (fake, generated for tests).
const SAMPLES = {
  "github-token": "ghp_" + hi(36),
  "gitlab-pat": "glpat-" + hi(20),
  "aws-access-token": "AKIAIOSFODNN7EXAMPLE",
  "google-api-key": "AIza" + hi(35),
  // Built from hi() so no full token literal appears in source (avoids
  // upstream secret-scanning false positives); still matches the slack rule.
  "slack-token": "xoxb-" + hi(30),
  "openai-api-key": "sk-proj-" + hi(43),
  "anthropic-api-key": "sk-ant-" + hi(36),
  "stripe-access-token": "sk_live_" + hi(24),
  "npm-access-token": "npm_" + hi(36),
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  "database-url": "postgres://admin:s3cr3tP4ss@db.internal:5432/prod",
};

test("each sample credential is redacted", () => {
  for (const [id, secret] of Object.entries(SAMPLES)) {
    const { value, redactions } = s.redactString(`before ${secret} after`);
    assert.ok(
      redactions.length > 0,
      `${id} should be redacted (got: ${value})`
    );
    assert.ok(!value.includes(secret), `${id} secret must not survive`);
    assert.ok(value.includes("[REDACTED_SECRET]"), `${id} placeholder present`);
  }
});

test("every rule id in the table has a distinct entry", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids must be unique");
});

test("emails are redacted to [EMAIL] and marked pii", () => {
  const { value, redactions } = s.redactString("ping me@example.com please");
  assert.equal(value, "ping [EMAIL] please");
  assert.deepEqual(
    redactions.map((r) => r.category),
    ["pii"]
  );
});

test("low-entropy candidates are NOT redacted (false-positive guard)", () => {
  // 36 identical chars → entropy 0 → github rule must reject.
  assert.equal(s.redactString("ghp_" + "a".repeat(36)).redactions.length, 0);
  // low-entropy env value.
  assert.equal(s.redactString("PASSWORD=aaaaaa").redactions.length, 0);
});

test("stopword captures are left in place", () => {
  assert.equal(s.redactString("API_KEY=example").value, "API_KEY=example");
  assert.equal(s.redactString("TOKEN=changeme").value, "TOKEN=changeme");
});

test("env-secret keeps the field name and redacts the value", () => {
  const { value, redactions } = s.redactString("DATABASE_PASSWORD=xY7kQ2mNp9wZ");
  assert.equal(value, "DATABASE_PASSWORD=[REDACTED_SECRET]");
  assert.equal(redactions[0].category, "secret");
});

test("authorization header redacts only the credential", () => {
  const { value } = s.redactString("Authorization: Bearer aB3dEf6hIj9kLmNoPqRs");
  assert.equal(value, "Authorization: Bearer [REDACTED_SECRET]");
});

test("containsSecret is true for secrets, false for plain text and emails", () => {
  assert.equal(s.containsSecret(SAMPLES["aws-access-token"]), true);
  assert.equal(s.containsSecret("just a normal skill name"), false);
  assert.equal(s.containsSecret("me@example.com"), false); // pii, not secret
});

test("scrubString hashes the home-dir prefix and drops the username", () => {
  const home = os.homedir();
  const input = `${home}/vscode/proj/file.js`;
  const out = s.scrubString(input, SALT);
  assert.ok(!out.includes(home), "raw home path must not survive");
  assert.ok(out.endsWith("/vscode/proj/file.js"), "relative tail preserved");
  // deterministic under a fixed salt
  assert.equal(out, s.scrubString(input, SALT));
});

test("scrubString without a salt still redacts secrets (only path-hash skipped)", () => {
  const out = s.scrubString(`key ${SAMPLES.jwt}`, "");
  assert.ok(out.includes("[REDACTED_SECRET]"));
});

test("scrubDeep forces redaction on secret-labelled object keys", () => {
  const { value } = s.sanitizeEventData(
    { mcp: { env: { API_KEY: "someRealLookingValue123" } } },
    SALT
  );
  assert.equal(value.mcp.env.API_KEY, "[REDACTED_SECRET]");
});

test("sanitizeLine scrubs secret + email + home path across a transcript line", () => {
  const home = os.homedir();
  const line = {
    type: "user",
    cwd: `${home}/vscode/proj`,
    message: {
      content: `token ${SAMPLES["github-token"]} at ${home}/x mail me@x.com`,
    },
  };
  const out = JSON.stringify(s.sanitizeLine(line, SALT));
  assert.ok(!out.includes(SAMPLES["github-token"]), "github token gone");
  assert.ok(!out.includes("me@x.com"), "email gone");
  assert.ok(!out.includes(home), "home path gone");
  assert.ok(out.includes("[REDACTED_SECRET]") && out.includes("[EMAIL]"));
});

test("sanitizeEventData meta reports secret/pii counts and policy version", () => {
  const { meta } = s.sanitizeEventData(
    { a: SAMPLES["aws-access-token"], b: "me@example.com" },
    SALT
  );
  assert.equal(meta.secrets, 1);
  assert.equal(meta.pii, 1);
  assert.equal(meta.policyVersion, s.POLICY_VERSION);
});

test("non-string scalars pass through untouched", () => {
  const { value } = s.sanitizeEventData({ n: 42, b: true, z: null }, SALT);
  assert.deepEqual(value, { n: 42, b: true, z: null });
});

test("secret-labelled key redaction does NOT clobber author-like fields (A1)", () => {
  const { value } = s.sanitizeEventData(
    { author: "Jane Doe", authored_by: "Bob", author_email: "x@y.com" },
    SALT
  );
  assert.equal(value.author, "Jane Doe");
  assert.equal(value.authored_by, "Bob");
  // author_email value is a real email → redacted by the email rule, not the key.
  assert.equal(value.author_email, "[EMAIL]");
});

test("secret-labelled key still forces redaction for real secret keys", () => {
  const { value } = s.sanitizeEventData(
    { authorization: "Bearer abc", auth: "zzz", token: "qqq" },
    SALT
  );
  assert.equal(value.authorization, "[REDACTED_SECRET]");
  assert.equal(value.auth, "[REDACTED_SECRET]");
  assert.equal(value.token, "[REDACTED_SECRET]");
});

test("path-bearing keys are HMAC-hashed wholesale, including nested (B3)", () => {
  const home = os.homedir();
  const { value } = s.sanitizeEventData(
    {
      tool_input: {
        file_path: `${home}/proj/a.js`,
        notebook_path: `${home}/nb.ipynb`,
        edits: [{ file_path: `${home}/proj/b.js` }],
      },
    },
    SALT
  );
  const ti = value.tool_input;
  for (const v of [ti.file_path, ti.notebook_path, ti.edits[0].file_path]) {
    assert.match(v, /^[0-9a-f]{12}$/, "path key value is a 12-hex HMAC");
  }
});

test("command is scrubbed for content (structure kept), NOT wholesale-hashed", () => {
  const { value } = s.sanitizeEventData(
    { tool_input: { command: `curl -H "Authorization: Bearer ${SAMPLES.jwt}" https://api.x` } },
    SALT
  );
  const cmd = value.tool_input.command;
  assert.ok(cmd.startsWith("curl -H"), "command shape preserved");
  assert.ok(cmd.includes("[REDACTED_SECRET]"), "secret inside command redacted");
  assert.ok(!cmd.includes(SAMPLES.jwt), "raw token gone");
});

test("cwd in a transcript line is HMAC-hashed via the PATH_KEYS branch", () => {
  const home = os.homedir();
  const line = { type: "user", cwd: `${home}/vscode/proj` };
  const out = s.sanitizeLine(line, SALT);
  assert.match(out.cwd, /^[0-9a-f]{12}$/);
});

test("sanitizeLine does not mutate its input", () => {
  const home = os.homedir();
  const line = { cwd: `${home}/x`, message: { content: `me@x.com` } };
  const snapshot = JSON.parse(JSON.stringify(line));
  s.sanitizeLine(line, SALT);
  assert.deepEqual(line, snapshot, "input object must be untouched");
});

// --- Shared cross-surface secret-fixture parity corpus ---------------------
// Loads the vendored copy of skillbench-docs/eval/secret-corpus/corpus.json and
// asserts every fixture is redacted. Tier-1 misses fail the build (blocks
// merge), so Tier-1 recall can't silently diverge from the Codex / session
// collector sanitizers. See SANITIZATION_EPIC.md Task 5.2.
const SECRET_CORPUS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "secret-corpus.json"), "utf8")
);
const buildCorpusValue = (parts) =>
  parts
    .map((p) => {
      if (/^HI[0-9]+$/.test(p)) return SECRET_CORPUS.hi.slice(0, Number(p.slice(2)));
      if (/^HX[0-9]+$/.test(p)) return SECRET_CORPUS.hex.slice(0, Number(p.slice(2)));
      return p;
    })
    .join("");

test("shared corpus: version + size guard (no silent shrinkage)", () => {
  assert.equal(SECRET_CORPUS.version, "1", "corpus version changed — re-sync all repo copies");
  const tier1 = SECRET_CORPUS.fixtures.filter((f) => f.tier === "tier1");
  assert.ok(tier1.length >= 24, `expected >= 24 Tier-1 fixtures, got ${tier1.length}`);
  assert.ok(
    SECRET_CORPUS.fixtures.some((f) => f.tier === "tier2"),
    "expected at least one Tier-2 fixture"
  );
});

for (const f of SECRET_CORPUS.fixtures) {
  test(`shared corpus: ${f.tier} ${f.id} is redacted`, () => {
    const secret = buildCorpusValue(f.parts);
    const { value, redactions } = s.redactString(`prefix ${secret} suffix`);
    assert.ok(redactions.length > 0, `${f.id}: expected a redaction event`);
    assert.equal(value.includes(secret), false, `${f.id}: raw secret survived sanitization`);
  });
}

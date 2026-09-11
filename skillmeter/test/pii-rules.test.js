"use strict";

// Stage-1 PII policy (3.0.0, ADR 002): typed placeholders, idempotency,
// identifier-only key heuristic, path features, per-record reporting.
// Run: node --test skillmeter/test/pii-rules.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const s = require("../scripts/lib/sanitize");
const rules = require("../scripts/lib/rules");

const SALT = "deadbeefcafe";

// --- Fixture corpus ---------------------------------------------------------

const CORPUS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "pii-corpus.json"), "utf8")
);

test("pii corpus: has both positive and negative fixtures for every stage-1 kind", () => {
  const positives = new Set();
  let negatives = 0;
  for (const f of CORPUS.fixtures) {
    if (f.kinds.length === 0) negatives++;
    for (const k of f.kinds) positives.add(k);
  }
  for (const kind of ["email", "person", "phone", "ip", "id_number", "card"]) {
    assert.ok(positives.has(kind), `no positive fixture for ${kind}`);
  }
  assert.ok(negatives >= 20, `expected >= 20 negative fixtures, got ${negatives}`);
});

for (const f of CORPUS.fixtures) {
  test(`pii corpus: ${f.id}`, () => {
    const { value, redactions } = s.redactString(f.text);
    assert.equal(value, f.expect);
    const kinds = new Set(redactions.map((r) => r.kind));
    if (f.kinds.length === 0) {
      assert.equal(redactions.length, 0, `${f.id}: expected no redaction, got ${[...kinds]}`);
    } else {
      for (const k of f.kinds) assert.ok(kinds.has(k), `${f.id}: missing kind ${k}`);
      for (const k of kinds) assert.ok(f.kinds.includes(k), `${f.id}: unexpected kind ${k}`);
    }
  });
}

// --- Placeholders and idempotency -----------------------------------------

test("every rule replacement is a placeholder the guard recognises", () => {
  for (const r of rules.RULES) {
    assert.ok(rules.PLACEHOLDER_RE.test(r.replacement), `${r.id}: ${r.replacement}`);
  }
});

test("every pii rule declares a kind listed in KINDS", () => {
  for (const r of rules.RULES.filter((x) => x.category === "pii")) {
    assert.ok(rules.KINDS.includes(r.kind), `${r.id}: kind ${r.kind}`);
  }
});

test("sanitizeEventData is a fixed point: second pass changes nothing and counts nothing", () => {
  const input = {
    msg: "mail a@b.co card 4111 1111 1111 1111 Author: Jane Doe <j@x.io> ip 10.1.2.3 tel 010-1234-5678",
    token: "abcDEF123xyz",
    mcp: { env: { API_KEY: "someRealLookingValue123" } },
    tool_input: {
      file_path: "/Users/me/proj/src/App.test.tsx",
      cwd: "/Users/me/proj",
      edits: [{ file_path: "/Users/me/proj/b.js" }],
    },
  };
  const one = s.sanitizeEventData(input, SALT);
  const two = s.sanitizeEventData(one.value, SALT);
  assert.deepEqual(two.value, one.value);
  assert.equal(two.meta.secrets, 0);
  assert.equal(two.meta.pii, 0);
  assert.deepEqual(two.meta.ids, []);
  for (const k of rules.KINDS) assert.equal(two.meta.counts[k], 0, `count ${k} on second pass`);
  assert.ok(one.meta.secrets >= 2 && one.meta.pii >= 4, "first pass did redact");
});

test("a placeholder under a secret-labelled key is kept as is (category survives)", () => {
  const { value, redactions } = s.sanitizeEventData({ token: "[EMAIL]", secret: "[CARD]" }, SALT);
  assert.equal(value.token, "[EMAIL]");
  assert.equal(value.secret, "[CARD]");
  assert.equal(redactions.length, 0);
});

test("sanitizeLine is a fixed point for a transcript line", () => {
  const line = {
    type: "user",
    cwd: "/Users/me/proj",
    message: { content: "ping josé@example.com from 10.0.0.7", author: "Author: X Y <x@y.z>" },
    toolUseResult: { file_path: "/Users/me/proj/README.md" },
  };
  const once = s.sanitizeLine(line, SALT);
  const twice = s.sanitizeLine(once, SALT);
  assert.deepEqual(twice, once);
  assert.equal(once.message.content, "ping [EMAIL] from [IP]");
  assert.equal(once._sanitization.counts.email, 1);
  assert.equal(once._sanitization.counts.ip, 1);
});

// --- Key-name heuristic -----------------------------------------------------

test("free-text keys are not force-redacted even when they contain auth/token words", () => {
  const question = "Keep SkillMeter telemetry authorized for @skillbench-ai?";
  const { value, redactions } = s.sanitizeEventData(
    {
      answers: {
        [question]: "Yes, keep it",
        "Which token format do you prefer?": "short ones",
      },
    },
    SALT
  );
  assert.equal(value.answers[question], "Yes, keep it");
  assert.equal(value.answers["Which token format do you prefer?"], "short ones");
  assert.equal(redactions.length, 0);
});

test("identifier-like secret keys still force redaction, including arrays", () => {
  const { value } = s.sanitizeEventData(
    {
      authorization: "Bearer abc",
      auth: "zzz",
      "auth.token": "qqq",
      API_KEY: "someRealLookingValue123",
      tokens: ["a1B2c3D4", "e5F6g7H8"],
    },
    SALT
  );
  assert.equal(value.authorization, "[REDACTED_SECRET]");
  assert.equal(value.auth, "[REDACTED_SECRET]");
  assert.equal(value["auth.token"], "[REDACTED_SECRET]");
  assert.equal(value.API_KEY, "[REDACTED_SECRET]");
  assert.deepEqual(value.tokens, ["[REDACTED_SECRET]", "[REDACTED_SECRET]"]);
});

test("isSecretKey: identifier shape is required", () => {
  assert.equal(s.isSecretKey("api_key"), true);
  assert.equal(s.isSecretKey("authorization"), true);
  assert.equal(s.isSecretKey("Keep telemetry authorized for X?"), false);
  assert.equal(s.isSecretKey("a".repeat(65)), false);
  assert.equal(s.isSecretKey("author_email"), false);
});

// --- Path features ----------------------------------------------------------

test("pathFeatures: depth and lowercase extension; dotfiles and bare names have none", () => {
  assert.deepEqual(s.pathFeatures("/Users/me/proj/src/App.test.TSX"), { depth: 5, ext: "tsx" });
  assert.deepEqual(s.pathFeatures("/Users/me/.env"), { depth: 3, ext: "" });
  assert.deepEqual(s.pathFeatures("/Users/me/Makefile"), { depth: 3, ext: "" });
  assert.deepEqual(s.pathFeatures("C:\\Users\\me\\a.py"), { depth: 4, ext: "py" });
  assert.deepEqual(s.pathFeatures("relative/x.md"), { depth: 2, ext: "md" });
});

test("file-path keys get _depth and _ext beside the hash; cwd keys stay hash-only", () => {
  const { value } = s.sanitizeEventData(
    {
      tool_input: {
        file_path: "/Users/me/proj/src/App.test.tsx",
        notebook_path: "/Users/me/nb/.hidden",
        cwd: "/Users/me/proj",
        old_cwd: "/Users/me",
      },
    },
    SALT
  );
  const ti = value.tool_input;
  assert.match(ti.file_path, /^[0-9a-f]{12}$/);
  assert.equal(ti.file_path_depth, 5);
  assert.equal(ti.file_path_ext, "tsx");
  assert.equal(ti.notebook_path_depth, 4);
  assert.equal("notebook_path_ext" in ti, false, "dotfile has no extension field");
  assert.match(ti.cwd, /^[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(ti).sort(), [
    "cwd",
    "file_path",
    "file_path_depth",
    "file_path_ext",
    "notebook_path",
    "notebook_path_depth",
    "old_cwd",
  ]);
});

test("path features describe the path actually hashed; stale or source-provided values are replaced", () => {
  const { value } = s.sanitizeEventData(
    { file_path: "/Users/me/a.js", file_path_depth: 99, file_path_ext: "custom" },
    SALT
  );
  assert.equal(value.file_path_depth, 3);
  assert.equal(value.file_path_ext, "js");
  const noExt = s.sanitizeEventData({ file_path: "/Users/me/Makefile", file_path_ext: "stale" }, SALT);
  assert.equal("file_path_ext" in noExt.value, false, "no extension means no field, stale one dropped");
});

test("a twelve-hex relative path without provenance is hashed like any other path", () => {
  const { value } = s.sanitizeEventData({ path: "deadbeefcafe" }, SALT);
  assert.notEqual(value.path, "deadbeefcafe");
  assert.match(value.path, /^[0-9a-f]{12}$/);
  assert.equal(value.path_depth, 1);
  assert.equal("path_ext" in value, false);
});

test("a record stamped with _sanitization is not re-hashed and gets no new features", () => {
  const first = s.sanitizeEventData({ file_path: "/Users/me/a.js", cwd: "/Users/me" }, SALT);
  assert.equal(s.hasSanitizationMarker(first.value), true);
  assert.deepEqual(first.value._sanitization, first.meta);
  const second = s.sanitizeEventData(first.value, SALT);
  assert.deepEqual(second.value, first.value);
  assert.equal(second.meta.pii + second.meta.secrets, 0);
});

test("a raw path added to an already stamped record is still hashed", () => {
  const first = s.sanitizeEventData({ file_path: "/Users/me/a.js" }, SALT);
  const tampered = { ...first.value, file_path: "/Users/me/new-secret-project/b.ts", cwd: "/Users/me/x" };
  const { value } = s.sanitizeEventData(tampered, SALT);
  assert.match(value.file_path, /^[0-9a-f]{12}$/);
  assert.notEqual(value.file_path, first.value.file_path, "new path gets its own hash");
  assert.equal(value.file_path_ext, "ts", "features follow the new path");
  assert.equal(value.file_path_depth, 4);
  assert.match(value.cwd, /^[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(value).includes("new-secret-project"), false);
});

test("a forged _sanitization stamp does not disable hashing of raw paths", () => {
  const forged = {
    _sanitization: { policyVersion: "3.0.0", secrets: 0, pii: 0, counts: {}, ids: [] },
    tool_input: { file_path: "/Users/me/proj/src/App.tsx", path: "src/index.ts" },
    cwd: "/Users/me/proj",
  };
  const { value } = s.sanitizeEventData(forged, SALT);
  assert.match(value.tool_input.file_path, /^[0-9a-f]{12}$/);
  assert.match(value.tool_input.path, /^[0-9a-f]{12}$/);
  assert.match(value.cwd, /^[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(value).includes("/Users/me"), false);
  // a non-version string is not a stamp at all
  assert.equal(s.hasSanitizationMarker({ _sanitization: { policyVersion: "latest" } }), false);
});

test("every record is stamped, transcript lines included", () => {
  const line = s.sanitizeLine({ type: "user", message: { content: "hi" } }, SALT);
  assert.equal(line._sanitization.policyVersion, "3.0.0");
  assert.deepEqual(Object.keys(line._sanitization), ["policyVersion", "secrets", "pii", "counts", "ids"]);
  const audit = s.sanitizeEventData({ source_hook_event_name: "Stop", gate_mode: "out_of_scope", cwd: "/x" }, SALT);
  assert.equal(audit.value._sanitization.policyVersion, "3.0.0");
});

// --- Reporting --------------------------------------------------------------

test("meta carries policy 3.0.0 and a full per-kind count map, zeros included", () => {
  const { meta } = s.sanitizeEventData({ plain: "nothing to see" }, SALT);
  assert.equal(meta.policyVersion, "3.0.0");
  assert.equal(s.POLICY_VERSION, "3.0.0");
  assert.deepEqual(Object.keys(meta.counts), rules.KINDS);
  for (const k of rules.KINDS) assert.equal(meta.counts[k], 0);
  assert.deepEqual(meta.ids, []);
  assert.equal(meta.secrets, 0);
  assert.equal(meta.pii, 0);
});

test("meta counts per kind and keeps the secret/pii totals and detector ids", () => {
  const { meta } = s.sanitizeEventData(
    {
      a: "AKIAIOSFODNN7EXAMPLE",
      b: "me@example.com and you@example.org",
      c: "010-1234-5678",
      d: "10.0.0.1",
      e: "900101-1234567",
      f: "4111 1111 1111 1111",
      g: "Author: Jane <j@x.io>",
      token: "forcedValue123",
    },
    SALT
  );
  assert.equal(meta.counts.secret, 2);
  assert.equal(meta.counts.email, 3);
  assert.equal(meta.counts.person, 1);
  assert.equal(meta.counts.phone, 1);
  assert.equal(meta.counts.ip, 1);
  assert.equal(meta.counts.id_number, 1);
  assert.equal(meta.counts.card, 1);
  assert.equal(meta.secrets, 2);
  assert.equal(meta.pii, 8);
  assert.deepEqual(meta.ids, [
    "aws-access-token",
    "email",
    "ipv4",
    "kr-rrn",
    "labelled-secret",
    "payment-card",
    "phone",
    "vcs-author",
  ]);
});

test("containsSecret stays false for PII-only content", () => {
  assert.equal(s.containsSecret("call 010-1234-5678 at 10.0.0.1, card 4111 1111 1111 1111"), false);
  assert.equal(s.containsSecret("AKIAIOSFODNN7EXAMPLE"), true);
});

// --- Validators -------------------------------------------------------------

test("luhnValid / validCard", () => {
  assert.equal(rules.luhnValid("4111111111111111"), true);
  assert.equal(rules.luhnValid("4111111111111112"), false);
  assert.equal(rules.validCard("4111 1111 1111 1111"), true);
  assert.equal(rules.validCard("378282246310005"), true);
  assert.equal(rules.validCard("1234567812345678"), false, "unknown issuer");
  assert.equal(rules.validCard("4444444444444444"), false, "all same digit run is rejected");
  assert.equal(rules.validCard("41111111"), false, "too short");
  assert.equal(rules.validCard("3782 822463 10005"), true, "Amex 4-6-5 grouping");
  assert.equal(rules.validCard("4111 1111 1111 1111"), true, "4-4-4-4 grouping");
  assert.equal(rules.validCard("4111 1111-1111-1111"), false, "mixed separators");
  assert.equal(rules.validCard("2-4860-8414-7239"), false, "irregular grouping");
  assert.equal(rules.validCard("44061085000000005"), false, "17 digits is not a Visa length");
});

test("validPhone rejects ISO dates, dotted fragments and out-of-range digit counts", () => {
  assert.equal(rules.validPhone("010-1234-5678"), true);
  assert.equal(rules.validPhone("01.23.45.67.89"), true, "French five dotted groups");
  assert.equal(rules.validPhone("2026-09-11 01"), false);
  assert.equal(rules.validPhone("44 2026-09-05"), false, "date embedded after an id");
  assert.equal(rules.validPhone("169.254.100"), false, "three dotted groups");
  assert.equal(rules.validPhone("12-34-56"), false);
  assert.equal(rules.validPhone("1234-5678-9012-3456"), false, "16 digits exceed E.164");
});

test("validIpv4 keeps loopback, unspecified, broadcast and documentation ranges", () => {
  assert.equal(rules.validIpv4("10.0.0.1"), true);
  assert.equal(rules.validIpv4("127.0.0.1"), false);
  assert.equal(rules.validIpv4("0.0.0.0"), false);
  assert.equal(rules.validIpv4("255.255.255.255"), false);
  assert.equal(rules.validIpv4("192.0.2.1"), false);
  assert.equal(rules.validIpv4("198.51.100.7"), false);
  assert.equal(rules.validIpv4("203.0.113.9"), false);
});

test("validIpv6 keeps loopback, documentation prefix and code-like forms", () => {
  assert.equal(rules.validIpv6("fe80::1"), true);
  assert.equal(rules.validIpv6("::1"), false);
  assert.equal(rules.validIpv6("::"), false);
  assert.equal(rules.validIpv6("2001:db8::1"), false);
  assert.equal(rules.validIpv6("2001:0db8::1"), false);
  assert.equal(rules.validIpv6("1::"), false, "fewer than two groups");
  assert.equal(rules.validIpv6("a::b"), false, "no digit");
});

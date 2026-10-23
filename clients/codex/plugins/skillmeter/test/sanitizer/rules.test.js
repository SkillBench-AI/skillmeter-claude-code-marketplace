"use strict";
// Detector rules of the shared engine: what is redacted, what is left alone,
// and the shape of the redaction record.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hi, SAMPLES } = require("../../test-support/sanitizer.cjs");
const s = require("../../scripts/lib/sanitize");
const { RULES } = require("../../scripts/lib/rules");
const { SECRET_PLACEHOLDER: R, EMAIL_PLACEHOLDER: E } = require("../../scripts/sanitizer");

const PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdef\nQEFAAOCAQ8AMIIBCgKCAQEA\n-----END RSA PRIVATE KEY-----";

for (const [id, secret] of Object.entries(SAMPLES)) {
  test(`sample credential: ${id} is redacted`, () => {
    const { value, redactions } = s.redactString(`before ${secret} after`);
    assert.ok(redactions.length > 0, `${id} should be redacted (got: ${value})`);
    assert.equal(value.includes(secret), false, `${id} must not survive`);
    assert.ok(value.includes(R));
    assert.ok(redactions.every(r => r.category === "secret"));
  });
}

test("every rule id in the table is unique", () => {
  const ids = RULES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("PEM private key blocks are redacted whole", () => {
  const { value, redactions } = s.redactString(`here is the key:\n${PRIVATE_KEY}\nthanks`);
  assert.equal(value.includes("BEGIN RSA PRIVATE KEY"), false);
  assert.ok(value.includes(R));
  assert.ok(redactions.some(r => r.id === "private-key"));
});

test("emails become the email placeholder and are reported as pii", () => {
  const { value, redactions } = s.redactString("ping me@example.com please");
  assert.equal(value, `ping ${E} please`);
  assert.deepEqual(redactions.map(r => [r.category, r.kind]), [["pii", "email"]]);
});

test("env-secret keeps the variable name and redacts only the value", () => {
  assert.equal(s.redactString("DATABASE_PASSWORD=xY7kQ2mNp9wZ").value, `DATABASE_PASSWORD=${R}`);
  const { value, redactions } = s.redactString("MY_API_KEY=supersecretvalue123");
  assert.equal(value, `MY_API_KEY=${R}`);
  assert.equal(redactions[0].id, "env-secret");
  assert.equal(redactions[0].category, "secret");
});

test("an Authorization header keeps the scheme and redacts the credential", () => {
  assert.equal(s.redactString("Authorization: Bearer aB3dEf6hIj9kLmNoPqRs").value, `Authorization: Bearer ${R}`);
});

test("low-entropy and placeholder values are left in place", () => {
  for (const sample of ["ghp_" + "a".repeat(36), "PASSWORD=aaaaaa", "API_KEY=example", "TOKEN=changeme",
    "TOKEN=dummy", "SECRET=xxxxxxxx", "Refactor the billing module and add a retry around the API call."]) {
    const { value, redactions } = s.redactString(sample);
    assert.equal(value, sample);
    assert.equal(redactions.length, 0, sample);
  }
  assert.ok(s.redactString("API_KEY=Zk9q1W8pLm4xVt2b").redactions.length >= 1, "a real-looking value is redacted");
});

test("containsSecret is true for secrets and false for prose and emails", () => {
  assert.equal(s.containsSecret(SAMPLES["aws-access-token"]), true);
  assert.equal(s.containsSecret("just a normal skill name"), false);
  assert.equal(s.containsSecret("me@example.com"), false);
});

test("several secrets in one string are each redacted and counted", () => {
  const { value, redactions } = s.redactString(`gh=${SAMPLES["github-token"]} and openai=${SAMPLES["openai-api-key"]}`);
  assert.equal(value.includes(hi(36)), false);
  assert.equal(redactions.length, 2);
  assert.ok(redactions.every(r => r.category === "secret"));
});

test("non-string and empty inputs pass through with no redactions", () => {
  for (const input of [null, undefined, 42, true, false, { a: 1 }, ["x"], ""]) {
    const { value, redactions } = s.redactString(input);
    assert.deepEqual(value, input);
    assert.deepEqual(redactions, []);
  }
});

test("redaction is idempotent and placeholders are never re-redacted", () => {
  const first = s.redactString(`token is ${SAMPLES["openai-api-key"]} ok`).value;
  assert.ok(first.includes(R));
  const second = s.redactString(first);
  assert.equal(second.value, first);
  assert.deepEqual(second.redactions, []);
  assert.deepEqual(s.redactString(`leftover ${R} and ${E} markers`).redactions, []);
});

test("redaction records carry no original material", () => {
  const { redactions } = s.redactString(`x ${SAMPLES["openai-api-key"]} y`);
  assert.ok(redactions.length > 0);
  for (const r of redactions) {
    assert.deepEqual(Object.keys(r).sort(), ["action", "category", "id", "kind"]);
    assert.equal(JSON.stringify(r).includes("sk-"), false);
  }
});

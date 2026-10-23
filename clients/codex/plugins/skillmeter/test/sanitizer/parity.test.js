"use strict";
// The vendored Claude engine must match the pinned upstream: source hashes,
// policy version, and every fixture of the two shared corpora.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PLUGIN_ROOT, FIXTURES } = require("../../test-support/plugin.cjs");
const sanitizer = require("../../scripts/sanitizer");

const source = require("../fixtures/claude-3.1/source.json");
const pii = require("../fixtures/claude-3.1/pii-corpus.json");
const secrets = JSON.parse(fs.readFileSync(path.join(FIXTURES, "secret-corpus.json"), "utf8"));

for (const file of source.files) {
  test(`Claude source pin: ${file.local}`, () => {
    const bytes = fs.readFileSync(path.join(PLUGIN_ROOT, file.local));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256,
      "update the vendored Claude implementation and the source pin together");
  });
}

test("the adapter declares the pinned Claude policy version", () => {
  assert.equal(sanitizer.POLICY_VERSION, source.policyVersion);
});

for (const f of pii.fixtures) {
  test(`Claude PII parity: ${f.id}`, () => {
    const { value, redactions } = sanitizer.redactString(f.text);
    assert.equal(value, f.expect);
    const kinds = [...new Set(redactions.filter(r => r.category === "pii").map(r => r.kind))].sort();
    assert.deepEqual(kinds, [...f.kinds].sort());
  });
}

test("the shared secret corpus keeps its version and size", () => {
  assert.equal(secrets.version, "1", "corpus version changed; re-sync every repository copy");
  assert.ok(secrets.fixtures.filter(f => f.tier === "tier1").length >= 24);
  assert.ok(secrets.fixtures.some(f => f.tier === "tier2"));
});

const corpusValue = parts => parts.map(p => {
  if (/^HI[0-9]+$/.test(p)) return secrets.hi.slice(0, Number(p.slice(2)));
  if (/^HX[0-9]+$/.test(p)) return secrets.hex.slice(0, Number(p.slice(2)));
  return p;
}).join("");

for (const f of secrets.fixtures) {
  test(`shared secret corpus: ${f.tier} ${f.id} is redacted`, () => {
    const secret = corpusValue(f.parts);
    const { value, redactions } = sanitizer.redactString(`prefix ${secret} suffix`);
    assert.ok(redactions.length > 0, `${f.id}: expected a redaction`);
    assert.equal(value.includes(secret), false, `${f.id}: raw secret survived`);
  });
}

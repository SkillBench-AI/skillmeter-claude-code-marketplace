"use strict";
// The Codex adapter must redact every fixture of the two corpora in
// shared/fixtures, which the Claude Code client's tests also run. The engine
// itself is shared/lib/sanitize.js; scripts/sync-shared.mjs keeps it identical
// in both plugins.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sanitizer = require("../../../plugins/skillmeter/scripts/sanitizer");

const SHARED_FIXTURES = path.resolve(__dirname, "..", "..", "..", "..", "..", "shared", "fixtures");
const pii = require(path.join(SHARED_FIXTURES, "pii-corpus.json"));
const secrets = JSON.parse(fs.readFileSync(path.join(SHARED_FIXTURES, "secret-corpus.json"), "utf8"));

for (const f of pii.fixtures) {
  test(`Claude PII parity: ${f.id}`, () => {
    const { value, redactions } = sanitizer.redactString(f.text);
    assert.equal(value, f.expect);
    const kinds = [...new Set(redactions.filter(r => r.category === "pii").map(r => r.kind))].sort();
    assert.deepEqual(kinds, [...f.kinds].sort());
  });
}

test("the shared secret corpus keeps its version and size", () => {
  assert.equal(secrets.version, "1", "corpus version changed; re-sync it from skillbench-docs");
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

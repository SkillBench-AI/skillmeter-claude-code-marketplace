"use strict";
require("../testing/bootstrap");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const s = require("../skillmeter/scripts/lib/sanitize");
const SALT = "synthetic-key-collision-salt";

test("redacted path keys preserve every change and extension without mutating input", () => {
  const record = { changes: {
    "/synthetic/alice@example.com/cart.cjs": { type: "add", content: "first" },
    "/synthetic/bob@example.com/cart.cjs": { type: "delete", content: "second" },
  } };
  const before = structuredClone(record);
  const { value, meta } = s.sanitizeEventData(record, SALT);
  assert.equal(Object.keys(value.changes).length, 2);
  assert.deepEqual(Object.values(value.changes), Object.values(record.changes));
  assert.ok(Object.keys(value.changes).every(key => key.endsWith(".cjs")));
  assert.equal(JSON.stringify(value).includes("@example.com"), false);
  assert.equal(meta.counts.email, 2, "scrub each key exactly once");
  assert.deepEqual(record, before);
  assert.deepEqual(s.sanitizeLine(record, SALT), value, "event and transcript boundaries agree");
});

test("generated keys cannot overwrite existing placeholder or suffix-shaped keys", () => {
  for (const reverse of [false, true]) {
    const entries = [
      ["/x/alice@example.com/cart.d.ts", "first"],
      ["/x/bob@example.com/cart.d.ts", "second"],
      ["/x/[EMAIL]/cart.d.ts", "literal"],
      ["/x/[EMAIL]/cart[key-2].d.ts", "reserved"],
      ["/x/[EMAIL]/cart[key-3].d.ts", "also reserved"],
    ];
    if (reverse) entries.reverse();
    const record = { changes: Object.fromEntries(entries) };
    const first = s.sanitizeLine(record, SALT);
    assert.equal(Object.keys(first.changes).length, entries.length);
    assert.deepEqual(Object.values(first.changes), entries.map(([, value]) => value));
    assert.equal(first.changes["/x/[EMAIL]/cart[key-2].d.ts"], "reserved");
    assert.equal(first.changes["/x/[EMAIL]/cart[key-3].d.ts"], "also reserved");
    assert.ok(Object.keys(first.changes).every(key => key.endsWith(".d.ts")));
    assert.deepEqual(s.sanitizeLine(record, SALT), first, "repeat input is deterministic");
    assert.deepEqual(s.sanitizeLine(first, SALT), first, "suffixes do not collide on another pass");
  }
});

test("collision handling is recursive and works without salt or a path-shaped key", () => {
  const source = { plain: true, nested: [{ answers: {
    "alice@example.com": "answer one",
    "bob@example.com": "answer two",
    "[EMAIL][key-2]": "literal",
  } }] };
  const { value } = s.sanitizeEventData(source, "");
  assert.equal(value.plain, true);
  assert.deepEqual(Object.values(value.nested[0].answers), ["answer one", "answer two", "literal"]);
  assert.equal(JSON.stringify(value).includes("@example.com"), false);
});

test("secret-key context comes from original keys and all retained values are scrubbed", () => {
  const secret = "ghp_" + "aB3dEf6hIj9kLm2nOp5qRs8tUvWxYz0AbC4dE".slice(0, 36);
  const source = { env: { API_TOKEN: "not-a-pattern" }, changes: {
    [secret]: { content: "alice@example.com" },
    [secret.slice(0, -1) + "2"]: { content: "bob@example.com" },
  } };
  const { value } = s.sanitizeEventData(source, SALT);
  assert.equal(value.env.API_TOKEN, "[REDACTED_SECRET]");
  assert.equal(Object.keys(value.changes).length, 2);
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.deepEqual(Object.values(value.changes), [{ content: "[EMAIL]" }, { content: "[EMAIL]" }]);
});

test("JSON prototype-shaped keys remain own data properties through serialization", () => {
  const source = JSON.parse('{"__proto__":{"content":"alice@example.com"},"constructor":"data","toString":"data"}');
  const { value } = s.sanitizeEventData(source, SALT);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(value)).__proto__, { content: "[EMAIL]" });
  assert.equal(value.constructor, "data");
  assert.equal(value.toString, "data");
});

test("large collision groups keep all entries including reserved generated names", () => {
  const entries = [];
  for (let i = 0; i < 500; i++) {
    entries.push([`person${i}@example.com`, i]);
    entries.push([`[EMAIL][key-${i + 2}]`, i + 500]);
  }
  const { value } = s.sanitizeEventData({ entries: Object.fromEntries(entries) }, SALT);
  assert.equal(Object.keys(value.entries).length, entries.length);
  assert.deepEqual(Object.values(value.entries), entries.map(([, item]) => item));
});

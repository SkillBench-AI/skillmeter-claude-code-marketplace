"use strict";
// Deep walking of records: secret-labelled keys, key collisions after
// redaction, scalar preservation, metadata, and input immutability.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SALT, SAMPLES, hi } = require("../../test-support/sanitizer.cjs");
const s = require("../../scripts/lib/sanitize");
const adapter = require("../../scripts/sanitizer");

test("secret-labelled keys force redaction of opaque values, including through arrays", () => {
  const { value } = s.sanitizeEventData({
    mcp: { env: { API_KEY: "someRealLookingValue123" } },
    authorization: "Bearer abc", auth: "zzz", token: "qqq",
    tokens: ["plainButUnderTokenKey123", "anotherOpaqueValue456"],
  }, SALT);
  assert.equal(value.mcp.env.API_KEY, "[REDACTED_SECRET]");
  for (const key of ["authorization", "auth", "token"]) assert.equal(value[key], "[REDACTED_SECRET]", key);
  assert.deepEqual(value.tokens, ["[REDACTED_SECRET]", "[REDACTED_SECRET]"]);
});

test("placeholders under secret keys and author-like keys are left alone", () => {
  const { value } = s.sanitizeEventData({
    token: "example", author: "Jane Doe", authored_by: "Bob", author_email: "x@y.com", description: "deploy the api gateway",
  }, SALT);
  assert.equal(value.token, "example");
  assert.equal(value.author, "Jane Doe");
  assert.equal(value.authored_by, "Bob");
  assert.equal(value.author_email, "[EMAIL]", "redacted by the email rule, not the key");
  assert.equal(value.description, "deploy the api gateway");
});

test("redactDeep walks nested objects and arrays and preserves scalars and shape", () => {
  const redactions = [];
  const out = adapter.redactDeep({
    prompt: `deploy with ${SAMPLES["openai-api-key"]}`,
    tool_input: { args: ["--token", SAMPLES["github-token"]], nested: { note: "email me at dev@example.org" } },
    n: 1, b: true, nul: null, arr: [1, "ok", { path: "/x", secret: SAMPLES["openai-api-key"] }],
  }, redactions, SALT);
  const text = JSON.stringify(out);
  for (const raw of [hi(36), "dev@example.org"]) assert.equal(text.includes(raw), false, raw);
  assert.equal(out.n, 1);
  assert.equal(out.b, true);
  assert.equal(out.nul, null);
  assert.deepEqual(out.arr.slice(0, 2), [1, "ok"]);
  assert.match(out.arr[2].path, /^[a-f0-9]{12}$/);
  assert.equal(redactions.filter(r => r.category === "secret").length, 3);
  const list = adapter.redactDeep([`a ${SAMPLES["github-token"]}`, "clean"], []);
  assert.equal(list[0].includes(hi(36)), false);
  assert.equal(list[1], "clean");
});

test("sanitizeEventData meta carries counts, sorted unique ids and the policy version, never original values", () => {
  const { value, meta } = s.sanitizeEventData({
    a: `first ${SAMPLES["github-token"]}`, b: `second ${SAMPLES["github-token"]}`, c: "email me at dev@example.org",
    n: 42, flag: true, z: null,
  }, SALT);
  assert.equal(meta.secrets, 2);
  assert.equal(meta.pii, 1);
  assert.deepEqual(meta.ids, ["email", "github-token"]);
  assert.equal(meta.policyVersion, s.POLICY_VERSION);
  assert.deepEqual([value.n, value.flag, value.z], [42, true, null]);
  assert.equal(value._sanitization.policyVersion, s.POLICY_VERSION);
  const text = JSON.stringify(meta);
  assert.equal(text.includes(hi(36)) || text.includes("dev@example.org"), false);
  const clean = s.sanitizeEventData({ prompt: "please refactor the billing module", count: 5 }, SALT);
  assert.deepEqual([clean.meta.secrets, clean.meta.pii, clean.meta.ids], [0, 0, []]);
  assert.equal(clean.value.count, 5);
});

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
  assert.equal(meta.counts.email, 2, "each key is scrubbed exactly once");
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
    "alice@example.com": "answer one", "bob@example.com": "answer two", "[EMAIL][key-2]": "literal",
  } }] };
  const { value } = s.sanitizeEventData(source, "");
  assert.equal(value.plain, true);
  assert.deepEqual(Object.values(value.nested[0].answers), ["answer one", "answer two", "literal"]);
  assert.equal(JSON.stringify(value).includes("@example.com"), false);
});

test("secret-key context comes from original keys and all retained values are scrubbed", () => {
  const secret = "ghp_" + hi(36);
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

"use strict";
// The Codex adapter's redactDeep. The shared engine's record handling (secret
// keys, key collisions, metadata) is tested in shared/test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SALT, SAMPLES, hi } = require("../../../test-support/sanitizer.cjs");
const adapter = require("../../../plugins/skillmeter/scripts/sanitizer");

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


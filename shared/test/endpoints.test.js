"use strict";
// Environments and the release channel (shared/lib/endpoints.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./helpers");
const { readChannel } = require("../lib/endpoints");

test("only the exact internal shape selects a channel", () => {
  const file = path.join(makeTempDir(), "channel.json");
  const read = (value) => { fs.writeFileSync(file, value); return readChannel(file); };
  assert.deepEqual(read('{"channel":"internal","env":"dev"}'), { channel: "internal", env: "dev" });
  for (const bad of ["{", "[]", '{"channel":"internal","env":"staging"}', '{"channel":"../x","env":"dev"}', '{"env":"dev"}']) {
    assert.deepEqual(read(bad), { channel: "stable", env: "prod" }, bad);
  }
  assert.deepEqual(readChannel(path.join(path.dirname(file), "missing.json")), { channel: "stable", env: "prod" });
});

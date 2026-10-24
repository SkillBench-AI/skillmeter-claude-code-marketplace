"use strict";
// How the Codex logger applies the shared path policy to tool data. The policy
// itself is tested in shared/test/path-hashing.test.js.
const { isolateHome } = require("../../../test-support/plugin.cjs");
isolateHome({ device_id: "TEST-DEVICE", hash_salt: "deadbeefsalt" });

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SALT, HEX } = require("../../../test-support/sanitizer.cjs");
const s = require("../../../plugins/skillmeter/scripts/lib/sanitize");
const logger = require("../../../plugins/skillmeter/scripts/logger");

const re = source => new RegExp(`^${source}$`);

test("sanitizeToolData hashes every path-like key by the shared policy and leaves the rest alone", () => {
  const input = {
    file_path: "/Users/dev/secret/app.ts", filePath: "/Users/dev/secret/other.ts", path: "/etc/passwd",
    command: "cat ~/.aws/credentials", cwd: "/Users/dev/secret-project", patch: "*** Update File: /Users/dev/secret/app.ts",
    tool_name: "Bash", description: "run the deploy script", count: 3, enabled: true, nothing: null,
    nested: { command: "ls /secret", args: [{ path: "/a/b" }, { path: "/c/d" }] }, numeric: { command: 42, path: { nested: "/a" } },
  };
  const out = logger.sanitizeToolData(input, SALT);
  for (const key of ["file_path", "filePath", "path", "command", "cwd", "patch"]) {
    const expected = ["file_path", "filePath"].includes(key) ? s.hashPathSegments(input[key], SALT) : logger.hashHmac(input[key], SALT);
    assert.equal(out[key], expected, `${key} follows the shared path policy`);
  }
  for (const key of ["tool_name", "description", "count", "enabled", "nothing"]) assert.deepEqual(out[key], input[key]);
  assert.match(out.nested.command, re(HEX));
  assert.match(out.nested.args[1].path, re(HEX));
  assert.equal(out.numeric.command, 42, "non-string values are not hashed");
  assert.equal(out.numeric.path.nested, "/a", "objects under a path key recurse");
  for (const scalar of [null, undefined, "a string", 7]) assert.equal(logger.sanitizeToolData(scalar, SALT), scalar);
  assert.notEqual(logger.sanitizeToolData({ command: "rm -rf /" }, "salt-a").command,
    logger.sanitizeToolData({ command: "rm -rf /" }, "salt-b").command, "hashes depend on the salt");
});

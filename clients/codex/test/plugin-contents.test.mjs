import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Codex copies the whole plugin directory into each user's cache, so only
// runtime files belong there. Tests, test helpers and integration tooling live
// beside it under clients/codex.
const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_ONLY = /(^|\/)(test|tests|test-support|integration|fixtures)\/|\.test\.[cm]?js$/;

test("the Codex plugin directory ships no tests or development tooling", () => {
  const files = execFileSync("git", ["ls-files", "plugins/skillmeter"], { cwd: clientRoot, encoding: "utf8" })
    .split("\n").filter(Boolean);
  assert.ok(files.length > 0, "git ls-files found the plugin");
  assert.deepEqual(files.filter((file) => DEV_ONLY.test(file.slice("plugins/skillmeter/".length))), []);
});

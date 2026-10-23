import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Modules both clients must run byte-for-byte. The lock protocol guards the
// credentials.json both clients write, and the sanitizer defines what leaves
// the machine; a change to either lands in both clients or in neither.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const claude = join(repoRoot, "clients/claude-code/skillmeter/scripts/lib");
const codex = join(repoRoot, "clients/codex/plugins/skillmeter/scripts/lib");

for (const file of ["credential-lock.js", "sanitize.js", "rules.js", "path-vocabulary.json"]) {
  test(`${file} is identical in both clients`, () => {
    assert.ok(readFileSync(join(codex, file)).equals(readFileSync(join(claude, file))),
      `clients/codex/plugins/skillmeter/scripts/lib/${file} differs from the Claude Code client's copy`);
  });
}

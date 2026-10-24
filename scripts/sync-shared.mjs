#!/usr/bin/env node
// Copy shared/lib into both plugins, or check that the copies are current.
//
// Both CLIs install only the plugin directory, so a plugin cannot require code
// from outside it. Code both clients must run identically lives once in
// shared/lib and is copied to the same path in each plugin's scripts/lib.
// Edit shared/lib, never a copy; CI fails when a copy differs.
//
// Usage: node scripts/sync-shared.mjs [--check]

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "shared/lib");
const targets = [
  "clients/claude-code/skillmeter/scripts/lib",
  "clients/codex/plugins/skillmeter/scripts/lib",
];
const check = process.argv.includes("--check");

// JavaScript copies open with a pointer back to their source. JSON cannot
// carry a comment and is copied as is.
const header = (name) => `// GENERATED from shared/lib/${name} by scripts/sync-shared.mjs. Edit that file, not this copy.\n`;
const render = (name) => {
  const body = readFileSync(join(source, name), "utf8");
  return /\.c?js$/.test(name) ? header(name) + body : body;
};
const isGenerated = (file) => /\.c?js$/.test(file) && readFileSync(file, "utf8").startsWith("// GENERATED from shared/lib/");

const names = readdirSync(source).filter((name) => !name.startsWith(".")).sort();
const problems = [];

for (const target of targets) {
  for (const name of names) {
    const file = join(root, target, name);
    const expected = render(name);
    const actual = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (actual === expected) continue;
    if (check) problems.push(`${relative(root, file)}: ${actual === null ? "missing" : "differs from shared/lib/" + name}`);
    else writeFileSync(file, expected);
  }
  // A copy whose source was removed from shared/lib is stale.
  for (const name of readdirSync(join(root, target))) {
    const file = join(root, target, name);
    if (names.includes(name) || !isGenerated(file)) continue;
    if (check) problems.push(`${relative(root, file)}: generated, but shared/lib/${name} no longer exists`);
    else rmSync(file);
  }
}

if (problems.length > 0) {
  console.error("✗ shared modules out of sync; run `node scripts/sync-shared.mjs`:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`✓ ${names.length} shared module(s) ${check ? "in sync" : "synced"} in ${targets.length} plugins`);

#!/usr/bin/env node
// Validate MAJOR.MINOR.PATCH (no suffixes) and an optional matching codex-v-prefixed tag.
// The plugin manifest is the version source of truth. Exit 1 on failure.
//
// Usage: node .github/scripts/check-version.mjs [--tag codex-v0.5.1]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = resolve(
  repoRoot,
  "plugins/skillmeter/.codex-plugin/plugin.json"
);

// Clean SemVer only: no pre-release ("-rc.1") and no build metadata ("+sha").
const CLEAN_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { tag: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tag") {
      args.tag = argv[++i] ?? "";
    } else if (arg.startsWith("--tag=")) {
      args.tag = arg.slice("--tag=".length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const { tag } = parseArgs(process.argv.slice(2));

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  fail(`could not read/parse ${manifestPath}: ${err.message}`);
}

const version = manifest.version;
if (typeof version !== "string" || version.length === 0) {
  fail("plugin.json is missing a string \"version\" field");
}

if (!CLEAN_SEMVER.test(version)) {
  fail(
    `plugin.json version "${version}" is not clean SemVer (expected MAJOR.MINOR.PATCH with no pre-release or build-metadata suffix)`
  );
}

console.log(`✓ plugin version is clean SemVer: ${version}`);

if (tag !== null) {
  // Prefixed because the Claude Code plugin's v* tags share this repository.
  const expected = `codex-v${version}`;
  if (tag !== expected) {
    fail(
      `release tag "${tag}" does not match plugin version (expected "${expected}")`
    );
  }
  console.log(`✓ release tag matches plugin version: ${tag}`);
}

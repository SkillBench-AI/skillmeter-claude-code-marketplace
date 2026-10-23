#!/usr/bin/env node
// Validate marketplace/plugin JSON and referenced plugin directories.
// Usage: node .github/scripts/validate-manifests.mjs

import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// This client lives at clients/codex in the SkillMeter plugins monorepo. Its own
// files resolve against the client root; the marketplace manifest Codex reads
// sits at the repository root, two levels further up, and the plugin path it
// declares is relative to that root.
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = resolve(clientRoot, "..", "..");

const errors = [];
const checks = [];

function readJson(relPath, base = clientRoot) {
  const abs = resolve(base, relPath);
  try {
    const value = JSON.parse(readFileSync(abs, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${relPath}: expected a JSON object`);
      return null;
    }
    return value;
  } catch (err) {
    errors.push(`${relPath}: invalid JSON (${err.message})`);
    return null;
  }
}

function isDir(absPath) {
  try {
    return existsSync(absPath) && statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

// --- Plugin manifest -------------------------------------------------------
const pluginManifestRel = "plugins/skillmeter/.codex-plugin/plugin.json";
const plugin = readJson(pluginManifestRel);
if (plugin) {
  for (const field of ["name", "version", "description"]) {
    if (typeof plugin[field] !== "string" || plugin[field].length === 0) {
      errors.push(`${pluginManifestRel}: missing/empty "${field}"`);
    }
  }
  checks.push(`plugin manifest "${plugin.name}" ok`);
}

// --- Marketplace manifest --------------------------------------------------
// Only `.agents/plugins/marketplace.json`. The root `.claude-plugin/` manifest
// is the Claude Code plugin's, in Claude's format, and is validated by that
// client's CI. This file must exist: Codex reads `.agents/` first and falls back
// to `.claude-plugin/marketplace.json` only when it is absent, so losing it
// would make Codex offer the Claude Code plugin under the same name with no
// error. A missing file fails readJson below.
const marketplaceRels = [".agents/plugins/marketplace.json"];

for (const rel of marketplaceRels) {
  const mp = readJson(rel, repoRoot);
  if (!mp) continue;
  if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) {
    errors.push(`${rel}: "plugins" must be a non-empty array`);
    continue;
  }
  for (const entry of mp.plugins) {
    if (!entry || typeof entry.name !== "string") {
      errors.push(`${rel}: a plugin entry is missing a "name"`);
      continue;
    }
    const src = entry.source;
    if (src && src.source === "local" && typeof src.path === "string") {
      const abs = join(repoRoot, src.path);
      if (!isDir(abs)) {
        errors.push(
          `${rel}: plugin "${entry.name}" points at missing directory "${src.path}"`
        );
      }
    }
  }
  checks.push(`${rel} ok (${mp.plugins.length} plugin entr${mp.plugins.length === 1 ? "y" : "ies"})`);
}

if (errors.length > 0) {
  console.error("✗ manifest validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

for (const c of checks) console.log(`✓ ${c}`);
console.log("✓ all manifests valid");

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Paths are relative to the repository root and mirror the monorepo layout:
// the client under clients/codex, the Codex marketplace at the root.
const manifests = {
  "clients/codex/plugins/skillmeter/.codex-plugin/plugin.json": {
    name: "fixture", version: "1.0.0", description: "Synthetic plugin",
  },
  ".agents/plugins/marketplace.json": {
    plugins: [{ name: "fixture", source: { source: "local", path: "./clients/codex/plugins/skillmeter" } }],
  },
};

function validate(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "manifest-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "clients/codex/.github/scripts/validate-manifests.mjs");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(new URL("../.github/scripts/validate-manifests.mjs", import.meta.url), script);
  for (const [relative, value] of Object.entries({ ...manifests, ...overrides })) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }
  return spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 });
}

test("manifest validator accepts valid object roots", (t) => {
  const result = validate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all manifests valid/);
});

for (const path of Object.keys(manifests)) {
  for (const value of [null, false, 0, "", true, "text", []]) {
    test(`manifest validator rejects ${JSON.stringify(value)} in ${path}`, (t) => {
      const result = validate(t, { [path]: value });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const reported = path.replace(/^clients\/codex\//, "");
      assert.ok(result.stderr.includes(`${reported}: expected a JSON object`), result.stderr);
      assert.doesNotMatch(result.stdout, /all manifests valid/);
    });
  }
}

test("manifest validator fails when the Codex marketplace is missing", (t) => {
  // Codex would fall back to the Claude Code manifest without it.
  const root = mkdtempSync(join(tmpdir(), "manifest-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "clients/codex/.github/scripts/validate-manifests.mjs");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(new URL("../.github/scripts/validate-manifests.mjs", import.meta.url), script);
  const plugin = join(root, "clients/codex/plugins/skillmeter/.codex-plugin/plugin.json");
  mkdirSync(dirname(plugin), { recursive: true });
  writeFileSync(plugin, JSON.stringify(manifests["clients/codex/plugins/skillmeter/.codex-plugin/plugin.json"]));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\.agents\/plugins\/marketplace\.json: invalid JSON/);
});

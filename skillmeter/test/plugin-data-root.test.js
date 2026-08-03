"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  makeTempDir,
  runNode,
  writeFile,
} = require("../testing/helpers");
const {
  derivePluginDataRoot,
  resolvePluginDataRoot,
} = require("../scripts/lib/plugin-data-root");

// Mirror the layout Claude Code creates:
//   <config>/plugins/cache/<marketplace>/<plugin>/<version>
//   <config>/plugins/data/<plugin>-<marketplace>
function makeHostLayout({ withDataParent = true } = {}) {
  const configRoot = makeTempDir("skm-host-");
  const pluginRoot = path.join(
    configRoot, "plugins", "cache", "skillbench", "skillmeter", "9.9.9"
  );
  fs.mkdirSync(pluginRoot, { recursive: true });
  if (withDataParent) {
    fs.mkdirSync(path.join(configRoot, "plugins", "data"), { recursive: true });
  }
  return {
    configRoot,
    pluginRoot,
    expected: path.join(
      configRoot, "plugins", "data", "skillmeter-skillbench"
    ),
  };
}

test("derives the host's data dir from a cache-layout plugin root", () => {
  const { pluginRoot, expected } = makeHostLayout();
  assert.equal(derivePluginDataRoot(pluginRoot), expected);
});

test("refuses to guess when the host's plugins/data parent is absent", () => {
  const { pluginRoot } = makeHostLayout({ withDataParent: false });
  assert.equal(derivePluginDataRoot(pluginRoot), "");
});

test("refuses to guess outside the cache layout", () => {
  const checkout = makeTempDir("skm-checkout-");
  assert.equal(derivePluginDataRoot(checkout), "");
  assert.equal(derivePluginDataRoot(""), "");
});

test("an explicit CLAUDE_PLUGIN_DATA always wins over derivation", () => {
  const { pluginRoot } = makeHostLayout();
  const env = { CLAUDE_PLUGIN_DATA: "/explicit/root" };
  assert.equal(resolvePluginDataRoot(pluginRoot, env), "/explicit/root");
});

test("a derived root is published to the env so children inherit it", () => {
  const { pluginRoot, expected } = makeHostLayout();
  const env = {};
  assert.equal(resolvePluginDataRoot(pluginRoot, env), expected);
  // Detached drain / backfill workers are spawned with `env: process.env`;
  // re-deriving in the child must not be required for them to agree.
  assert.equal(env.CLAUDE_PLUGIN_DATA, expected);
});

// `${CLAUDE_PLUGIN_ROOT}` in monitors.json / SKILL.md is substituted into the
// command text, not exported. Reading the plugin root from the environment is
// therefore never valid for those processes.
test("the plugin root comes from the caller, never from the environment", () => {
  const { pluginRoot, expected } = makeHostLayout();
  const env = { CLAUDE_PLUGIN_ROOT: "/somewhere/else" };
  assert.equal(resolvePluginDataRoot(pluginRoot, env), expected);
});

// Regression for v0.32.0 and v0.32.1. Monitors (monitors.json) and the
// `node ...` commands inside SKILL.md run with NEITHER CLAUDE_PLUGIN_DATA nor
// CLAUDE_PLUGIN_ROOT in their environment — the host only substitutes the root
// into the command text. v0.32.0 threw because the data dir was mandatory;
// v0.32.1 still threw because the derivation read the root from the env.
//
// This drives the real entrypoint the way the host launches it (bare `node
// <absolute path>`, cleared plugin env) rather than requiring a module in
// process, which is what let both regressions ship.
test("a monitor launched with no plugin env at all resolves its queue", () => {
  const { pluginRoot, expected } = makeHostLayout();
  const source = path.resolve(__dirname, "..", "scripts");
  fs.cpSync(source, path.join(pluginRoot, "scripts"), { recursive: true });
  writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "skillmeter", version: "9.9.9" })
  );

  // runNode re-spreads process.env, so a deleted key would come back; Node's
  // spawn omits keys whose value is undefined, which is how they stay unset.
  const env = { CLAUDE_PLUGIN_DATA: undefined, CLAUDE_PLUGIN_ROOT: undefined };

  const result = runNode(
    path.join(pluginRoot, "scripts", "lib", "paths.js"),
    [],
    { env }
  );
  // paths.js is a library: loading it must simply not throw.
  assert.equal(result.status, 0, result.stderr);

  const probe = runNode("-e", [
    "process.stdout.write(require(process.argv[1] + '/scripts/lib/paths').LOG_DIR)",
    pluginRoot,
  ], { env });
  assert.equal(probe.status, 0, probe.stderr);
  // The child derives from __dirname, which is a realpath; on macOS the temp
  // dir reaches it through the /var -> /private/var symlink.
  fs.mkdirSync(path.join(expected, "logs"), { recursive: true });
  assert.equal(
    fs.realpathSync(probe.stdout),
    fs.realpathSync(path.join(expected, "logs"))
  );
});

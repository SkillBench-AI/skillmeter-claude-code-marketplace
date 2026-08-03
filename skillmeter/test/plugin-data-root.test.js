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
  const env = {
    CLAUDE_PLUGIN_DATA: "/explicit/root",
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  };
  assert.equal(resolvePluginDataRoot(env), "/explicit/root");
});

test("a derived root is published to the env so children inherit it", () => {
  const { pluginRoot, expected } = makeHostLayout();
  const env = { CLAUDE_PLUGIN_ROOT: pluginRoot };
  assert.equal(resolvePluginDataRoot(env), expected);
  // Detached drain / backfill workers are spawned with `env: process.env`;
  // re-deriving in the child must not be required for them to agree.
  assert.equal(env.CLAUDE_PLUGIN_DATA, expected);
});

// Regression for v0.32.0: monitors (monitors.json) and the `node ...` commands
// inside SKILL.md are launched with CLAUDE_PLUGIN_ROOT substituted but WITHOUT
// CLAUDE_PLUGIN_DATA. Requiring paths.js threw there, which broke both monitors
// and every slash command while hooks kept working.
test("a plugin process without CLAUDE_PLUGIN_DATA still resolves its queue", () => {
  const { configRoot, pluginRoot, expected } = makeHostLayout();
  // Stand up just enough of the plugin tree to require lib/paths.js.
  const source = path.resolve(__dirname, "..", "scripts");
  fs.cpSync(source, path.join(pluginRoot, "scripts"), { recursive: true });
  writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "skillmeter", version: "9.9.9" })
  );

  const result = runNode("-e", [
    "process.stdout.write(require(process.env.P + '/scripts/lib/paths').LOG_DIR)",
  ], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: undefined,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      P: pluginRoot,
      HOME: configRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, path.join(expected, "logs"));
});

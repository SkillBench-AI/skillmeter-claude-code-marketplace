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

// Only hooks and MCP/LSP subprocesses get these exported; monitor commands and
// skill content get the `${...}` placeholders substituted instead. Reading the
// plugin root from the environment is therefore never valid for those.
test("the plugin root comes from the caller, never from the environment", () => {
  const { pluginRoot, expected } = makeHostLayout();
  const env = { CLAUDE_PLUGIN_ROOT: "/somewhere/else" };
  assert.equal(resolvePluginDataRoot(pluginRoot, env), expected);
});

test("an unsubstituted placeholder is never treated as a path", () => {
  const { pluginRoot, expected } = makeHostLayout();
  const env = { CLAUDE_PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}" };
  assert.equal(resolvePluginDataRoot(pluginRoot, env), expected);
});

test("monitor commands pass the data dir through the supported substitution", () => {
  const monitors = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "monitors", "monitors.json"), "utf8")
  );
  assert.ok(monitors.length > 0);
  for (const monitor of monitors) {
    assert.match(
      monitor.command,
      /CLAUDE_PLUGIN_DATA="\$\{CLAUDE_PLUGIN_DATA\}"/,
      `${monitor.name} must pass CLAUDE_PLUGIN_DATA explicitly`
    );
  }
});

// Skills cannot use the same trick as monitors: their `allowed-tools` grant is
// `Bash(node *)`, so an env-assignment prefix would stop matching and every
// command would prompt. Skill processes therefore rely on the derivation, and
// their commands must keep starting with `node`.
test("skill commands stay shaped for the Bash(node *) grant", () => {
  const skills = path.resolve(__dirname, "..", "skills");
  let checked = 0;
  for (const entry of fs.readdirSync(skills)) {
    const file = path.join(skills, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    assert.match(
      content,
      /allowed-tools:.*Bash\(node \*\)/,
      `${entry}/SKILL.md should grant Bash(node *)`
    );
    for (const line of content.split("\n")) {
      if (!line.includes("${CLAUDE_PLUGIN_ROOT}/scripts/")) continue;
      checked++;
      assert.match(
        line.trim(),
        // The path may be quoted (it can contain spaces); the command itself
        // must still start with `node`.
        /^node "?\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//,
        `${entry}/SKILL.md must invoke node directly: ${line.trim()}`
      );
    }
  }
  assert.ok(checked > 0, "expected skill commands to check");
});

// Run the real entrypoint without plugin environment variables, as skill
// commands may be launched. Verify data-root derivation from the install layout.
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

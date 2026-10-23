"use strict";
// The internal channel build defaults to dev; the stable build, which is what
// main ships, has no channel file and defaults to prod.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const config = require("../../../plugins/skillmeter/scripts/lib/config");

const repo = path.resolve(__dirname, "..", "..", "..");
// The monorepo root: the channel build and both marketplaces live there.
const repoRoot = path.resolve(repo, "..", "..");
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test("main ships no channel file, so installs default to prod", () => {
  assert.equal(fs.existsSync(config.CHANNEL_FILE), false, "channel.json belongs only to the internal branch");
  assert.deepEqual(config.channel(), { channel: "stable", env: "prod" });
});

test("only the exact internal shape selects a channel", t => {
  const file = path.join(tmp(t), "channel.json");
  const read = value => { fs.writeFileSync(file, value); return config.channel(file); };
  assert.deepEqual(read('{"channel":"internal","env":"dev"}'), { channel: "internal", env: "dev" });
  for (const bad of ["{", "[]", '{"channel":"internal","env":"staging"}', '{"channel":"../x","env":"dev"}', '{"env":"dev"}']) {
    assert.deepEqual(read(bad), { channel: "stable", env: "prod" }, bad);
  }
});

test("the internal build uses dev regardless of the environment", t => {
  const root = tmp(t);
  // The build covers both clients, so the Claude Code manifests come along.
  for (const file of [".github/scripts/make-internal-channel.mjs", ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json", "clients/claude-code/skillmeter/.claude-plugin/plugin.json",
    "clients/codex/plugins/skillmeter/scripts/lib/config.js", "clients/codex/plugins/skillmeter/scripts/lib/endpoints.js",
    "clients/codex/plugins/skillmeter/.codex-plugin/plugin.json"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), path.join(root, file));
  }
  execFileSync(process.execPath, [path.join(root, ".github/scripts/make-internal-channel.mjs"), root, "--build", "7"]);
  const client = path.join(root, "clients/codex");
  // The internal build is a prerelease of the next patch: after the current
  // release and before the next one.
  const [major, minor, patch] = require(path.join(repo, "plugins/skillmeter/.codex-plugin/plugin.json")).version.split(".").map(Number);
  assert.equal(JSON.parse(fs.readFileSync(path.join(client, "plugins/skillmeter/.codex-plugin/plugin.json"), "utf8")).version,
    `${major}.${minor}.${patch + 1}-internal.7`);
  for (const manifest of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, manifest), "utf8")).name, "skillbench-internal");
  }
  const probe = "const c=require('./plugins/skillmeter/scripts/lib/config');console.log(JSON.stringify([c.channel().env,c.brokerUrl(),require('path').basename(c.stateDir())]))";
  const run = env => JSON.parse(spawnSync(process.execPath, ["-e", probe], { cwd: client, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, ...env } }).stdout);
  assert.deepEqual(run({}), ["dev", "https://id.dev.skillbench.com", ".skillbench-dev"]);
  assert.deepEqual(run({ SKILLMETER_ENV: "prod" }), ["dev", "https://id.dev.skillbench.com", ".skillbench-dev"]);
});

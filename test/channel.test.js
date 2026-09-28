"use strict";

// The internal channel build defaults to dev; the stable build, which is what
// main ships, has no channel file and defaults to prod.
// Run: node --test test/channel.test.js

require("../testing/bootstrap");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const config = require("../skillmeter/scripts/lib/config");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillmeter-channel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("main ships no channel file, so installs default to prod", () => {
  assert.equal(fs.existsSync(config.CHANNEL_FILE), false, "channel.json belongs only to the internal branch");
  assert.deepEqual(config.readChannel(), { channel: "stable", env: "prod" });
});

test("only the exact internal shape selects a channel", (t) => {
  const file = path.join(tempDir(t), "channel.json");
  const read = (value) => {
    fs.writeFileSync(file, value);
    return config.readChannel(file);
  };
  assert.deepEqual(read('{"channel":"internal","env":"dev"}'), { channel: "internal", env: "dev" });
  for (const bad of ["{", "[]", '{"channel":"internal","env":"staging"}', '{"channel":"../x","env":"dev"}', '{"env":"dev"}']) {
    assert.deepEqual(read(bad), { channel: "stable", env: "prod" }, bad);
  }
});

test("the internal build uses dev regardless of the environment", (t) => {
  const root = tempDir(t);
  for (const file of [".github/scripts/make-internal-channel.mjs", ".claude-plugin/marketplace.json",
    "skillmeter/scripts/lib/config.js"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  execFileSync(process.execPath, [path.join(root, ".github/scripts/make-internal-channel.mjs"), root]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8")).name,
    "skillbench-internal");
  const probe = "const c=require('./skillmeter/scripts/lib/config');" +
    "console.log(JSON.stringify([c.CHANNEL.env,c.getDeviceCodeUrl(),require('path').basename(c.STATE_DIR)]))";
  const run = (env) => JSON.parse(spawnSync(process.execPath, ["-e", probe], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, ...env },
  }).stdout);
  assert.deepEqual(run({}), ["dev", "https://id.dev.skillbench.com/oauth2/device/auth", ".skillbench-dev"]);
  assert.deepEqual(run({ SKILLMETER_ENV: "prod" }), ["dev", "https://id.dev.skillbench.com/oauth2/device/auth", ".skillbench-dev"]);
});

test("an environment variable cannot switch a stable install to dev", () => {
  const probe = "const c=require('./skillmeter/scripts/lib/config');" +
    "console.log(JSON.stringify([c.CHANNEL.env,c.getDeviceCodeUrl(),require('path').basename(c.STATE_DIR)]))";
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: os.tmpdir(), SKILLMETER_ENV: "dev" },
  });
  assert.deepEqual(JSON.parse(result.stdout), ["prod", "https://id.skillbench.ai/oauth2/device/auth", ".skillbench"]);
});

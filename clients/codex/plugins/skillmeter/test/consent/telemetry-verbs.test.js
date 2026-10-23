"use strict";
// The telemetry commands shared with the Claude Code plugin: enable/disable
// for this repository, enable-global/disable-global, the list picker's toggle,
// and the Codex-only restrict/unrestrict.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PLUGIN_ROOT, tempDir, writeCredentials, license, makeRepo, consentPolicyFileIn } = require("../../test-support/plugin.cjs");

function setup(t) {
  const home = tempDir("sk-verbs-home");
  const codexHome = path.join(home, ".codex");
  writeCredentials(home, { device_id: "DEV-1", hash_salt: "abcd", license_jwt: license({ orgs: ["acme"] }), refresh_token: "synthetic-refresh" });
  const widgets = makeRepo({ remote: "git@github.com:acme/widgets.git" });
  const gears = makeRepo({ remote: "https://github.com/acme/gears.git" });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), `[projects."${widgets}"]\n[projects."${gears}"]\n`);
  t.after(() => { for (const dir of [home, widgets, gears]) fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, PLUGIN_DATA: path.join(home, "data"),
    SKILLMETER_STATE_DIR: "", SKILLMETER_REPO_SCOPE_ORGS: "", SKILLMETER_BROKER_URL: "http://127.0.0.1:9" };
  const run = (script, args, cwd = widgets) => spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", script), ...args],
    { cwd, env, encoding: "utf8", timeout: 20000 });
  const telemetry = (args, cwd) => run("telemetry.js", args, cwd);
  const repos = (args, cwd) => {
    const result = run("repository_telemetry.js", args, cwd);
    return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const policyFile = consentPolicyFileIn(path.join(home, ".skillbench"));
  const policy = () => JSON.parse(fs.readFileSync(policyFile, "utf8"));
  const authorize = () => assert.equal(repos(["org", "absent", "acme", "enabled", "--acknowledge-machine-scope"]).status, 0);
  const localSettings = root => path.join(root, ".codex", "settings.local.json");
  return { widgets, gears, telemetry, repos, policy, policyFile, authorize, localSettings };
}

test("enable records this repository ON only with the organization ON and the acknowledgement", t => {
  const f = setup(t);
  assert.match(f.telemetry(["enable"]).stderr, /ACKNOWLEDGEMENT_REQUIRED/);
  assert.match(f.telemetry(["enable", "--acknowledge-machine-scope"]).stderr, /ORGANIZATION_CONSENT_REQUIRED/);
  assert.equal(fs.existsSync(f.policyFile), false);

  f.authorize();
  const result = f.telemetry(["enable", "--acknowledge-machine-scope"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TELEMETRY ON/);
  assert.equal(f.policy().repositories["github.com/acme/widgets"].consent_version, 2);
  assert.equal(fs.existsSync(f.localSettings(f.widgets)), false, "no local settings are written");
});

test("disable records this repository OFF in the consent record, not in local settings", t => {
  const f = setup(t);
  f.authorize();
  f.telemetry(["enable", "--acknowledge-machine-scope"]);
  const result = f.telemetry(["disable"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REPOSITORY OFF/);
  assert.equal(f.policy().repositories["github.com/acme/widgets"].enabled, false);
  assert.equal(fs.existsSync(f.localSettings(f.widgets)), false);
});

test("enable-global and disable-global pause and resume Codex", t => {
  const f = setup(t);
  assert.match(f.telemetry(["disable-global"]).stderr, /paused for Codex/);
  assert.equal(f.policy().global.enabled, false);
  assert.match(f.telemetry(["enable-global"]).stderr, /resumed for Codex/);
  assert.equal(f.policy().global.enabled, true);
});

test("restrict writes a local OFF that blocks enable until unrestrict clears it", t => {
  const f = setup(t);
  f.authorize();
  assert.equal(f.telemetry(["restrict"]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.localSettings(f.widgets))).skillmeter.telemetry, false);
  assert.match(f.telemetry(["enable", "--acknowledge-machine-scope"]).stderr, /LOCAL_CONSENT_CONFLICT/);
  assert.equal(f.telemetry(["unrestrict"]).status, 0);
  assert.equal(f.telemetry(["enable", "--acknowledge-machine-scope"]).status, 0);
});

test("toggle flips the selected repositories in one revision and reports blocked ones", t => {
  const f = setup(t);
  const blocked = f.repos(["list"]).json;
  assert.deepEqual(blocked.repositories.map(repo => [repo.action, repo.blockedBy]),
    [[null, "organization_choice_required"], [null, "organization_choice_required"]]);
  const none = f.repos(["toggle", "absent", "github.com/acme/widgets"]);
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(none.json.results.map(repo => [repo.changed, repo.reason]), [[false, "organization_choice_required"]]);
  assert.equal(fs.existsSync(f.policyFile), false, "nothing to change spends no revision");

  f.authorize();
  f.telemetry(["enable", "--acknowledge-machine-scope"]);
  const list = f.repos(["list"]).json;
  assert.deepEqual(list.repositories.map(repo => [repo.displayName, repo.action]), [["@acme/gears", "enable"], ["@acme/widgets", "disable"]]);
  assert.match(f.repos(["toggle", String(list.revision), "github.com/acme/gears"]).stderr, /ACKNOWLEDGEMENT_REQUIRED/);

  const result = f.repos(["toggle", String(list.revision), "github.com/acme/gears", "github.com/acme/widgets", "--acknowledge-machine-scope"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.revision, list.revision + 1);
  assert.deepEqual(result.json.results.map(repo => [repo.displayName, repo.changed, repo.effective]),
    [["@acme/gears", true, "on"], ["@acme/widgets", true, "off"]]);
});

test("only signin, signout and telemetry opt out of implicit invocation", () => {
  const skills = path.join(PLUGIN_ROOT, "skills");
  for (const name of fs.readdirSync(skills)) {
    const file = path.join(skills, name, "agents", "openai.yaml");
    const explicitOnly = ["signin", "signout", "telemetry"].includes(name);
    assert.equal(fs.existsSync(file) && /^\s*allow_implicit_invocation:\s*false\s*$/m.test(fs.readFileSync(file, "utf8")), explicitOnly, name);
  }
});

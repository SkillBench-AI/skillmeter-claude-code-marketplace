"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  isolatedEnv,
  makeJwt,
  makeTempDir,
  runNode,
  writeCredentials,
  writeFile,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const ORG = "skillbench-ai";
const REPO_KEY = `github.com/${ORG}/expansion`;

function fixture() {
  const stateDir = makeTempDir("skm-expansion-state-");
  const dataDir = makeTempDir("skm-expansion-data-");
  const repo = makeTempDir("skm-expansion-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    `[remote "origin"]\n\turl = https://github.com/${ORG}/expansion.git\n`
  );
  writeCredentials(stateDir, {
    device_id: "EXPANSION-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: ORG },
      orgs: [ORG],
      aud: "https://acme.meter.skillbench.example",
    }),
    refresh_token: "ory_rt_fixture",
  }, { dataDir });
  writeTelemetryPolicy(stateDir, { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
  const env = isolatedEnv({
    SKILLMETER_STATE_DIR: stateDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    SKILLMETER_ACTIVATE_URL: "http://127.0.0.1:9/activate",
    SKILLMETER_BROKER_URL: "http://127.0.0.1:9",
    SKILLMETER_BACKEND_URL: "http://127.0.0.1:9",
  });
  const queuedEvents = () => {
    const root = path.join(dataDir, "logs", "repositories");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).flatMap((id) =>
      fs.readdirSync(path.join(root, id))
        .filter((name) => /^events\.jsonl/.test(name))
        .flatMap((name) =>
          fs.readFileSync(path.join(root, id, name), "utf8")
            .split("\n").filter(Boolean).map((line) => JSON.parse(line))
        )
    );
  };
  return { repo, env, queuedEvents };
}

test("a directly typed command records its name but not its arguments", () => {
  const f = fixture();
  const result = runNode(path.join(SCRIPTS, "hook.js"), ["UserPromptExpansion"], {
    cwd: f.repo,
    env: f.env,
    input: JSON.stringify({
      session_id: "expansion",
      cwd: f.repo,
      hook_event_name: "UserPromptExpansion",
      expansion_type: "slash_command",
      command_name: "superpowers:brainstorming",
      command_args: "private-argument-text",
      command_source: "plugin",
      prompt: "/superpowers:brainstorming private-argument-text",
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "an observation hook prints nothing");

  const events = f.queuedEvents().filter((e) => e.hook_event_name === "UserPromptExpansion");
  assert.equal(events.length, 1);
  assert.equal(events[0].data.expansion_type, "slash_command");
  assert.equal(events[0].data.command_name, "superpowers:brainstorming");
  assert.equal(events[0].data.command_source, "plugin");
  assert.doesNotMatch(JSON.stringify(events[0]), /private-argument-text/);
});

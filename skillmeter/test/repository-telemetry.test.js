"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  collectTranscriptCwds,
  getClaudeProjectsDir,
  repositoryNameFromRemote,
  safeDisplayComponent,
} = require("../scripts/lib/repository-telemetry");
const {
  makeJwt,
  makeTempDir,
  readJson,
  runNode,
  writeFile,
  writeJson,
} = require("../testing/helpers");

const REPOSITORY_TELEMETRY_SCRIPT = path.resolve(
  __dirname,
  "../scripts/repository_telemetry.js"
);
const TELEMETRY_SCRIPT = path.resolve(__dirname, "../scripts/telemetry.js");
const HOOK_SCRIPT = path.resolve(__dirname, "../scripts/hook.js");
const TELEMETRY_SKILL = fs.readFileSync(
  path.resolve(__dirname, "../skills/telemetry/SKILL.md"),
  "utf8"
);

function makeRepo(parent, name, owner) {
  const repo = path.join(parent, name);
  writeFile(
    path.join(repo, ".git", "config"),
    [
      '[remote "origin"]',
      `  url = https://github.com/${owner}/${name}.git`,
      "",
    ].join("\n")
  );
  return repo;
}

function writeTranscript(projectsDir, projectName, sessionId, records) {
  writeFile(
    path.join(projectsDir, projectName, `${sessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
}

function testEnvironment() {
  const temp = makeTempDir("skm-repository-telemetry-");
  const stateDir = path.join(temp, "state");
  const claudeConfigDir = path.join(temp, "claude");
  const projectsDir = path.join(claudeConfigDir, "projects");
  const reposDir = path.join(temp, "repos");
  const repoA = makeRepo(reposDir, "repo-a", "skillbench-ai");
  const repoAClone = makeRepo(reposDir, "repo-a-clone", "skillbench-ai");
  writeFile(
    path.join(repoAClone, ".git", "config"),
    '[remote "origin"]\n  url = https://github.com/skillbench-ai/repo-a.git\n'
  );
  const repoB = makeRepo(reposDir, "repo-b", "skillbench-ai");
  const repoC = makeRepo(reposDir, "repo-c", "skillbench-ai");
  const ambiguousRepo = makeRepo(reposDir, "ambiguous", "skillbench-ai");
  writeFile(
    path.join(ambiguousRepo, ".git", "config"),
    [
      '[remote "origin"]',
      "  url = https://github.com/skillbench-ai/one.git",
      "  url = https://github.com/skillbench-ai/two.git",
      "",
    ].join("\n")
  );
  const externalRepo = makeRepo(reposDir, "external", "another-org");

  writeJson(path.join(repoA, ".claude", "settings.local.json"), {
    skillmeter: { telemetry: false },
  });
  writeJson(path.join(repoC, ".claude", "settings.local.json"), {
    skillmeter: { telemetry: true },
  });
  writeJson(path.join(repoAClone, ".claude", "settings.local.json"), {
    skillmeter: { telemetry: true },
  });

  writeTranscript(
    projectsDir,
    "project-a",
    "11111111-1111-4111-8111-111111111111",
    [
      { type: "user", cwd: repoA },
      { type: "assistant", cwd: repoAClone },
      { type: "assistant", message: { content: `{"cwd":"${externalRepo}"}` } },
      { type: "user", cwd: repoB },
      { type: "assistant", cwd: ambiguousRepo },
    ]
  );
  writeTranscript(
    projectsDir,
    "project-c",
    "22222222-2222-4222-8222-222222222222",
    [
      { type: "user", cwd: repoC },
      { type: "assistant", cwd: externalRepo },
    ]
  );
  writeFile(
    path.join(projectsDir, "project-a", "not-a-session.jsonl"),
    JSON.stringify({ cwd: externalRepo }) + "\n"
  );

  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "repository-telemetry-test",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: "skillbench-ai" },
    }),
    org_telemetry_migration_version: 1,
    org_telemetry_consents: {
      "skillbench-ai": {
        enabled: true,
        policy_version: 1,
        source: "user",
      },
    },
  });

  return {
    stateDir,
    claudeConfigDir,
    reposDir,
    repoA,
    repoAClone,
    repoB,
    repoC,
    externalRepo,
    ambiguousRepo,
    env: {
      ...process.env,
      HOME: temp,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      SKILLMETER_STATE_DIR: stateDir,
    },
  };
}

test("Claude projects directory honors CLAUDE_CONFIG_DIR", () => {
  assert.equal(
    getClaudeProjectsDir({
      env: { CLAUDE_CONFIG_DIR: "/tmp/custom-claude" },
      homeDir: "/unused",
    }),
    path.join("/tmp/custom-claude", "projects")
  );
  assert.equal(
    getClaudeProjectsDir({ env: {}, homeDir: "/home/tester" }),
    path.join("/home/tester", ".claude", "projects")
  );
});

test("repository display components remove control and prompt syntax", () => {
  assert.equal(
    safeDisplayComponent("repo name\n`malicious`"),
    "repo-name-malicious"
  );
  assert.equal(safeDisplayComponent(""), "repository");
  assert.equal(
    repositoryNameFromRemote(
      "git@github.com:skillbench-ai/canonical-repo.git"
    ),
    "canonical-repo"
  );
  assert.equal(
    repositoryNameFromRemote(
      "https://github.com/skillbench-ai/repo%20name.git?token=ignored"
    ),
    "repo-name"
  );
});

test("transcript discovery reads cwd and structured path fields only", async () => {
  const temp = makeTempDir("skm-repository-cwds-");
  const transcript = path.join(temp, "session.jsonl");
  writeFile(
    transcript,
    [
      JSON.stringify({ type: "user", cwd: "/repo/one" }),
      JSON.stringify({
        type: "assistant",
        message: { content: '{"cwd":"/repo/not-top-level"}' },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: {
          filePath: "/repo/from-tool/src/index.js",
          edits: [{ file_path: "/repo/from-edit/README.md" }],
        },
      }),
      "{malformed",
      JSON.stringify({ type: "user", cwd: "/repo/two" }),
      "",
    ].join("\n")
  );

  assert.deepEqual(
    (await collectTranscriptCwds(transcript)).sort(),
    [
      "/repo/from-edit/README.md",
      "/repo/from-tool/src/index.js",
      "/repo/one",
      "/repo/two",
    ]
  );
});

test("repository list shows effective enabled and disabled org repositories", () => {
  const fixture = testEnvironment();
  const result = runNode(REPOSITORY_TELEMETRY_SCRIPT, ["list"], {
    cwd: fixture.repoA,
    env: fixture.env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(fixture.reposDir));

  const output = JSON.parse(result.stdout);
  assert.equal(
    output.repositories.length,
    3,
    JSON.stringify(output.repositories, null, 2)
  );
  assert.deepEqual(output.summary, {
    enabled: 2,
    disabled: 1,
    actionable: 3,
  });
  assert.equal(output.repositories.length, 3);
  assert.deepEqual(
    output.repositories.map((repo) => repo.optionLabel),
    [
      "OFF · @skillbench-ai/repo-a",
      "ON · @skillbench-ai/repo-b",
      "ON · @skillbench-ai/repo-c",
    ]
  );

  const repoA = output.repositories.find(
    (repo) => repo.displayName === "@skillbench-ai/repo-a"
  );
  const repoB = output.repositories.find(
    (repo) => repo.displayName === "@skillbench-ai/repo-b"
  );
  const repoC = output.repositories.find(
    (repo) => repo.displayName === "@skillbench-ai/repo-c"
  );
  assert.deepEqual(
    [repoA.effective, repoA.mode, repoA.projectSetting, repoA.action],
    ["disabled", "project_disabled", "disabled", "enable"]
  );
  assert.deepEqual(
    [repoB.effective, repoB.mode, repoB.projectSetting, repoB.action],
    ["enabled", "org_enabled", "inherit", "disable"]
  );
  assert.deepEqual(
    [repoC.effective, repoC.mode, repoC.projectSetting, repoC.action],
    ["enabled", "project_enabled", "enabled", "disable"]
  );
  assert.ok(output.repositories.every((repo) => !("repoRoot" in repo)));
  assert.ok(output.repositories.every((repo) => /^[0-9a-f]{12}$/.test(repo.id)));
});

test("repository toggle applies only a validated local repository ID", () => {
  const fixture = testEnvironment();
  const listed = runNode(REPOSITORY_TELEMETRY_SCRIPT, ["list"], {
    cwd: fixture.repoA,
    env: fixture.env,
  });
  const listOutput = JSON.parse(listed.stdout);
  const repoA = listOutput.repositories.find(
    (repo) => repo.displayName === "@skillbench-ai/repo-a"
  );

  const toggled = runNode(
    REPOSITORY_TELEMETRY_SCRIPT,
    ["toggle", String(listOutput.revision), repoA.id],
    { cwd: fixture.repoA, env: fixture.env }
  );

  assert.equal(toggled.status, 0, toggled.stderr);
  assert.deepEqual(JSON.parse(toggled.stdout).results, [
    {
      id: repoA.id,
      displayName: "@skillbench-ai/repo-a",
      changed: true,
      effective: "enabled",
    },
  ]);
  assert.equal(
    readJson(path.join(fixture.stateDir, "telemetry-policy.json"))
      .repositories["github.com/skillbench-ai/repo-a"].enabled,
    true
  );
  assert.equal(
    fs.existsSync(path.join(fixture.repoA, ".claude", "settings.local.json")),
    false
  );

  const invalid = runNode(
    REPOSITORY_TELEMETRY_SCRIPT,
    ["toggle", String(listOutput.revision), fixture.repoA],
    { cwd: fixture.repoA, env: fixture.env }
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /valid repository IDs/);
});

test("per-project telemetry commands write the repository SSOT from a nested cwd", () => {
  const fixture = testEnvironment();
  const nestedCwd = path.join(fixture.repoA, "packages", "app");
  writeFile(path.join(nestedCwd, ".keep"));

  const enabled = runNode(TELEMETRY_SCRIPT, ["enable"], {
    cwd: nestedCwd,
    env: fixture.env,
  });

  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(
    readJson(path.join(fixture.stateDir, "telemetry-policy.json"))
      .repositories["github.com/skillbench-ai/repo-a"].enabled,
    true
  );
  assert.equal(
    fs.existsSync(path.join(nestedCwd, ".claude", "settings.local.json")),
    false
  );
});

test("repository picker rejects a stale list revision", () => {
  const fixture = testEnvironment();
  const listed = JSON.parse(
    runNode(REPOSITORY_TELEMETRY_SCRIPT, ["list"], {
      cwd: fixture.repoA,
      env: fixture.env,
    }).stdout
  );
  const repoA = listed.repositories.find(
    (repo) => repo.displayName === "@skillbench-ai/repo-a"
  );

  const enabled = runNode(TELEMETRY_SCRIPT, ["enable"], {
    cwd: fixture.repoA,
    env: fixture.env,
  });
  assert.equal(enabled.status, 0, enabled.stderr);

  const stale = runNode(
    REPOSITORY_TELEMETRY_SCRIPT,
    ["toggle", String(listed.revision), repoA.id],
    { cwd: fixture.repoA, env: fixture.env }
  );
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).stale, true);
  assert.equal(
    readJson(path.join(fixture.stateDir, "telemetry-policy.json"))
      .repositories["github.com/skillbench-ai/repo-a"].enabled,
    true
  );
});

test("live hook honors a git-root repository opt-out from a nested cwd", () => {
  const fixture = testEnvironment();
  const nestedCwd = path.join(fixture.repoA, "packages", "app");
  const pluginData = path.join(fixture.stateDir, "plugin-data");
  writeFile(path.join(nestedCwd, ".keep"));

  const result = runNode(HOOK_SCRIPT, ["UserPromptSubmit"], {
    cwd: nestedCwd,
    env: {
      ...fixture.env,
      CLAUDE_PLUGIN_DATA: pluginData,
    },
    input: JSON.stringify({
      session_id: "repository-telemetry-nested-cwd",
      cwd: nestedCwd,
      prompt: "test prompt",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /telemetry disabled for this project/);
  assert.equal(
    fs.existsSync(path.join(pluginData, "logs", "events.jsonl")),
    false
  );
});

test("global kill-switch lists repositories as blocked and prevents toggles", () => {
  const fixture = testEnvironment();
  const credentialPath = path.join(fixture.stateDir, "credentials.json");
  const credentials = readJson(credentialPath);
  credentials.telemetry_disabled = true;
  writeJson(credentialPath, credentials);

  const listed = runNode(REPOSITORY_TELEMETRY_SCRIPT, ["list"], {
    cwd: fixture.repoA,
    env: fixture.env,
  });
  assert.equal(listed.status, 0, listed.stderr);
  const output = JSON.parse(listed.stdout);
  assert.deepEqual(output.summary, {
    enabled: 0,
    disabled: 3,
    actionable: 0,
  });
  assert.ok(
    output.repositories.every(
      (repo) => repo.mode === "global_disabled" && repo.action === null
    )
  );

  const blocked = runNode(
    REPOSITORY_TELEMETRY_SCRIPT,
    ["toggle", String(output.revision), output.repositories[0].id],
    { cwd: fixture.repoA, env: fixture.env }
  );
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual(JSON.parse(blocked.stdout).results, [
    {
      id: output.repositories[0].id,
      displayName: output.repositories[0].displayName,
      changed: false,
      reason: "global_disabled",
    },
  ]);
});

test("telemetry skill routes list through the repository toggle UI", () => {
  assert.match(TELEMETRY_SKILL, /allowed-tools: AskUserQuestion Bash\(node \*\)/);
  assert.match(TELEMETRY_SKILL, /argument-hint: <list>/);
  assert.doesNotMatch(TELEMETRY_SKILL, /argument-hint:.*enable/);
  assert.match(TELEMETRY_SKILL, /`\$ARGUMENTS` is empty or exactly `list`/);
  assert.match(
    TELEMETRY_SKILL,
    /repository_telemetry\.js list/
  );
  assert.match(TELEMETRY_SKILL, /multiSelect: true/);
  assert.match(TELEMETRY_SKILL, /Space selects changes/);
  assert.match(
    TELEMETRY_SKILL,
    /repository_telemetry\.js toggle REVISION ID\.\.\./
  );
  assert.match(TELEMETRY_SKILL, /passing only the validated/);
});

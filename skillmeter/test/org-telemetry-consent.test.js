"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  makeTempDir,
  makeJwt,
  readJson,
  runNode,
  writeFile,
  writeJson,
} = require("../testing/helpers");
const credstore = require("../scripts/credstore");
const { resolveTelemetryGate } = require("../scripts/lib/telemetry-policy");

function licenseJwt(org = "SkillBench-AI") {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    org: { login: org },
  });
}

const SIGNIN_SKILL = fs.readFileSync(
  path.resolve(__dirname, "../skills/signin/SKILL.md"),
  "utf8"
);

const CONSENT_UI_CASES = [
  {
    state: "unset",
    sectionStart: 'For an org whose `consent` is `null`',
    sectionEnd: 'For an org whose `consent` is `true`',
    enableLabel: "Label: `Enable listed repositories`",
    deferLabel: "Label: `Keep telemetry off`",
  },
  {
    state: "enabled",
    sectionStart: 'For an org whose `consent` is `true`',
    sectionEnd: 'For an org whose `consent` is `false`',
    enableLabel: "Label: `Keep authorized`",
    deferLabel: "Label: `Turn telemetry off`",
  },
  {
    state: "disabled",
    sectionStart: 'For an org whose `consent` is `false`',
    sectionEnd: "Apply the telemetry choice immediately",
    enableLabel: "Label: `Authorize @ORG`",
    deferLabel: "Label: `Keep off for now`",
  },
];

for (const uiCase of CONSENT_UI_CASES) {
  test(`signin UI puts telemetry on first for ${uiCase.state} consent`, () => {
    const start = SIGNIN_SKILL.indexOf(uiCase.sectionStart);
    const end = SIGNIN_SKILL.indexOf(uiCase.sectionEnd, start);
    const section = SIGNIN_SKILL.slice(start, end);
    assert.ok(start >= 0 && end > start, `${uiCase.state} consent section exists`);
    assert.ok(section.includes(uiCase.enableLabel), `${uiCase.enableLabel} exists`);
    assert.ok(section.includes(uiCase.deferLabel), `${uiCase.deferLabel} exists`);
    assert.ok(
      section.indexOf(uiCase.enableLabel) < section.indexOf(uiCase.deferLabel),
      "enable option must appear before off/later"
    );
  });
}

test("first sign-in offers one combined organization and repository choice", () => {
  assert.match(
    SIGNIN_SKILL,
    /`Repositories found:` and every matching repository's exact `displayName`/
  );
  assert.match(SIGNIN_SKILL, /repository_telemetry\.js list/);
  assert.match(SIGNIN_SKILL, /one per line/);
  assert.match(
    SIGNIN_SKILL,
    /one combined, single-select telemetry\s+question/
  );
  assert.doesNotMatch(SIGNIN_SKILL, /multiSelect: true/);
  const enabled = "Label: `Enable listed repositories`";
  const organizationOnly = "Label: `Organization only`";
  const off = "Label: `Keep telemetry off`";
  assert.ok(SIGNIN_SKILL.indexOf(enabled) < SIGNIN_SKILL.indexOf(organizationOnly));
  assert.ok(SIGNIN_SKILL.indexOf(organizationOnly) < SIGNIN_SKILL.indexOf(off));
  assert.doesNotMatch(SIGNIN_SKILL, /Header: `Repositories`/);
  assert.doesNotMatch(
    SIGNIN_SKILL,
    /Allow SkillMeter telemetry for repositories owned by/
  );
  assert.match(
    SIGNIN_SKILL,
    /repository_telemetry\.js onboard REVISION "ORG" enabled ID\.\.\./
  );
  assert.match(
    SIGNIN_SKILL,
    /repository_telemetry\.js onboard REVISION "ORG" disabled ID\.\.\./
  );
  assert.match(
    SIGNIN_SKILL,
    /organization and\s+repository settings remain\s+unchanged/
  );
  assert.match(SIGNIN_SKILL, /`Telemetry ON \(N\)`/);
  assert.match(SIGNIN_SKILL, /`Telemetry OFF \(N\)`/);
});

test("one-time backfill is separate from every telemetry choice", () => {
  const repositoryChoice = SIGNIN_SKILL.indexOf(
    "Label: `Enable listed repositories`"
  );
  const telemetryOffChoice = SIGNIN_SKILL.indexOf(
    "Label: `Keep telemetry off`"
  );
  const historyChoice = SIGNIN_SKILL.indexOf("Header: `History`");
  assert.ok(repositoryChoice >= 0 && historyChoice > repositoryChoice);
  assert.ok(telemetryOffChoice >= 0 && historyChoice > telemetryOffChoice);
  assert.match(
    SIGNIN_SKILL,
    /Historical consent is independent of ongoing telemetry/
  );
  assert.match(
    SIGNIN_SKILL,
    /even when telemetry was kept off, turned off, organization-only,\s+or the telemetry question was cancelled/
  );
  assert.match(SIGNIN_SKILL, /backfill\.js claim ACTIVE_SESSION_ID/);
  assert.match(SIGNIN_SKILL, /Label: `Send history`/);
  assert.match(SIGNIN_SKILL, /Label: `Skip`/);
  assert.match(
    SIGNIN_SKILL,
    /backfill\.js accept OFFER_ID REVISION "ORG" ID\.\.\./
  );
  assert.match(SIGNIN_SKILL, /backfill\.js decline OFFER_ID/);
  assert.match(
    SIGNIN_SKILL,
    /without changing organization or repository telemetry/
  );
  assert.doesNotMatch(
    SIGNIN_SKILL,
    /consume\s+the offer without displaying a History question/
  );
});

const ENABLED_POLICY = {
  globalDisabled: false,
  hasValidLicense: true,
  repoOrgOwned: true,
  orgConsent: true,
  projectOptIn: null,
};

const POLICY_CASES = [
  [
    "org authorization still requires a repository choice",
    {},
    { capture: false, mode: "repository_consent_required" },
  ],
  [
    "explicit project enable records its mode",
    { projectOptIn: true },
    { capture: true, mode: "project_enabled" },
  ],
  [
    "project opt-out wins over org enable",
    { projectOptIn: false },
    { capture: false, mode: "project_disabled" },
  ],
  [
    "missing org consent blocks capture",
    { orgConsent: null },
    { capture: false, mode: "org_consent_required" },
  ],
  [
    "disabled org blocks capture",
    { orgConsent: false },
    { capture: false, mode: "org_disabled" },
  ],
  [
    "external repo blocks capture",
    { repoOrgOwned: false },
    { capture: false, mode: "out_of_scope" },
  ],
  [
    "missing sign-in blocks capture",
    { hasValidLicense: false },
    { capture: false, mode: "not_signed_in" },
  ],
  [
    "missing cwd blocks capture before repository ownership",
    { cwdAvailable: false },
    { capture: false, mode: "cwd_unavailable" },
  ],
  [
    "global kill-switch has highest precedence",
    { globalDisabled: true, hasValidLicense: false, repoOrgOwned: false },
    { capture: false, mode: "global_disabled" },
  ],
];

for (const [name, overrides, expected] of POLICY_CASES) {
  test(`telemetry policy: ${name}`, () => {
    assert.deepEqual(resolveTelemetryGate({ ...ENABLED_POLICY, ...overrides }), expected);
  });
}

test("org consent CLI validates the JWT org and persists the explicit choice", () => {
  const stateDir = makeTempDir("skm-org-consent-");
  const credentialPath = path.join(stateDir, "credentials.json");
  writeJson(credentialPath, {
    license_jwt: licenseJwt(),
    org_telemetry_migration_version: 1,
  });

  const script = path.resolve(__dirname, "../scripts/org_telemetry_consent.js");
  const env = { ...process.env, SKILLMETER_STATE_DIR: stateDir };

  const initial = runNode(script, ["status"], { env });
  assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout).orgs, [
    { org: "skillbench-ai", consent: null },
  ]);

  const enabled = runNode(script, ["set", "skillbench-ai", "enabled"], { env });
  assert.equal(enabled.status, 0, enabled.stderr);
  const stored = readJson(path.join(stateDir, "telemetry-policy.json"));
  assert.equal(stored.organizations["skillbench-ai"].enabled, true);
  assert.equal(stored.organizations["skillbench-ai"].source, "user");

  const rejected = runNode(script, ["set", "other-org", "enabled"], { env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /not present in the current valid license/);
});

test("signin expansion emits an explicit pending-consent state for a new sign-in", () => {
  const stateDir = makeTempDir("skm-org-consent-");
  const dataDir = makeTempDir("skm-org-consent-data-");
  const claudeConfigDir = makeTempDir("skm-org-consent-");
  writeJson(path.join(dataDir, "backfill-state.json"), {
    schema_version: 1,
    lifecycle_id: "fresh-test-lifecycle",
    status: "pending",
    reason: "one_time_offer",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  writeJson(path.join(stateDir, "credentials.json"), {
    license_jwt: licenseJwt(),
    org_telemetry_migration_version: 1,
  });

  const script = path.resolve(
    __dirname,
    "../scripts/user_prompt_expansion_signin.js"
  );
  const result = runNode(script, [], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      SKILLMETER_STATE_DIR: stateDir,
    },
    input: JSON.stringify({
      command_name: "skillmeter:signin",
      command_source: "plugin",
      cwd: path.resolve(__dirname, "../.."),
      session_id: "11111111-1111-4111-8111-111111111111",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /SkillMeter sign-in state JSON:/);
  const state = JSON.parse(context.split("SkillMeter sign-in state JSON:\n")[1]);
  assert.deepEqual(state.orgs, [{ org: "skillbench-ai", consent: null }]);
  assert.deepEqual(state.backfill, {
    eligible: true,
    status: "pending",
    activeSessionId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(typeof state.repositoryTelemetry.revision, "number");
  assert.ok(
    state.repositoryTelemetry.repositories.some(
      (repository) =>
        repository.displayName ===
          "@skillbench-ai/skillmeter-claude-code-marketplace" &&
        repository.effective === "disabled"
    )
  );
  assert.ok(
    state.repositoryTelemetry.repositories.every(
      (repository) => !("repoRoot" in repository)
    )
  );
});

test("FileChanged sign-in success immediately shows every discovered repository", () => {
  const stateDir = makeTempDir("skm-signin-result-");
  const claudeConfigDir = makeTempDir("skm-signin-result-");
  const repo = makeTempDir("skm-signin-result-");
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/SkillBench-AI/visible.git\n'
  );
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "TEST-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: licenseJwt(),
    org_telemetry_migration_version: 1,
  });
  writeJson(path.join(stateDir, "signin-result.json"), {
    status: "success",
    ts: Date.now(),
  });

  const result = runNode(
    path.resolve(__dirname, "../scripts/on_signin_result.js"),
    [],
    {
      cwd: repo,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        SKILLMETER_STATE_DIR: stateDir,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /\[ REPOSITORY REVIEW \]/);
  assert.match(output.systemMessage, /Telemetry ON  0/);
  assert.match(output.systemMessage, /Discovered    1/);
  assert.match(output.systemMessage, /○ OFF  @skillbench-ai\/visible/);
  assert.doesNotMatch(output.systemMessage, new RegExp(repo));
  assert.match(
    output.terminalSequence,
    /Signed in to @skillbench-ai — run \/skillmeter:signin to choose telemetry/
  );
});

test("transmission authorization requires org consent and honors the global kill-switch", () => {
  const stateDir = makeTempDir("skm-org-consent-");
  const credentialPath = path.join(stateDir, "credentials.json");
  writeJson(credentialPath, {
    license_jwt: licenseJwt(),
    org_telemetry_migration_version: 1,
  });

  const probe = [
    "const c=require('./skillmeter/scripts/credstore');",
    "process.stdout.write(String(c.isTelemetryTransmissionAllowed()));",
  ].join("");
  const runProbe = () => runNode("-e", [probe], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, SKILLMETER_STATE_DIR: stateDir },
  });

  assert.equal(runProbe().stdout, "false");

  const consentScript = path.resolve(__dirname, "../scripts/org_telemetry_consent.js");
  const enabled = runNode(consentScript, ["set", "skillbench-ai", "enabled"], {
    env: { ...process.env, SKILLMETER_STATE_DIR: stateDir },
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(runProbe().stdout, "true");

  const repositoryProbe = [
    "const c=require('./skillmeter/scripts/credstore');",
    "process.stdout.write(String(c.isTelemetryTransmissionAllowed(",
    "'github.com/skillbench-ai/example')));",
  ].join("");
  const runRepositoryProbe = () => runNode("-e", [repositoryProbe], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, SKILLMETER_STATE_DIR: stateDir },
  });
  assert.equal(runRepositoryProbe().stdout, "false");
  const enableRepository = [
    "const s=require('./skillmeter/scripts/lib/telemetry-store');",
    "s.setRepositoryOverride('github.com/skillbench-ai/example',true);",
  ].join("");
  assert.equal(
    runNode("-e", [enableRepository], {
      cwd: path.resolve(__dirname, "../.."),
      env: { ...process.env, SKILLMETER_STATE_DIR: stateDir },
    }).status,
    0
  );
  assert.equal(runRepositoryProbe().stdout, "true");

  const telemetryScript = path.resolve(__dirname, "../scripts/telemetry.js");
  const disabled = runNode(telemetryScript, ["disable-global"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, SKILLMETER_STATE_DIR: stateDir },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(runProbe().stdout, "false");
});

test("SessionStart does not silently activate a token-less install", () => {
  const stateDir = makeTempDir("skm-org-consent-");
  const dataDir = makeTempDir("skm-org-consent-");
  const script = path.resolve(__dirname, "../scripts/session_start.js");
  const result = runNode(script, [], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      SKILLMETER_STATE_DIR: stateDir,
      CLAUDE_PLUGIN_DATA: dataDir,
    },
    input: JSON.stringify({
      session_id: "session-start-test",
      cwd: path.resolve(__dirname, "../.."),
      source: "startup",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /gh activation/);
  const stored = readJson(path.join(stateDir, "credentials.json"));
  assert.equal(stored.license_jwt, undefined);
  assert.equal(stored.telemetry_disabled, true);
  const policy = readJson(path.join(stateDir, "telemetry-policy.json"));
  assert.equal(policy.migration.credentials_version, 1);
});

test("hook capture stays off until both org and repository are enabled", () => {
  const stateDir = makeTempDir("skm-org-consent-");
  const dataDir = makeTempDir("skm-org-consent-");
  const repo = makeTempDir("skm-org-consent-");
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/SkillBench-AI/example.git\n'
  );
  const credentialPath = path.join(stateDir, "credentials.json");
  const baseStore = {
    device_id: "TEST-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: licenseJwt(),
    org_telemetry_migration_version: 1,
  };
  writeJson(credentialPath, baseStore);

  const hook = path.resolve(__dirname, "../scripts/hook.js");
  const env = {
    ...process.env,
    SKILLMETER_STATE_DIR: stateDir,
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const input = JSON.stringify({
    session_id: "consent-gate-test",
    cwd: repo,
    prompt: "hello",
  });

  const blocked = runNode(hook, ["UserPromptSubmit"], { cwd: repo, env, input });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(blocked.stderr, /organization telemetry choice required/);
  assert.equal(fs.existsSync(path.join(dataDir, "logs", "events.jsonl")), false);

  const consent = runNode(
    path.resolve(__dirname, "../scripts/org_telemetry_consent.js"),
    ["set", "skillbench-ai", "enabled"],
    { env }
  );
  assert.equal(consent.status, 0, consent.stderr);
  const repositoryBlocked = runNode(
    hook,
    ["UserPromptSubmit"],
    { cwd: repo, env, input }
  );
  assert.equal(repositoryBlocked.status, 0, repositoryBlocked.stderr);
  assert.match(repositoryBlocked.stderr, /repository telemetry choice required/);

  const repositoryConsent = runNode(
    path.resolve(__dirname, "../scripts/telemetry.js"),
    ["enable"],
    { cwd: repo, env }
  );
  assert.equal(repositoryConsent.status, 0, repositoryConsent.stderr);

  const allowed = runNode(hook, ["UserPromptSubmit"], { cwd: repo, env, input });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /logged/);
  const repositoryRoot = path.join(dataDir, "logs", "repositories");
  assert.ok(
    fs.readdirSync(repositoryRoot).some((entry) =>
      fs.existsSync(path.join(repositoryRoot, entry, "events.jsonl"))
    )
  );
});

test("a skipped unselected-repository hook advances the transcript privacy cursor", () => {
  const stateDir = makeTempDir("skm-repo-choice-cursor-");
  const dataDir = makeTempDir("skm-repo-choice-cursor-");
  const repo = makeTempDir("skm-repo-choice-cursor-");
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/SkillBench-AI/cursor.git\n'
  );
  const transcriptPath = path.join(repo, "session.jsonl");
  writeFile(
    transcriptPath,
    [
      JSON.stringify({ type: "user", uuid: "before-choice-1" }),
      JSON.stringify({ type: "assistant", uuid: "before-choice-2" }),
      "",
    ].join("\n")
  );
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "TEST-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: licenseJwt(),
    org_telemetry_migration_version: 1,
    org_telemetry_consents: {
      "skillbench-ai": {
        enabled: true,
        policy_version: 1,
        source: "user",
      },
    },
  });
  const env = {
    ...process.env,
    SKILLMETER_STATE_DIR: stateDir,
    CLAUDE_PLUGIN_DATA: dataDir,
  };

  const result = runNode(
    path.resolve(__dirname, "../scripts/hook.js"),
    ["UserPromptSubmit"],
    {
      cwd: repo,
      env,
      input: JSON.stringify({
        session_id: "repo-choice-cursor",
        cwd: repo,
        transcript_path: transcriptPath,
        prompt: "hello",
      }),
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /repository telemetry choice required/);
  const repositoryQueues = path.join(dataDir, "logs", "repositories");
  const [queueId] = fs.readdirSync(repositoryQueues);
  const cursor = readJson(
    path.join(
      repositoryQueues,
      queueId,
      "transcripts",
      "cursors",
      "session.jsonl.json"
    )
  );
  assert.equal(cursor.lastUuid, "before-choice-2");
  assert.equal(cursor.discarded, true);
});

test("organization OFF deletes its repository queue and skipped hooks do not recreate it", () => {
  const stateDir = makeTempDir("skm-org-consent-");
  const dataDir = makeTempDir("skm-org-consent-");
  const repo = makeTempDir("skm-org-consent-");
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/SkillBench-AI/example.git\n'
  );
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "TEST-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: licenseJwt(),
    org_telemetry_migration_version: 1,
  });
  const env = {
    ...process.env,
    SKILLMETER_STATE_DIR: stateDir,
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const consentScript = path.resolve(__dirname, "../scripts/org_telemetry_consent.js");
  assert.equal(
    runNode(consentScript, ["set", "skillbench-ai", "enabled"], { env }).status,
    0
  );
  assert.equal(
    runNode(
      path.resolve(__dirname, "../scripts/telemetry.js"),
      ["enable"],
      { cwd: repo, env }
    ).status,
    0
  );
  const hook = path.resolve(__dirname, "../scripts/hook.js");
  const input = JSON.stringify({
    session_id: "consent-gate-stop-test",
    cwd: repo,
    prompt: "hello",
  });
  assert.match(
    runNode(hook, ["UserPromptSubmit"], { cwd: repo, env, input }).stderr,
    /logged/
  );
  const repositoriesDir = path.join(dataDir, "logs", "repositories");
  assert.ok(fs.existsSync(repositoriesDir));

  const disabled = runNode(
    consentScript,
    ["set", "skillbench-ai", "disabled"],
    { env }
  );
  assert.equal(disabled.status, 0, disabled.stderr);
  const queueRoot = path.join(
    repositoriesDir,
    fs.readdirSync(repositoriesDir)[0]
  );
  assert.equal(fs.existsSync(path.join(queueRoot, "events.jsonl")), false);
  assert.equal(
    fs.existsSync(path.join(queueRoot, "transcripts", "chunks")),
    false
  );

  const result = runNode(path.resolve(__dirname, "../scripts/stop.js"), [], {
    cwd: repo,
    env,
    input: JSON.stringify({
      session_id: "consent-gate-stop-test",
      cwd: repo,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /telemetry disabled for this organization/);
  assert.equal(fs.existsSync(path.join(queueRoot, "events.jsonl")), false);
  assert.equal(
    fs.existsSync(path.join(queueRoot, "transcripts", "chunks")),
    false
  );
});

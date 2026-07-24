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
    enableLabel: "Label: `Enable for @ORG`",
    deferLabel: "Label: `Keep off for now`",
  },
  {
    state: "enabled",
    sectionStart: 'For an org whose `consent` is `true`',
    sectionEnd: 'For an org whose `consent` is `false`',
    enableLabel: "Label: `Keep enabled`",
    deferLabel: "Label: `Turn telemetry off`",
  },
  {
    state: "disabled",
    sectionStart: 'For an org whose `consent` is `false`',
    sectionEnd: "If `orgs` is empty",
    enableLabel: "Label: `Enable for @ORG`",
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

test("legacy license migration preserves the former auto-org enabled state", () => {
  const store = { license_jwt: licenseJwt() };
  assert.equal(credstore._migrateOrgTelemetryConsentStore(store), true);
  assert.equal(store.org_telemetry_migration_version, 1);
  assert.equal(store.org_telemetry_consents["skillbench-ai"].enabled, true);
  assert.equal(store.org_telemetry_consents["skillbench-ai"].source, "legacy");
  assert.equal(credstore._getOrgTelemetryConsentFromStore(store, "SKILLBENCH-AI"), true);
});

test("token-less migration prevents a later new sign-in from being auto-enabled", () => {
  const store = {};
  assert.equal(credstore._migrateOrgTelemetryConsentStore(store), true);
  store.license_jwt = licenseJwt();
  assert.equal(credstore._migrateOrgTelemetryConsentStore(store), false);
  assert.equal(credstore._getOrgTelemetryConsentFromStore(store, "skillbench-ai"), null);
});

test("signed-out legacy state is not migrated to enabled", () => {
  const store = { license_jwt: licenseJwt(), signed_out: true };
  credstore._migrateOrgTelemetryConsentStore(store);
  assert.equal(credstore._getOrgTelemetryConsentFromStore(store, "skillbench-ai"), null);
});

test("a stale policy version requires a fresh choice", () => {
  const store = {
    org_telemetry_consents: {
      "skillbench-ai": { enabled: true, policy_version: 0 },
    },
  };
  assert.equal(credstore._getOrgTelemetryConsentFromStore(store, "skillbench-ai"), null);
});

const ENABLED_POLICY = {
  globalDisabled: false,
  hasValidLicense: true,
  repoOrgOwned: true,
  orgConsent: true,
  projectOptIn: null,
};

const POLICY_CASES = [
  ["org default enables capture", {}, { capture: true, mode: "org_enabled" }],
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
  const stored = readJson(credentialPath);
  assert.equal(stored.org_telemetry_consents["skillbench-ai"].enabled, true);
  assert.equal(stored.org_telemetry_consents["skillbench-ai"].source, "user");

  const rejected = runNode(script, ["set", "other-org", "enabled"], { env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /not present in the current valid license/);
});

test("signin expansion emits an explicit pending-consent state for a new sign-in", () => {
  const stateDir = makeTempDir("skm-org-consent-");
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
    env: { ...process.env, SKILLMETER_STATE_DIR: stateDir },
    input: JSON.stringify({
      command_name: "skillmeter:signin",
      command_source: "plugin",
      cwd: path.resolve(__dirname, "../.."),
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /SkillMeter sign-in state JSON:/);
  const state = JSON.parse(context.split("SkillMeter sign-in state JSON:\n")[1]);
  assert.deepEqual(state.orgs, [{ org: "skillbench-ai", consent: null }]);
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

  const store = readJson(credentialPath);
  store.org_telemetry_consents = {
    "skillbench-ai": {
      enabled: true,
      policy_version: 1,
      decided_at: Date.now(),
      source: "user",
    },
  };
  writeJson(credentialPath, store);
  assert.equal(runProbe().stdout, "true");

  store.telemetry_disabled = true;
  writeJson(credentialPath, store);
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
  assert.equal(stored.org_telemetry_migration_version, 1);
});

test("hook capture stays off until org consent is enabled", () => {
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

  writeJson(credentialPath, {
    ...baseStore,
    org_telemetry_consents: {
      "skillbench-ai": {
        enabled: true,
        policy_version: 1,
        decided_at: Date.now(),
        source: "user",
      },
    },
  });
  const allowed = runNode(hook, ["UserPromptSubmit"], { cwd: repo, env, input });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /logged/);
  assert.equal(fs.existsSync(path.join(dataDir, "logs", "events.jsonl")), true);
});

test("a skipped final hook still seals previously captured events without uploading", () => {
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

  const logsDir = path.join(dataDir, "logs");
  const activeLog = path.join(logsDir, "events.jsonl");
  writeFile(activeLog, '{"hook_event_name":"UserPromptSubmit"}\n');

  const result = runNode(path.resolve(__dirname, "../scripts/stop.js"), [], {
    cwd: repo,
    env: {
      ...process.env,
      SKILLMETER_STATE_DIR: stateDir,
      CLAUDE_PLUGIN_DATA: dataDir,
    },
    input: JSON.stringify({
      session_id: "consent-gate-stop-test",
      cwd: repo,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /organization telemetry choice required/);
  assert.equal(fs.existsSync(activeLog), false);
  assert.ok(
    fs.readdirSync(logsDir).some((name) => /^events\.jsonl\.\d+$/.test(name)),
    "the active log should be moved into the durable retry queue"
  );
});

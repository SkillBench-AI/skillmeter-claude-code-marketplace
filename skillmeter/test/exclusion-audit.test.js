"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  readJson,
  runNode,
  writeFile,
  writeJson,
} = require("../testing/helpers");

const HOOK = path.resolve(__dirname, "../scripts/hook.js");
const ORG_CONSENT = path.resolve(
  __dirname,
  "../scripts/org_telemetry_consent.js"
);
const SALT = "0123456789abcdef0123456789abcdef";

function licenseJwt(org = "skillbench-ai", audience = "https://tenant.example") {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: audience,
    org: { login: org },
  });
}

function makeRepo(owner, name) {
  const repo = makeTempDir(`skm-exclusion-${name}-`);
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    `[remote "origin"]\n\turl = https://github.com/${owner}/${name}.git\n`
  );
  return repo;
}

function makeEnvironment({
  orgConsent = true,
  globalEnabled = true,
  repositories = {},
  token = licenseJwt(),
} = {}) {
  const stateDir = makeTempDir("skm-exclusion-state-");
  const dataDir = makeTempDir("skm-exclusion-data-");
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "EXCLUSION-TEST-DEVICE",
    hash_salt: SALT,
    license_jwt: token,
    telemetry_disabled: true,
  });
  writeJson(path.join(stateDir, "telemetry-policy.json"), {
    schema_version: 1,
    revision: 1,
    global: { enabled: globalEnabled },
    organizations: orgConsent === null
      ? {}
      : {
          "skillbench-ai": {
            enabled: orgConsent,
            consent_version: 1,
            source: "user",
          },
        },
    repositories: Object.fromEntries(
      Object.entries(repositories).map(([repoKey, enabled]) => [
        repoKey,
        { enabled, source: "user" },
      ])
    ),
  });
  return {
    stateDir,
    dataDir,
    env: {
      ...process.env,
      SKILLMETER_STATE_DIR: stateDir,
      CLAUDE_PLUGIN_DATA: dataDir,
    },
  };
}

function runPrompt(env, cwd, overrides = {}) {
  return runNode(HOOK, ["UserPromptSubmit"], {
    cwd: cwd || path.resolve(__dirname, "../.."),
    env,
    input: JSON.stringify({
      session_id: "exclusion-session",
      ...(cwd === undefined ? {} : { cwd }),
      prompt: "private prompt user@example.com ghp_1234567890abcdefghijklmnop",
      ...overrides,
    }),
  });
}

function organizationAuditFiles(dataDir, pattern = /^events\.jsonl(?:\.\d+)?$/) {
  const root = path.join(dataDir, "logs", "organization-audit");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(root, entry.name);
      return fs.readdirSync(dir)
        .filter((name) => pattern.test(name))
        .map((name) => path.join(dir, name));
    });
}

function repositoryEventFiles(dataDir) {
  const root = path.join(dataDir, "logs", "repositories");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "events.jsonl"))
    .filter((file) => fs.existsSync(file));
}

test("enabled repository records only the normal repository event", () => {
  const repo = makeRepo("skillbench-ai", "enabled");
  const fixture = makeEnvironment({
    repositories: {
      "github.com/skillbench-ai/enabled": true,
    },
  });

  const result = runPrompt(fixture.env, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /logged/);
  assert.equal(repositoryEventFiles(fixture.dataDir).length, 1);
  assert.equal(organizationAuditFiles(fixture.dataDir).length, 0);
});

test("external repository emits only the allow-listed exclusion audit", () => {
  const repo = makeRepo("outside-org", "private");
  const fixture = makeEnvironment();

  const result = runPrompt(fixture.env, repo, {
    transcript_path: "/Users/private/raw-transcript.jsonl",
    tool_input: { password: "do-not-copy" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /outside the licensed org/);
  assert.equal(repositoryEventFiles(fixture.dataDir).length, 0);

  const [auditFile] = organizationAuditFiles(fixture.dataDir);
  assert.ok(auditFile);
  const raw = fs.readFileSync(auditFile, "utf8");
  const audit = JSON.parse(raw.trim());
  assert.deepEqual(Object.keys(audit.data).sort(), [
    "cwd",
    "gate_mode",
    "source_hook_event_name",
  ]);
  assert.equal(audit.hook_event_name, "TelemetryCaptureExcluded");
  assert.equal(audit.telemetry_scope, "organization");
  assert.equal(audit.data.source_hook_event_name, "UserPromptSubmit");
  assert.equal(audit.data.gate_mode, "out_of_scope");
  assert.match(audit.data.cwd, /^[0-9a-f]{12}$/);
  for (const forbidden of [
    repo,
    "outside-org",
    "private prompt",
    "user@example.com",
    "ghp_",
    "raw-transcript",
    "do-not-copy",
  ]) {
    const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(raw, new RegExp(escaped));
  }
});

test("disabled, unselected, non-git, and missing cwd fail closed before mapping", () => {
  const disabled = makeRepo("skillbench-ai", "disabled");
  const unselected = makeRepo("skillbench-ai", "unselected");
  const nonGit = makeTempDir("skm-exclusion-non-git-");
  const fixture = makeEnvironment({
    repositories: {
      "github.com/skillbench-ai/disabled": false,
    },
  });

  const cases = [
    [disabled, "project_disabled"],
    [unselected, "repository_consent_required"],
    [nonGit, "out_of_scope"],
  ];
  for (const [cwd, mode] of cases) {
    const result = runPrompt(fixture.env, cwd);
    assert.equal(result.status, 0, result.stderr);
    const [file] = organizationAuditFiles(fixture.dataDir);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(JSON.parse(lines.at(-1)).data.gate_mode, mode);
  }

  const missing = runPrompt(fixture.env, undefined);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /cwd missing or invalid/);
  const [auditFile] = organizationAuditFiles(fixture.dataDir);
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.data.gate_mode, "cwd_unavailable");
  assert.equal(last.data.cwd, "");
  assert.equal(repositoryEventFiles(fixture.dataDir).length, 0);
});

test("org consent and global switch bound exclusion-audit capture", () => {
  const external = makeRepo("outside-org", "policy");
  for (const policy of [
    { orgConsent: null, globalEnabled: true },
    { orgConsent: false, globalEnabled: true },
    { orgConsent: true, globalEnabled: false },
  ]) {
    const fixture = makeEnvironment(policy);
    const result = runPrompt(fixture.env, external);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(organizationAuditFiles(fixture.dataDir).length, 0);
  }
});

test("organization OFF and sign-out delete exclusion audit payloads", () => {
  const external = makeRepo("outside-org", "delete");

  const orgOff = makeEnvironment();
  runPrompt(orgOff.env, external);
  assert.equal(organizationAuditFiles(orgOff.dataDir).length, 1);
  const disabled = runNode(
    ORG_CONSENT,
    ["set", "skillbench-ai", "disabled"],
    { env: orgOff.env }
  );
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(organizationAuditFiles(orgOff.dataDir).length, 0);

  const signout = makeEnvironment();
  runPrompt(signout.env, external);
  assert.equal(organizationAuditFiles(signout.dataDir).length, 1);
  const result = runNode(
    path.resolve(__dirname, "../scripts/signout.js"),
    [],
    { env: signout.env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(organizationAuditFiles(signout.dataDir).length, 0);
});

test("global OFF pauses an existing audit queue and tenant mismatch deletes it", () => {
  const external = makeRepo("outside-org", "tenant");

  const paused = makeEnvironment();
  runPrompt(paused.env, external);
  const pausedFile = organizationAuditFiles(paused.dataDir)[0];
  const pausedPolicy = readJson(
    path.join(paused.stateDir, "telemetry-policy.json")
  );
  pausedPolicy.global.enabled = false;
  writeJson(path.join(paused.stateDir, "telemetry-policy.json"), pausedPolicy);
  const purgeProbe = [
    "require('./skillmeter/scripts/lib/organization-audit-queue')",
    ".purgeDisallowedOrganizationAuditQueues();",
  ].join("");
  const cwd = path.resolve(__dirname, "../..");
  assert.equal(
    runNode("-e", [purgeProbe], { cwd, env: paused.env }).status,
    0
  );
  assert.equal(fs.existsSync(pausedFile), true);

  const mismatch = makeEnvironment();
  runPrompt(mismatch.env, external);
  const mismatchFile = organizationAuditFiles(mismatch.dataDir)[0];
  const credentials = readJson(
    path.join(mismatch.stateDir, "credentials.json")
  );
  credentials.license_jwt = licenseJwt(
    "skillbench-ai",
    "https://different-tenant.example"
  );
  writeJson(path.join(mismatch.stateDir, "credentials.json"), credentials);
  assert.equal(
    runNode("-e", [purgeProbe], { cwd, env: mismatch.env }).status,
    0
  );
  assert.equal(fs.existsSync(mismatchFile), false);
});

test("organization audit transfer uses the existing endpoint with tenant idempotency", () => {
  const external = makeRepo("outside-org", "upload");
  const fixture = makeEnvironment();
  runPrompt(fixture.env, external);
  const cwd = path.resolve(__dirname, "../..");
  const sealProbe = [
    "const t=require('./skillmeter/scripts/lib/transfer');",
    "t.sealOrganizationAuditEventLog();",
  ].join("");
  assert.equal(
    runNode("-e", [sealProbe], { cwd, env: fixture.env }).status,
    0
  );

  const drainProbe = [
    "const z=require('node:zlib');",
    "const t=require('./skillmeter/scripts/lib/transfer');",
    "let sent=null;",
    "global.fetch=async (url,options)=>{",
    "sent={url,headers:options.headers,body:z.gunzipSync(options.body).toString('utf8')};",
    "return {ok:true,status:200};",
    "};",
    "t.drainFailedLogs(1000).then((result)=>{",
    "process.stdout.write(JSON.stringify({result,sent}));",
    "});",
  ].join("");
  const drained = runNode("-e", [drainProbe], {
    cwd,
    env: fixture.env,
  });
  assert.equal(drained.status, 0, drained.stderr);
  const output = JSON.parse(drained.stdout);
  assert.equal(output.result.ok, 1);
  assert.equal(output.sent.url, "https://tenant.example/logs/claude");
  assert.equal(output.sent.headers["X-Telemetry-Scope"], "organization");
  assert.match(
    output.sent.headers["X-Idempotency-Key"],
    /^[0-9a-f]{64}$/
  );
  assert.match(output.sent.body, /"TelemetryCaptureExcluded"/);
});

test("organization audit retries preserve the idempotency key", () => {
  const external = makeRepo("outside-org", "retry");
  const fixture = makeEnvironment();
  runPrompt(fixture.env, external);
  const cwd = path.resolve(__dirname, "../..");
  const sealProbe = [
    "const t=require('./skillmeter/scripts/lib/transfer');",
    "t.sealOrganizationAuditEventLog();",
  ].join("");
  runNode("-e", [sealProbe], { cwd, env: fixture.env });

  const retryProbe = [
    "const t=require('./skillmeter/scripts/lib/transfer');",
    "const keys=[];",
    "let calls=0;",
    "global.fetch=async (url,options)=>{",
    "keys.push(options.headers['X-Idempotency-Key']);",
    "calls++;",
    "return calls===1?{ok:false,status:503}:{ok:true,status:200};",
    "};",
    "(async()=>{",
    "const first=await t.drainFailedLogs(1000);",
    "const second=await t.drainFailedLogs(1000);",
    "process.stdout.write(JSON.stringify({first,second,keys}));",
    "})();",
  ].join("");
  const result = runNode("-e", [retryProbe], {
    cwd,
    env: fixture.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.first.ok, 0);
  assert.equal(output.second.ok, 1);
  assert.equal(output.keys.length, 2);
  assert.equal(output.keys[0], output.keys[1]);
});

test("concurrent blocked hooks append complete audit records", async () => {
  const external = makeRepo("outside-org", "concurrent");
  const fixture = makeEnvironment();
  const count = 12;
  const children = Array.from({ length: count }, (_, index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK, "UserPromptSubmit"], {
        cwd: external,
        env: fixture.env,
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code));
      child.stdin.end(JSON.stringify({
        session_id: `concurrent-${index}`,
        cwd: external,
        prompt: `private-${index}`,
      }));
    })
  );
  assert.deepEqual(await Promise.all(children), Array(count).fill(0));

  const [auditFile] = organizationAuditFiles(fixture.dataDir);
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  assert.equal(lines.length, count);
  for (const line of lines) {
    const event = JSON.parse(line);
    assert.equal(event.hook_event_name, "TelemetryCaptureExcluded");
    assert.deepEqual(Object.keys(event.data).sort(), [
      "cwd",
      "gate_mode",
      "source_hook_event_name",
    ]);
  }
});

test("session cwd context detects cwd and repository transitions without raw paths", () => {
  const root = makeTempDir("skm-cwd-context-");
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  const dataDir = makeTempDir("skm-cwd-context-data-");
  const probe = [
    "const c=require('./skillmeter/scripts/lib/cwd-context');",
    "const salt=process.env.TEST_SALT;",
    "const a=c.observeSessionCwd({sessionId:'s',cwd:process.env.CWD_A,repoKey:'github.com/o/a',classification:'github_org_match',hashSalt:salt});",
    "const b=c.observeSessionCwd({sessionId:'s',cwd:process.env.CWD_B,repoKey:'github.com/o/a',classification:'github_org_match',hashSalt:salt});",
    "const d=c.observeSessionCwd({sessionId:'s',cwd:process.env.CWD_B,repoKey:'github.com/o/b',classification:'github_org_match',hashSalt:salt});",
    "process.stdout.write(JSON.stringify({a,b,d,file:c.contextPath('s',salt)}));",
  ].join("");
  const result = runNode("-e", [probe], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      TEST_SALT: SALT,
      CWD_A: root,
      CWD_B: nested,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.a.cwdChanged, false);
  assert.equal(output.b.cwdChanged, true);
  assert.equal(output.b.repositoryChanged, false);
  assert.equal(output.d.cwdChanged, false);
  assert.equal(output.d.repositoryChanged, true);
  const raw = fs.readFileSync(output.file, "utf8");
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.doesNotMatch(raw, new RegExp(escaped));
  assert.doesNotMatch(raw, /github\.com/);
});

test("SessionEnd removes cwd context and stale cleanup removes old state", () => {
  const external = makeRepo("outside-org", "session-end");
  const fixture = makeEnvironment();
  runPrompt(fixture.env, external);

  const sessions = path.join(fixture.dataDir, "sessions");
  assert.equal(fs.readdirSync(sessions).length, 1);
  const pluginRoot = makeTempDir("skm-session-end-plugin-root-");
  const ended = runNode(
    path.resolve(__dirname, "../scripts/session_end.js"),
    [],
    {
      cwd: external,
      env: {
        ...fixture.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        SKILLMETER_BACKEND_URL: "http://127.0.0.1:9",
      },
      input: JSON.stringify({
        session_id: "exclusion-session",
        cwd: external,
        reason: "other",
      }),
    }
  );
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(fs.existsSync(sessions), true);
  assert.equal(fs.readdirSync(sessions).length, 0);

  const staleProbe = [
    "const fs=require('node:fs');",
    "const c=require('./skillmeter/scripts/lib/cwd-context');",
    `const salt='${SALT}';`,
    "const state=c.observeSessionCwd({sessionId:'stale',cwd:'/tmp',classification:'no_repository',hashSalt:salt});",
    "const file=c.contextPath('stale',salt);",
    "const old=new Date(Date.now()-31*24*60*60*1000);",
    "fs.utimesSync(file,old,old);",
    "const deleted=c.cleanupStaleSessionContexts(30*24*60*60*1000);",
    "process.stdout.write(JSON.stringify({deleted,exists:fs.existsSync(file),state:!!state}));",
  ].join("");
  const stale = runNode("-e", [staleProbe], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: fixture.dataDir,
    },
  });
  assert.equal(stale.status, 0, stale.stderr);
  assert.deepEqual(JSON.parse(stale.stdout), {
    deleted: 1,
    exists: false,
    state: true,
  });
});

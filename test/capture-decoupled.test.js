"use strict";

// ADR 001 decision 3: recording does not depend on token freshness. A hook
// records while the user is signed in even when the license has expired or
// cannot be refreshed; freshness is enforced when data is sent. What is
// recorded but unsent is bounded: sign-out and a 402 revocation remove it,
// and anything older than the 7-day refresh window ages out.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const {
  isolatedEnv,
  makeJwt,
  makeTempDir,
  runNode,
  writeFile,
  writeJson,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const ORG = "skillbench-ai";
const REPO_KEY = `github.com/${ORG}/decoupled`;

function license(expiresInSec) {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    org: { login: ORG },
    // Reserved domain: a test must never reach a real tenant.
    aud: "https://acme.meter.skillbench.example",
  });
}

// A signed-in device whose license expired an hour ago, with the organization
// and repository enabled, and a checkout of that repository.
function fixture({ credentials = {} } = {}) {
  const stateDir = makeTempDir("skm-decoupled-state-");
  const dataDir = makeTempDir("skm-decoupled-data-");
  const repo = makeTempDir("skm-decoupled-repo-");
  fs.mkdirSync(path.join(repo, ".git"));
  writeFile(
    path.join(repo, ".git", "config"),
    `[remote "origin"]\n\turl = https://github.com/${ORG}/decoupled.git\n`
  );
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "DECOUPLED-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: license(-3600),
    ...credentials,
  });
  writeTelemetryPolicy(stateDir, { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
  const env = isolatedEnv({
    SKILLMETER_STATE_DIR: stateDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    // Nothing may reach a real endpoint.
    SKILLMETER_ACTIVATE_URL: "http://127.0.0.1:9/activate",
    SKILLMETER_BACKEND_URL: "http://127.0.0.1:9",
  });
  const prompt = (text = "hello") =>
    runNode(path.join(SCRIPTS, "hook.js"), ["UserPromptSubmit"], {
      cwd: repo,
      env,
      input: JSON.stringify({ session_id: "decoupled", cwd: repo, prompt: text }),
    });
  const queuedEventLogs = () => {
    const root = path.join(dataDir, "logs", "repositories");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).flatMap((id) =>
      fs.readdirSync(path.join(root, id))
        .filter((name) => /^events\.jsonl/.test(name))
        .map((name) => path.join(root, id, name))
    );
  };
  return { stateDir, dataDir, repo, env, prompt, queuedEventLogs };
}

test("an expired license still records while signed in", () => {
  const f = fixture();
  const result = f.prompt();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /logged/);
  assert.equal(f.queuedEventLogs().length, 1, "the event is queued for a later, fresh upload");
});

test("a signed-out device records nothing, even with a token on disk", () => {
  const f = fixture({ credentials: { signed_out: true } });
  const result = f.prompt();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /logged/);
  assert.equal(f.queuedEventLogs().length, 0);
});

test("sign-out removes what was recorded but not yet sent", () => {
  const f = fixture();
  assert.match(f.prompt().stderr, /logged/);
  assert.equal(f.queuedEventLogs().length, 1);

  const out = runNode(path.join(SCRIPTS, "signout.js"), [], { env: f.env });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(f.queuedEventLogs().length, 0);
});

test("unsent data older than seven days ages out; newer data stays", () => {
  const f = fixture();
  assert.match(f.prompt().stderr, /logged/);
  const [log] = f.queuedEventLogs();
  const sealedOld = `${log}.${Date.now() - 1}`;
  fs.copyFileSync(log, sealedOld);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(sealedOld, eightDaysAgo, eightDaysAgo);

  const cleanup = runNode("-e", [
    `require(${JSON.stringify(path.join(SCRIPTS, "lib/transfer.js"))}).cleanupStaleFiles();`,
  ], { env: f.env });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(fs.existsSync(sealedOld), false, "the 8-day-old unsent log is deleted");
  assert.equal(fs.existsSync(log), true, "today's log is kept");
});

// Loopback /refresh answering with a fixed status.
async function refreshServer(status) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/activate` };
}

function runAsync(script, args, { env, cwd, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input || "");
  });
}

test("a revoked license (402) removes its organization's unsent data", async () => {
  const f = fixture();
  assert.match(f.prompt().stderr, /logged/);
  assert.equal(f.queuedEventLogs().length, 1);

  const { server, url } = await refreshServer(402);
  try {
    const refresh = await runAsync("-e", [
      `require(${JSON.stringify(path.join(SCRIPTS, "lib/license-activation.js"))})` +
        `.refreshLicense(require(${JSON.stringify(path.join(SCRIPTS, "credstore.js"))}).getDeviceId(), { source: "test" })`,
    ], { env: { ...f.env, SKILLMETER_ACTIVATE_URL: url }, cwd: f.repo });
    assert.equal(refresh.status, 0, refresh.stderr);
  } finally {
    server.close();
  }
  assert.equal(f.queuedEventLogs().length, 0);
});

for (const [status, expectBanner] of [[503, false], [410, true]]) {
  test(`SessionStart asks to sign in only when that is what fixes it (refresh ${status})`, async () => {
    const f = fixture();
    const { server, url } = await refreshServer(status);
    let result;
    try {
      result = await runAsync(path.join(SCRIPTS, "session_start.js"), [], {
        env: { ...f.env, SKILLMETER_ACTIVATE_URL: url },
        cwd: f.repo,
        input: JSON.stringify({ session_id: "decoupled-ss", cwd: f.repo, source: "startup" }),
      });
    } finally {
      server.close();
    }
    assert.equal(result.status, 0, result.stderr);
    const message = JSON.parse(result.stdout).systemMessage || "";
    if (expectBanner) assert.match(message, /ACTION REQUIRED/);
    else assert.doesNotMatch(message, /ACTION REQUIRED/);
  });
}

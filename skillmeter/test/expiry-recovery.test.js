"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTempDir, writeJson, writeFile, writeTelemetryPolicy, makeJwt, runNode } = require("../testing/helpers");

const scripts = path.resolve(__dirname, "../scripts");

// Exercise real hook/refresh/queue code in separate processes. Only the clock,
// process launch and network are substituted; no monitor or real token is used.
function fixture() {
  const root = makeTempDir("skm-expiry-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const repo = path.join(root, "repo");
  const calls = path.join(root, "calls.jsonl");
  const start = Date.now();
  const claims = { sub: "test-tenant", broker_sub: "test-user", org: { login: "acme" }, aud: "https://acme.meter.skillbench.ai" };
  const token = makeJwt({ ...claims, exp: Math.floor(start / 1000) + 900 });
  const credentials = { device_id: "11111111-2222-4333-8444-555555555555", hash_salt: "0123456789abcdef0123456789abcdef", license_jwt: token };
  writeJson(path.join(state, "credentials.json"), credentials);
  writeTelemetryPolicy(state, { orgs: { acme: true }, repositories: { "github.com/acme/widgets": true } });
  writeFile(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
  const preload = path.join(root, "preload.cjs");
  writeFile(preload, `
const fs = require("fs");
const cp = require("child_process");
Date.now = () => Number(process.env.TEST_NOW);
function record(value) { fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(value) + "\\n"); }
cp.spawn = (file, args) => { record({ spawn: args }); return { pid: 999999, unref() {} }; };
cp.execSync = () => { throw new Error("Unexpected shell command"); };
global.fetch = async (url, options) => {
  record({ url: String(url) });
  if (String(url).endsWith("/refresh")) {
    const status = Number(process.env.TEST_REFRESH_STATUS || 200);
    return { ok: status === 200, status, json: async () => ({ token: process.env.TEST_FRESH }), text: async () => "synthetic failure" };
  }
  if (!String(url).startsWith("https://acme.meter.skillbench.ai/")) throw new Error("Unexpected URL");
  const jwt = options.headers.Authorization.replace(/^Bearer /, "");
  const exp = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).exp;
  if (exp * 1000 <= Date.now()) throw new Error("Expired upload attempted");
  const events = require("zlib").gunzipSync(options.body).toString().trim().split("\\n").map(JSON.parse);
  record({ uploaded: events.map(event => event.hook_event_name), messages: events.map(event => event.data.last_assistant_message) });
  return { ok: true, status: 200, text: async () => "ok", json: async () => ({}) };
};
`);
  function run(script, minute = 0, extra = {}) {
    const now = start + minute * 60_000;
    const result = runNode(script, [], {
      cwd: repo,
      timeout: 5000,
      input: JSON.stringify({ session_id: "synthetic-session", cwd: repo, last_assistant_message: `synthetic turn ${minute}` }),
      env: {
        HOME: root, USERPROFILE: root, SKILLMETER_STATE_DIR: state,
        CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: path.resolve(scripts, ".."),
        NODE_OPTIONS: `--require=${preload}`, TEST_NOW: String(now), TEST_CALLS: calls,
        TEST_FRESH: makeJwt({ ...claims, exp: Math.floor(now / 1000) + 900 }),
        SKILLMETER_ACTIVATE_URL: "https://activation.test/activate",
        SKILLMETER_BACKEND_URL: "", SKILLMETER_ENV: "", ...extra,
      },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result;
  }
  function records() {
    return fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  }
  return { state, data, credentials, token, start, records, run,
    hook: (minute, extra) => run(path.join(scripts, "stop.js"), minute, extra),
    drain: (minute, extra) => run(path.join(scripts, "drain_once.js"), minute, extra),
  };
}

test("an expired empty session requests recovery without a monitor, then records on the next hook", () => {
  const f = fixture();
  f.hook(16);
  assert.equal(f.records().filter(r => r.spawn).length, 1, "expired capture must not strand an empty queue");
  assert.equal(f.records().filter(r => r.url).length, 0, "hooks must not perform network I/O");
  f.drain(16);
  assert.deepEqual(f.records().filter(r => r.url).map(r => r.url), ["https://activation.test/refresh"]);
  assert.match(f.hook(17).stderr, /logged/);
});

test("detached recovery refreshes even with no queued files", () => {
  const f = fixture();
  f.drain(16);
  assert.equal(f.records().filter(r => r.url?.endsWith("/refresh")).length, 1);
});

test("proactive Stop recovery keeps an active session capturing across two token lifetimes", () => {
  const f = fixture();
  for (let minute = 0; minute <= 34; minute += 2) {
    assert.match(f.hook(minute).stderr, /logged/, `capture at minute ${minute}`);
    f.drain(minute);
  }
  assert.ok(f.records().filter(r => r.url?.endsWith("/refresh")).length >= 3);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), Array(18).fill("Stop"));
  assert.deepEqual(f.records().flatMap(r => r.messages || []), Array.from({ length: 18 }, (_, i) => `synthetic turn ${i * 2}`));
});

test("refresh failure backs off and later recovers without SessionStart", () => {
  const f = fixture();
  f.hook(16);
  f.drain(16, { TEST_REFRESH_STATUS: "503" });
  const status = JSON.parse(fs.readFileSync(path.join(f.state, "license-status.json")));
  assert.equal(status.last_outcome, "transient_failure");
  f.hook(17);
  f.drain(17);
  assert.equal(f.records().filter(r => r.url).length, 1, "backoff blocks another request");
  f.hook(19);
  f.drain(19);
  assert.match(f.hook(20).stderr, /logged/);
});

for (const denied of ["signed_out", "global_off", "org_off", "repo_off", "missing_token"]) {
  test(`empty-queue recovery respects ${denied}`, () => {
    const f = fixture();
    if (denied === "signed_out") {
      writeJson(path.join(f.state, "credentials.json"), { ...f.credentials, signed_out: true });
    } else if (denied === "missing_token") {
      const { license_jwt, ...rest } = f.credentials;
      writeJson(path.join(f.state, "credentials.json"), rest);
    } else {
      writeTelemetryPolicy(f.state, { enabled: denied !== "global_off", orgs: { acme: denied !== "org_off" }, repositories: { "github.com/acme/widgets": denied !== "repo_off" } });
    }
    f.hook(16);
    f.drain(16);
    assert.deepEqual(f.records(), []);
  });
}

for (const status of [401, 402, 410]) {
  test(`terminal refresh ${status} is not rearmed by later hooks`, () => {
    const f = fixture();
    f.drain(16, { TEST_REFRESH_STATUS: String(status) });
    f.hook(20);
    f.drain(20);
    assert.equal(f.records().filter(r => r.url).length, 1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(f.state, "license-status.json"))).terminal);
  });
}

for (const change of ["signout", "revoke_consent"]) {
  test(`queued recovery rechecks ${change} before starting`, () => {
    const f = fixture();
    f.hook(16);
    assert.equal(f.records().filter(r => r.spawn).length, 1);
    if (change === "signout") {
      const { license_jwt, ...rest } = f.credentials;
      writeJson(path.join(f.state, "credentials.json"), { ...rest, signed_out: true });
    } else {
      writeTelemetryPolicy(f.state, { orgs: { acme: false }, repositories: { "github.com/acme/widgets": true } });
    }
    f.drain(16);
    assert.equal(f.records().filter(r => r.url).length, 0);
  });
}

test("healthy empty queues make no refresh request", () => {
  const f = fixture();
  f.drain(0);
  assert.deepEqual(f.records(), []);
});

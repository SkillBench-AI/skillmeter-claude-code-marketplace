"use strict";
// Token-expiry recovery through the real Stop hook and drain worker with a
// frozen clock. The fetch stub plays the broker's refresh token grant and
// /activate, and refuses any upload carrying an expired token.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sandbox, makeJwt, sessionFileIn } = require("../../test-support/plugin.cjs");

function expiry(t) {
  const start = Date.now();
  const claims = { sub: "tenant-test", broker_sub: "person-test", org: { login: "acme" }, orgs: ["acme"], aud: "https://acme.meter.skillbench.ai" };
  const jwt = extra => makeJwt({ ...claims, ...extra });
  const token = jwt({ exp: Math.floor(start / 1000) + 900 });
  const credentials = { device_id: "TEST-DEVICE", hash_salt: "synthetic-salt", license_jwt: token, refresh_token: "synthetic-refresh" };
  const box = sandbox(t, { prefix: "codex-expiry", telemetry: true, credentials, preload: `
const fs = require("fs"), cp = require("child_process");
Date.now = () => Number(process.env.TEST_NOW);
const record = value => fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(value) + "\\n");
cp.spawn = (file, args) => { record({ spawn: args }); return { pid: 999999, unref() {} }; };
cp.execSync = () => { throw new Error("No shell in this fixture"); };
global.fetch = async (url, options) => {
  record({ url: String(url) });
  if (String(url) === "https://id.skillbench.ai/oauth2/token") {
    const status = Number(process.env.TEST_REFRESH_STATUS || 200);
    const body = JSON.stringify(status === 200 ? { id_token: "synthetic-id", refresh_token: "synthetic-refresh" } : { error: "temporarily_unavailable" });
    return { ok: status === 200, status, text: async () => body };
  }
  if (String(url) === "https://api.skillbench.ai/activate") {
    return { ok: true, status: 200, json: async () => ({ token: process.env.TEST_FRESH }), text: async () => "" };
  }
  if (!String(url).startsWith("https://acme.meter.skillbench.ai/")) throw new Error("Unexpected URL");
  const token = options.headers.Authorization.replace(/^Bearer /, "");
  const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url")).exp;
  if (exp * 1000 <= Date.now()) throw new Error("Expired upload attempted");
  const events = require("zlib").gunzipSync(options.body).toString().trim().split("\\n").map(JSON.parse);
  record({ uploaded: events.map(event => event.hook_event_name), messages: events.map(event => event.data.last_assistant_message) });
  return { ok: true, status: 200, text: async () => "ok" };
};
` });
  const calls = path.join(box.root, "calls.jsonl");
  function run(script, minute, extra = {}) {
    const now = start + minute * 60_000;
    const result = box.script(script, {
      input: { session_id: "synthetic", cwd: box.repo, last_assistant_message: `synthetic turn ${minute}` },
      env: { TEST_NOW: String(now), TEST_CALLS: calls, TEST_FRESH: jwt({ exp: Math.floor(now / 1000) + 900 }), ...extra },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result;
  }
  return { data: box.data, repo: box.repo, credentials, sessionPath: box.sessionFile, token,
    hook: minute => run("stop.js", minute),
    drain: (minute, extra) => run("drain_once.js", minute, extra),
    records: () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
  };
}

test("active turns deliver exactly once across two token lifetimes with no monitor", t => {
  const f = expiry(t);
  for (let minute = 0; minute <= 34; minute += 2) {
    assert.match(f.hook(minute).stderr, /logged/);
    f.drain(minute);
  }
  assert.equal(f.records().filter(r => r.url?.endsWith("/oauth2/token")).length, 3);
  assert.equal(f.records().filter(r => r.url?.endsWith("/activate")).length, 3);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), Array(18).fill("Stop"));
  assert.deepEqual(f.records().flatMap(r => r.messages || []), Array.from({ length: 18 }, (_, i) => `synthetic turn ${i * 2}`));
});

test("a failed renewal preserves the sealed event until later recovery", t => {
  const f = expiry(t);
  f.hook(16);
  const logs = path.join(f.data, "logs");
  const sealed = fs.readdirSync(logs).find(name => /^events\.jsonl\.\d+$/.test(name));
  assert.ok(sealed);
  const before = fs.readFileSync(path.join(logs, sealed));
  f.drain(16, { TEST_REFRESH_STATUS: "503" });
  assert.deepEqual(fs.readFileSync(path.join(logs, sealed)), before);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), []);
  f.drain(20);
  assert.deepEqual(f.records().flatMap(r => r.uploaded || []), ["Stop"]);
});

test("signout after a hook blocks a pending worker from renewing or sending", t => {
  const f = expiry(t);
  f.hook(16);
  fs.writeFileSync(f.sessionPath, JSON.stringify({ signed_out: true, auth_generation: "after-signout" }));
  f.drain(16);
  assert.equal(f.records().filter(r => r.url).length, 0);
  // A signed-out session covers no organization.
  assert.match(f.hook(17).stderr, /skipped \(repository out of scope\)/);
});

test("project opt-out suppresses new capture and worker launch", t => {
  const f = expiry(t);
  fs.writeFileSync(path.join(f.repo, ".codex/settings.local.json"), JSON.stringify({ skillmeter: { telemetry: false } }));
  assert.match(f.hook(16).stderr, /disabled for this project/);
  assert.deepEqual(f.records(), []);
});

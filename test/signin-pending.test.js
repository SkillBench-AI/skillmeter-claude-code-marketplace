"use strict";

// ADR 003 decision 3: /skillmeter:signin writes a `pending` result while the
// device flow waits for browser approval, and the flow's outcome replaces it.
// The sign-in notice ignores `pending`, and the slash command reports a sign-in
// in progress instead of starting a new one, which would discard the waiting
// sign-in.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { accountDir, makeJwt, makeTempDir, readJson, readSession, setTestEnv, writeCredentials, writeFile, writeJson } = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const IDENTITY = { device_id: "SIGNIN-PENDING-DEVICE", hash_salt: "0123456789abcdef0123456789abcdef" };

// A client with no license, so signin.js starts the device flow. The broker and
// the license server are stubbed. The background poll is not spawned: its
// arguments are kept, and pollInBackground() runs it once the test has done
// whatever happens while the browser step is pending.
function fixture() {
  const root = makeTempDir("skm-signin-pending-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const spawned = path.join(root, "background-poll.json");
  writeCredentials(state, IDENTITY, { dataDir: data });
  const license = makeJwt({ exp: Math.floor(Date.now() / 1000) + 900, org: { login: "acme" }, orgs: ["acme"] });
  const env = { PATH: process.env.PATH, TMPDIR: os.tmpdir(), HOME: root, SKILLMETER_STATE_DIR: state, CLAUDE_PLUGIN_DATA: data };

  const signin = ({ tty, activateStatus = 200, args = [] }) => {
    const preload = path.join(root, "preload.cjs");
    writeFile(preload, `
      const fs = require("fs");
      Object.defineProperty(process.stdout, "isTTY", { value: ${tty} });
      const cp = require("child_process");
      cp.spawnSync = () => ({ status: 1 }); // no clipboard
      cp.spawn = (command, argv) => {
        fs.writeFileSync(${JSON.stringify(spawned)}, JSON.stringify(argv));
        return { unref() {} };
      };
      global.fetch = async (url) => {
        const target = String(url);
        let status = 200, payload;
        if (target.endsWith("/device/auth")) payload = { device_code: "dc", user_code: "ABCDEFGH", verification_uri: "https://fixture.invalid", expires_in: 600, interval: 0.001 };
        else if (target.endsWith("/oauth2/token")) payload = { id_token: "fixture-id", refresh_token: "fixture-refresh" };
        else if (target.endsWith("/activate")) { status = ${activateStatus}; payload = status === 200 ? { token: ${JSON.stringify(license)} } : { code: "no_license" }; }
        else throw new Error("unexpected " + target);
        return { ok: status === 200, status, json: async () => payload, text: async () => JSON.stringify(payload) };
      };
    `);
    return spawnSync(process.execPath, ["-r", preload, path.join(SCRIPTS, "signin.js"), ...args], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: root,
      env: { ...env, SKILLMETER_BROKER_URL: "https://id.test", SKILLMETER_ACTIVATE_URL: "https://activation.test/activate" },
    });
  };

  // The browser step is done: run the poll signin.js would have spawned.
  const pollInBackground = () => signin({ tty: false, args: readJson(spawned).slice(1) });

  // The slash command's expansion hook; returns the context it hands Claude.
  const slashCommand = () => {
    const result = spawnSync(process.execPath, [path.join(SCRIPTS, "user_prompt_expansion_signin.js")], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: root,
      env,
      input: JSON.stringify({ command_name: "skillmeter:signin", command_source: "plugin", cwd: root }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  };

  const account = accountDir(state, data);
  const read = (name) => (fs.existsSync(path.join(account, name)) ? readJson(path.join(account, name)) : null);
  return {
    signin,
    pollInBackground,
    slashCommand,
    sentinel: () => read("signin-result.json"),
    status: () => read("license-status.json"),
    session: () => readSession(state, { dataDir: data }),
  };
}

test("the device flow leaves a pending result that lasts as long as the device code", () => {
  const f = fixture();
  const result = f.signin({ tty: false });
  assert.equal(result.status, 0, result.stderr);
  const sentinel = f.sentinel();
  assert.equal(sentinel.status, "pending");
  const lifetime = sentinel.expires_at - sentinel.ts;
  assert.ok(lifetime > 599_000 && lifetime <= 600_000, `pending lasts the device code's 600 s, got ${lifetime} ms`);
});

// The race this sentinel closes. The skill tells the user to run
// /skillmeter:signin again after approving; run before the poll commits, the
// slash command used to start a new intent and the poll then discarded the
// approved sign-in.
test("/skillmeter:signin while a first sign-in waits for approval reports it in progress and keeps it", () => {
  const f = fixture();
  const started = f.signin({ tty: false });
  assert.equal(started.status, 0, started.stderr);
  const intent = f.session().auth_generation;
  assert.equal(f.sentinel().status, "pending");

  const context = f.slashCommand();
  assert.match(context, /sign-in in progress/);
  assert.match(context, /! .*bin\/signin/, "with a way to start over");
  assert.doesNotMatch(context, /Sign-in is required/);
  assert.equal(f.session().auth_generation, intent, "no new intent");

  const poll = f.pollInBackground();
  assert.equal(poll.status, 0, poll.stderr);
  assert.doesNotMatch(poll.stderr, /discarded/);
  assert.ok(f.session().license_jwt, "the approved sign-in is kept");
  assert.equal(f.sentinel().status, "success");
  assert.match(f.slashCommand(), /sign-in state JSON/);
});

test("a finished sign-in replaces pending with success", () => {
  const f = fixture();
  const result = f.signin({ tty: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.sentinel().status, "success");
});

test("a failed sign-in replaces pending with failure", () => {
  const f = fixture();
  const result = f.signin({ tty: true, activateStatus: 402 });
  assert.equal(result.status, 1);
  const sentinel = f.sentinel();
  assert.equal(sentinel.status, "failure");
  assert.match(sentinel.error, /No active SkillMeter license/);
});

test("the sign-in notice ignores pending and still reports an outcome", () => {
  const root = makeTempDir("skm-signin-pending-notice-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  writeCredentials(state, IDENTITY, { dataDir: data });
  const sentinel = path.join(accountDir(state, data), "signin-result.json");
  const marker = path.join(accountDir(state, data), ".signin-notified");
  const notify = () => spawnSync(process.execPath, [path.join(SCRIPTS, "on_signin_result.js")], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: root,
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), HOME: root, SKILLMETER_STATE_DIR: state, CLAUDE_PLUGIN_DATA: data },
  });

  writeJson(sentinel, { status: "pending", expires_at: Date.now() + 600_000, ts: Date.now() });
  const pending = notify();
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stdout, "");
  assert.equal(fs.existsSync(marker), false, "pending does not use up the dedupe marker");

  writeJson(sentinel, { status: "failure", error: "fixture error", ts: Date.now() + 1 });
  assert.match(JSON.parse(notify().stdout).systemMessage, /sign-in failed — fixture error/);
});

test("isSigninPending: only an unexpired pending result", () => {
  setTestEnv("SKILLMETER_STATE_DIR", makeTempDir("skm-signin-pending-state-"));
  const credstore = require("../skillmeter/scripts/credstore");
  const now = Date.now();
  credstore.writeSigninResult({ status: "pending", expires_at: now + 1000 });
  assert.equal(credstore.isSigninPending(now), true);
  assert.equal(credstore.isSigninPending(now + 1000), false, "expired");
  credstore.writeSigninResult({ status: "pending" });
  assert.equal(credstore.isSigninPending(now), false, "no expiry, no wait");
  credstore.writeSigninResult({ status: "success" });
  assert.equal(credstore.isSigninPending(now), false);
});

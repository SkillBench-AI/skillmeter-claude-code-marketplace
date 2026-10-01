"use strict";

// A session the broker ended (invalid_grant) can leave a license that is still
// valid for up to one lifetime. /skillmeter:signin must then sign in again,
// not report the stale license as a sign-in, until a sign-in completes: a new
// session, or a sign-in that starts and is abandoned, does not end it. Without
// that record, a valid license still short-circuits with no network call.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { accountDir, makeTempDir, makeJwt, writeCredentials, readSession, writeFile, writeTelemetryPolicy } = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const LICENSE_STATUS = path.join(SCRIPTS, "lib/license-status.js");

// A signed-in client whose license is valid for ten more minutes.
function fixture() {
  const root = makeTempDir("skm-signin-ended-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const calls = path.join(root, "calls.jsonl");
  const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600, org: { login: "acme" }, orgs: ["acme"] });
  writeCredentials(state, {
    device_id: "SIGNIN-ENDED-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: stale,
    refresh_token: "fixture-dead-refresh",
    auth_generation: "before-the-command",
  }, { dataDir: data });
  const env = { PATH: process.env.PATH, TMPDIR: os.tmpdir(), HOME: root, SKILLMETER_STATE_DIR: state, CLAUDE_PLUGIN_DATA: data };

  // Run a snippet with the status module, in this client's state.
  const status = (code) => {
    const result = spawnSync(process.execPath, ["-e", `const ls = require(${JSON.stringify(LICENSE_STATUS)}); ${code}`], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  // signin.js, or its background poll, with the broker and the license server
  // stubbed. `spawn` is stubbed too: a background poll started by main() never
  // runs, which is a sign-in abandoned before the browser step.
  const signin = ({ tty = true, args = [] } = {}) => {
    const preload = path.join(root, "preload.cjs");
    writeFile(preload, `
      const fs = require("fs");
      process.env.CLAUDE_PLUGIN_DATA = ${JSON.stringify(data)};
      Object.defineProperty(process.stdout, "isTTY", { value: ${tty} });
      const cp = require("child_process");
      cp.spawnSync = () => ({ status: 1 }); // no clipboard
      cp.spawn = () => ({ unref() {} });
      global.fetch = async (url) => {
        const target = String(url);
        fs.appendFileSync(${JSON.stringify(calls)}, target + "\\n");
        let payload;
        if (target.endsWith("/device/auth")) payload = { device_code: "dc", user_code: "ABCDEFGH", verification_uri: "https://fixture.invalid", expires_in: 600, interval: 0.001 };
        else if (target.endsWith("/oauth2/token")) payload = { id_token: "fixture-id", refresh_token: "fixture-new-refresh" };
        else if (target.endsWith("/activate")) payload = { token: ${JSON.stringify(makeJwt({ exp: Math.floor(Date.now() / 1000) + 900, org: { login: "acme" }, orgs: ["acme"] }))} };
        else throw new Error("unexpected " + target);
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      };
    `);
    return spawnSync(process.execPath, ["-r", preload, path.join(SCRIPTS, "signin.js"), ...args], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: root,
      env: { ...env, SKILLMETER_BROKER_URL: "https://id.test", SKILLMETER_ACTIVATE_URL: "https://activation.test/activate" },
    });
  };

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

  // A checkout of a repository whose organization and repository telemetry are on.
  const enabledRepository = () => {
    const repo = path.join(root, "widgets");
    writeFile(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n`);
    writeTelemetryPolicy(state, { orgs: { acme: true }, repositories: { "github.com/acme/widgets": true } });
    return repo;
  };

  // The SessionStart hook in `cwd`; returns the title of the card it shows.
  const sessionStart = (cwd) => {
    const result = spawnSync(process.execPath, [path.join(SCRIPTS, "session_start.js")], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: root,
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        XDG_CONFIG_HOME: path.join(root, ".config"),
        SKILLMETER_BROKER_URL: "https://id.test",
        // Nothing may upload anywhere real.
        SKILLMETER_BACKEND_URL: "http://127.0.0.1:9",
      },
      input: JSON.stringify({ session_id: "ended-session", cwd, source: "startup" }),
    });
    assert.equal(result.status, 0, result.stderr);
    const message = JSON.parse(result.stdout.trim().split("\n").pop()).systemMessage || "";
    return (message.match(/\[ ([A-Z ]+) \]/) || [null, "no card"])[1];
  };

  const urls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : []);
  const session = () => readSession(state, { dataDir: data });
  const statusFile = path.join(accountDir(state, data), "license-status.json");
  // Let the device code of a started sign-in run out.
  const expirePending = () => {
    const sentinel = path.join(accountDir(state, data), "signin-result.json");
    const result = JSON.parse(fs.readFileSync(sentinel, "utf8"));
    assert.equal(result.status, "pending");
    fs.writeFileSync(sentinel, JSON.stringify({ ...result, expires_at: Date.now() - 1 }));
  };
  return { stale, status, signin, slashCommand, enabledRepository, sessionStart, urls, session, statusFile, expirePending };
}

const END_SESSION = "ls.recordTerminal({ source: \"drain\", reason: ls.TERMINAL_REASONS.REACTIVATION_REQUIRED, status: 400 });";
const NEW_SESSION = "ls.clearTerminal({ source: \"session_start\" });";

test("after the broker ended the session, sign-in runs the device flow even while the license is valid", () => {
  const f = fixture();
  f.status(END_SESSION);
  const result = f.signin();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /session ended/);
  assert.deepEqual(f.urls(), ["https://id.test/oauth2/device/auth", "https://id.test/oauth2/token", "https://activation.test/activate"]);
  assert.notEqual(f.session().license_jwt, f.stale);
  assert.equal(f.session().refresh_token, "fixture-new-refresh");
});

test("a valid license with no ended session is still reported as signed in, with no network call", () => {
  const f = fixture();
  const result = f.signin();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.urls(), []);
  assert.equal(f.session().license_jwt, f.stale);
  assert.equal(f.session().refresh_token, "fixture-dead-refresh");
});

test("a new session in between does not hide the ended session from sign-in", () => {
  // SessionStart clears the terminal state to give the session one attempt.
  const f = fixture();
  f.status(END_SESSION + NEW_SESSION);
  const result = f.signin();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /session ended/);
  assert.equal(f.urls()[0], "https://id.test/oauth2/device/auth");
  assert.equal(f.session().refresh_token, "fixture-new-refresh");
});

// The slash command runs the expansion hook first. It must not report the old
// license as a sign-in, nor reset what the sign-in command reads.
test("/skillmeter:signin asks for a new sign-in when the session ended, and leaves the record for the command", () => {
  const f = fixture();
  f.status(END_SESSION);
  const before = fs.readFileSync(f.statusFile, "utf8");
  const context = f.slashCommand();
  assert.match(context, /session ended\. Sign-in is required\./);
  assert.match(context, /! .*bin\/signin/);
  assert.doesNotMatch(context, /sign-in state JSON/);
  assert.equal(fs.readFileSync(f.statusFile, "utf8"), before, "the record is left for the sign-in command");
  assert.equal(f.session().auth_generation, "before-the-command", "no new intent yet");
});

test("a sign-in that starts and is abandoned leaves the session ended", () => {
  const f = fixture();
  f.status(END_SESSION + NEW_SESSION);
  // ! bin/signin: a new intent, the record cleared, the browser step never done.
  const started = f.signin({ tty: false });
  assert.equal(started.status, 0, started.stderr);
  const intent = f.session().auth_generation;
  assert.notEqual(intent, "before-the-command");
  assert.equal(f.session().license_jwt, f.stale, "the old license is still stored");

  // Confirming before the browser step is done: no new intent, no stale report.
  let context = f.slashCommand();
  assert.match(context, /sign-in in progress/);
  assert.match(context, /! .*bin\/signin/);
  assert.equal(f.session().auth_generation, intent, "the waiting sign-in is not discarded");

  f.expirePending();
  context = f.slashCommand();
  assert.match(context, /session ended\. Sign-in is required\./);
  assert.doesNotMatch(context, /sign-in state JSON/);
  // The sign-in command, run again, still signs in, and that ends it.
  assert.match(f.signin().stderr, /session ended/);
  assert.equal(f.session().refresh_token, "fixture-new-refresh");
  assert.match(f.slashCommand(), /sign-in state JSON/);
});

test("a completed background sign-in ends it", () => {
  const f = fixture();
  f.status(END_SESSION);
  const poll = f.signin({ tty: false, args: ["--background-poll", "SIGNIN-ENDED-DEVICE", "dc", "0.001", "before-the-command"] });
  assert.equal(poll.status, 0, poll.stderr);
  assert.equal(f.session().refresh_token, "fixture-new-refresh");
  assert.match(f.slashCommand(), /sign-in state JSON/);
});

test("the SessionStart card asks for sign-in in every session until a sign-in completes", () => {
  const f = fixture();
  const repo = f.enabledRepository();
  assert.equal(f.sessionStart(repo), "TELEMETRY ON");
  f.status(END_SESSION);
  assert.equal(f.sessionStart(repo), "ACTION REQUIRED");
  // That SessionStart cleared `terminal`; no refresh writes it again.
  assert.equal(f.sessionStart(repo), "ACTION REQUIRED", "the next session too");
  assert.equal(f.signin().status, 0);
  assert.equal(f.sessionStart(repo), "TELEMETRY ON");
});

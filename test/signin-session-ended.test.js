"use strict";

// A session the broker ended (invalid_grant) can leave a license that is still
// valid for up to one lifetime. /skillmeter:signin must then sign in again,
// not report the stale license as a sign-in. Without that record, a valid
// license still short-circuits with no network call.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { makeTempDir, makeJwt, writeCredentials, readSession, writeFile } = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");

function run({ sessionEnded }) {
  const root = makeTempDir("skm-signin-ended-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const calls = path.join(root, "calls.jsonl");
  const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600, org: { login: "acme" } });
  writeCredentials(state, {
    device_id: "SIGNIN-ENDED-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: stale,
    refresh_token: "fixture-dead-refresh",
  }, { dataDir: data });

  const preload = path.join(root, "preload.cjs");
  writeFile(preload, `
    const fs = require("fs");
    process.env.CLAUDE_PLUGIN_DATA = ${JSON.stringify(data)};
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    if (${sessionEnded}) {
      const ls = require(${JSON.stringify(path.join(SCRIPTS, "lib/license-status.js"))});
      ls.recordTerminal({ source: "drain", reason: ls.TERMINAL_REASONS.REACTIVATION_REQUIRED, status: 400 });
    }
    const cp = require("child_process");
    cp.spawnSync = () => ({ status: 1 }); // no clipboard
    cp.spawn = () => { throw new Error("unexpected spawn"); };
    global.fetch = async (url) => {
      const target = String(url);
      fs.appendFileSync(${JSON.stringify(calls)}, target + "\\n");
      let payload;
      if (target.endsWith("/device/auth")) payload = { device_code: "dc", user_code: "ABCDEFGH", verification_uri: "https://fixture.invalid", expires_in: 600, interval: 0.001 };
      else if (target.endsWith("/oauth2/token")) payload = { id_token: "fixture-id", refresh_token: "fixture-new-refresh" };
      else if (target.endsWith("/activate")) payload = { token: ${JSON.stringify(makeJwt({ exp: Math.floor(Date.now() / 1000) + 900, org: { login: "acme" } }))} };
      else throw new Error("unexpected " + target);
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    };
  `);
  const result = spawnSync(process.execPath, ["-r", preload, path.join(SCRIPTS, "signin.js")], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: root,
    env: {
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      HOME: root,
      SKILLMETER_STATE_DIR: state,
      SKILLMETER_BROKER_URL: "https://id.test",
      SKILLMETER_ACTIVATE_URL: "https://activation.test/activate",
    },
  });
  const urls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
  return { result, urls, session: readSession(state, { dataDir: data }), stale };
}

test("after the broker ended the session, sign-in runs the device flow even while the license is valid", () => {
  const { result, urls, session, stale } = run({ sessionEnded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /session ended/);
  assert.deepEqual(urls, ["https://id.test/oauth2/device/auth", "https://id.test/oauth2/token", "https://activation.test/activate"]);
  assert.notEqual(session.license_jwt, stale);
  assert.equal(session.refresh_token, "fixture-new-refresh");
});

test("a valid license with no ended session is still reported as signed in, with no network call", () => {
  const { result, urls, session, stale } = run({ sessionEnded: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(urls, []);
  assert.equal(session.license_jwt, stale);
  assert.equal(session.refresh_token, "fixture-dead-refresh");
});

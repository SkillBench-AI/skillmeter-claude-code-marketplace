"use strict";

// ADR 005: sign-out takes effect locally at once, then revokes the broker
// refresh token. A broker that cannot be reached never blocks sign-out.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, makeJwt, isolatedEnv, runNode, writeCredentials, readSession, writeFile } = require("../testing/helpers");

const SIGNOUT = path.resolve(__dirname, "../skillmeter/scripts/signout.js");

function fixture({ online }) {
  const root = makeTempDir("skm-signout-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const calls = path.join(root, "calls.jsonl");
  writeCredentials(state, {
    device_id: "SIGNOUT-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({ exp: Math.floor(Date.now() / 1000) + 900, org: { login: "acme" } }),
    refresh_token: "ory_rt_fixture-signout",
  }, { dataDir: data });
  const preload = path.join(root, "preload.cjs");
  writeFile(preload, `
    const fs = require("fs");
    global.fetch = async (url, options) => {
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
        url: String(url), form: Object.fromEntries(new URLSearchParams(options.body)),
      }) + "\\n");
      if (!${online}) throw new Error("offline");
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    };
  `);
  const result = runNode(SIGNOUT, [], {
    env: isolatedEnv({
      SKILLMETER_STATE_DIR: state,
      CLAUDE_PLUGIN_DATA: data,
      SKILLMETER_BROKER_URL: "https://id.test",
      NODE_OPTIONS: `--require=${preload}`,
    }),
  });
  const recorded = fs.existsSync(calls)
    ? fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  return { result, recorded, session: readSession(state, { dataDir: data }) };
}

test("sign-out clears the session locally and revokes the refresh token at the broker", () => {
  const { result, recorded, session } = fixture({ online: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /signed out/);
  assert.equal(session.signed_out, true);
  assert.equal(session.license_jwt, undefined);
  assert.equal(session.refresh_token, undefined);
  assert.deepEqual(recorded.map((c) => c.url), ["https://id.test/oauth2/revoke"]);
  assert.equal(recorded[0].form.token, "ory_rt_fixture-signout");
  assert.equal(recorded[0].form.token_type_hint, "refresh_token");
  assert.doesNotMatch(result.stdout + result.stderr, /ory_rt_fixture-signout/);
});

test("sign-out completes when the broker cannot be reached, and says so", () => {
  const { result, session } = fixture({ online: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(session.signed_out, true);
  assert.equal(session.refresh_token, undefined);
  assert.match(result.stdout, /could not reach the sign-in service/);
});

"use strict";
// The sign-in flow shared with SkillMeter for Claude Code (lib/signin-flow.js),
// run as the Codex signin script without a TTY: the device code is shown and
// the poll goes to a background process, which these tests only record.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sandbox, DEFAULT_CREDENTIALS } = require("../../../test-support/plugin.cjs");

// The broker's device authorization, with no expires_in, and a token endpoint
// that says the code expired; nothing else may reach the network, the
// clipboard or a shell.
const PRELOAD = `
global.fetch = async (url) => {
  if (String(url).endsWith("/oauth2/device/auth")) {
    return { ok: true, status: 200, text: async () => JSON.stringify({
      device_code: "synthetic-device-code", user_code: "ABCD-EFGH",
      verification_uri: "https://id.skillbench.ai/device", interval: 5 }) };
  }
  if (String(url).endsWith("/oauth2/token")) {
    return { ok: false, status: 400, text: async () => JSON.stringify({ error: "expired_token" }) };
  }
  throw Error("unexpected network " + url);
};
const cp = require("child_process");
cp.spawnSync = () => ({ status: 1 });
cp.execSync = () => { throw Error("unexpected shell"); };
cp.spawn = () => { require("fs").appendFileSync(process.env.TEST_SPAWNS, "spawn\\n"); return { pid: 999999, unref() {} }; };
`;

function signedOut(t) {
  const { license_jwt, refresh_token, ...identity } = DEFAULT_CREDENTIALS;
  return sandbox(t, { preload: PRELOAD, credentials: identity });
}
const spawns = box => (fs.existsSync(path.join(box.root, "spawns")) ? fs.readFileSync(path.join(box.root, "spawns"), "utf8").split("\n").filter(Boolean).length : 0);

test("a device code without a lifetime shows the default, and polls in the background", t => {
  const box = signedOut(t);
  const run = box.script("signin.js");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ABCD-EFGH/);
  assert.match(run.stdout, /Code expires in 15 minutes\./, "not NaN when the broker omits expires_in");
  assert.match(run.stdout, /run \$skillmeter:signin again to confirm and choose telemetry/);
  assert.equal(spawns(box), 1);
});

test("running sign-in again while a code waits reports it instead of cancelling it", t => {
  const box = signedOut(t);
  assert.equal(box.script("signin.js").status, 0);
  const again = box.script("signin.js");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /sign-in in progress/);
  assert.match(again.stdout, /--restart/);
  assert.doesNotMatch(again.stdout, /ABCD-EFGH/, "no new code");
  assert.equal(spawns(box), 1, "no second poll");

  const restart = box.script("signin.js", { args: ["--restart"] });
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stdout, /ABCD-EFGH/, "--restart starts over");
  assert.equal(spawns(box), 2);
});

test("a failed background poll stops reporting the sign-in as waiting", t => {
  const box = signedOut(t);
  assert.equal(box.script("signin.js").status, 0);
  const session = JSON.parse(fs.readFileSync(box.sessionFile, "utf8"));
  // The poll the first run spawned, failing at the broker.
  const poll = box.script("signin.js", { args: ["--background-poll", "SYNTHETIC", "synthetic-device-code", "1", session.auth_generation], timeout: 20_000 });
  assert.equal(poll.status, 1);
  assert.match(poll.stderr, /The code expired\. Run \$skillmeter:signin again\./);
  const again = box.script("signin.js");
  assert.doesNotMatch(again.stdout, /sign-in in progress/);
  assert.match(again.stdout, /ABCD-EFGH/);
});

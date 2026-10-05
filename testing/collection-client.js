"use strict";

// A SkillMeter client in temporary directories, for tests that build a
// collection state through the real writers and read it back through the
// real scripts: the SessionStart card, /skillmeter:telemetry status and the
// collection notice. Nothing reaches the network or `~/.skillbench/`.

const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { accountDir, makeJwt, makeTempDir, writeCredentials, writeFile, writeTelemetryPolicy } = require("./helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const ORG = "acme";
const REPO_KEY = `github.com/${ORG}/widgets`;
const ENABLED = { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } };

const license = (expiresInSec = 900) =>
  makeJwt({ exp: Math.floor(Date.now() / 1000) + expiresInSec, org: { login: ORG }, orgs: [ORG] });

// The writers, as the plugin calls them. `signIn` commits the way signin.js
// does, so the status record and the sign-in result change with the session.
const WRITERS = `
  const cs = require(${JSON.stringify(path.join(SCRIPTS, "credstore.js"))});
  const ls = require(${JSON.stringify(path.join(SCRIPTS, "lib/license-status.js"))});
  const startSignin = () => { cs.markEngaged(); ls.clearLicenseStatus({ source: "signin" }); };
  const signIn = (jwt) => {
    startSignin();
    cs.commitSignin({ jwt, onCommit: () => {
      ls.recordSignin({ source: "signin" });
      cs.writeSigninResult({ status: "success" });
    } });
  };
  const signOut = () => cs.signOut();
  const endSession = () => ls.recordTerminal({ source: "drain", reason: "reactivation_required", status: 410 });
  // The license gone without a sign-out: a corrupt or deleted session file.
  const loseLicense = () => require("fs").writeFileSync(cs.SESSION_FILE, JSON.stringify({ auth_generation: "lost" }));
  const revoke = () => cs.dropRevokedLicense(cs.recoverySnapshot(),
    () => ls.recordTerminal({ source: "drain", reason: "revoked", status: 402 }));
  const renew = (jwt) => {
    cs.commitRotation(cs.recoverySnapshot(), "rotated-refresh-token");
    cs.commitRefresh(jwt, cs.recoverySnapshot());
    ls.recordRefreshSuccess({ source: "drain", outcome: "rotated" });
  };
`;

function collectionClient({ policy = ENABLED } = {}) {
  const root = makeTempDir("skm-collection-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const repo = path.join(root, "widgets");
  writeFile(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/${ORG}/widgets.git\n`);
  writeCredentials(state, { device_id: "COLLECTION-DEVICE", hash_salt: "0123456789abcdef0123456789abcdef" }, { dataDir: data });
  writeTelemetryPolicy(state, policy);
  const account = accountDir(state, data);
  const env = {
    PATH: process.env.PATH,
    TMPDIR: os.tmpdir(),
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    XDG_CONFIG_HOME: path.join(root, ".config"),
    SKILLMETER_STATE_DIR: state,
    CLAUDE_PLUGIN_DATA: data,
    SKILLMETER_BROKER_URL: "https://id.test",
    // Nothing may upload anywhere real.
    SKILLMETER_BACKEND_URL: "http://127.0.0.1:9",
  };
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15_000, cwd: repo, env, ...options });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  // FileChanged's stdin, as Claude Code gives it.
  const changed = (sessionId, file) => JSON.stringify({
    session_id: sessionId,
    hook_event_name: "FileChanged",
    file_path: path.join(account, file),
    event: "change",
    cwd: repo,
  });
  const lastJson = (stdout) => {
    const line = stdout.trim().split("\n").pop();
    return line ? JSON.parse(line) : null;
  };

  return {
    root,
    repo,
    account,
    env,
    write: (code) => run(["-e", WRITERS + code]),
    setPolicy: (next) => writeTelemetryPolicy(state, next),
    // SessionStart for `sessionId`: its card, or "".
    sessionStart: (sessionId = "card", cwd = repo) =>
      lastJson(run([path.join(SCRIPTS, "session_start.js")], {
        input: JSON.stringify({ session_id: sessionId, cwd, source: "startup" }),
      }).stdout).systemMessage || "",
    // /skillmeter:telemetry status in `cwd`, as "label: value" pairs.
    status: (cwd = repo) => {
      const { stdout, stderr } = run([path.join(SCRIPTS, "telemetry.js"), "status"], { cwd });
      assert.equal(stdout, "", "status reports on stderr, as the skill reads it");
      const lines = {};
      for (const line of stderr.split("\n")) {
        const match = line.match(/^ {2}([a-z ]+):\s+(.*)$/);
        if (match) lines[match[1]] = match[2];
      }
      return { text: stderr, lines };
    },
    // The collection notice for `sessionId` after `file` changed: the hook's
    // JSON output, or null when it printed nothing.
    notice: (sessionId, file = "session.json") =>
      lastJson(run([path.join(SCRIPTS, "on_collection_state.js")], { input: changed(sessionId, file) }).stdout),
    // Any handler, started without waiting: Claude Code starts every open
    // session's handlers for files written together at the same moment.
    started: (script, sessionId, file) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(SCRIPTS, script)], { cwd: repo, env });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(lastJson(stdout)) : reject(new Error(`exit ${code}`))));
      child.stdin.end(changed(sessionId, file));
    }),
    // The sign-in result notice for `sessionId`, the same way.
    signinNotice: (sessionId) =>
      lastJson(run([path.join(SCRIPTS, "on_signin_result.js")], { input: changed(sessionId, "signin-result.json") }).stdout),
    // A capture hook's stderr in the repository.
    hookStderr: () =>
      run([path.join(SCRIPTS, "hook.js"), "UserPromptSubmit"], {
        input: JSON.stringify({ session_id: "capture", cwd: repo, prompt: "hello" }),
      }).stderr,
    sessionStateDir: () => path.join(account, "collection-state"),
  };
}

module.exports = { ORG, REPO_KEY, ENABLED, SCRIPTS, license, collectionClient };

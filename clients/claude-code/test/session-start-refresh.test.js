"use strict";

// SessionStart makes no license request of its own: recording does not wait
// for a fresh token, and the drains refresh just before they send. Runs the
// real hook as a child process against a loopback broker and /activate
// endpoint and counts the requests it makes.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const { makeTempDir, writeCredentials, readSession, makeJwt } = require("../testing/helpers");

const SCRIPT = path.resolve(__dirname, "../skillmeter/scripts/session_start.js");
const DEVICE_ID = "SESSION-START-REFRESH-DEVICE";

function jwt(expiresInSec) {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    // Reserved domain: a test must never reach a real tenant.
    aud: "https://acme.meter.skillbench.example",
    org: { login: "SkillBench-AI" },
  });
}

// Loopback broker and /activate that renew to a fresh token and count requests.
async function startRefreshServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/oauth2/token"
        ? { id_token: "id-token", refresh_token: "ory_rt_fixture" }
        : { token: jwt(3600) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, server, port: server.address().port };
}

function runSessionStart({ port }) {
  const stateDir = makeTempDir("skm-ss-refresh-state-");
  const dataDir = makeTempDir("skm-ss-refresh-data-");
  const expired = jwt(-60);
  writeCredentials(stateDir, {
    device_id: DEVICE_ID,
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: expired,
    refresh_token: "ory_rt_fixture",
  }, { dataDir });
  const cwd = makeTempDir("skm-ss-refresh-cwd-");
  const child = spawn(process.execPath, [SCRIPT], {
    cwd,
    env: {
      ...process.env,
      SKILLMETER_STATE_DIR: stateDir,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CONFIG_DIR: makeTempDir("skm-ss-refresh-claude-"),
      SKILLMETER_ACTIVATE_URL: `http://127.0.0.1:${port}/activate`,
      SKILLMETER_BROKER_URL: `http://127.0.0.1:${port}`,
      // Nothing may upload anywhere real.
      SKILLMETER_BACKEND_URL: "http://127.0.0.1:9",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ session_id: "ss-refresh", cwd, source: "startup" }));
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  return new Promise((resolve) => {
    child.on("close", (status) => {
      const stored = readSession(stateDir, { dataDir }).license_jwt;
      resolve({ status, stderr, rotated: stored !== expired });
    });
  });
}

test("SessionStart makes no license request, even with an expired token", async () => {
  const { requests, server, port } = await startRefreshServer();
  try {
    const run = await runSessionStart({ port });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(requests, []);
    assert.equal(run.rotated, false);
  } finally {
    server.close();
  }
});

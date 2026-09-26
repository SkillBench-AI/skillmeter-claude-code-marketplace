"use strict";

// SessionStart refreshes through the same single-flight lock as the daemon and
// the drains (ADR 001: the lock-file cooldown is the single-flight mechanism
// across concurrent sessions). Runs the real hook as a child process against a
// loopback /refresh endpoint and counts the requests it makes.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const { makeTempDir, writeJson, readJson, makeJwt } = require("../testing/helpers");

const SCRIPT = path.resolve(__dirname, "../scripts/session_start.js");
const DEVICE_ID = "SESSION-START-REFRESH-DEVICE";

function jwt(expiresInSec) {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    // Reserved domain: a test must never reach a real tenant.
    aud: "https://acme.meter.skillbench.example",
    org: { login: "SkillBench-AI" },
  });
}

// Loopback /refresh that rotates to a fresh token and counts requests.
async function startRefreshServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: jwt(3600) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, server, port: server.address().port };
}

function runSessionStart({ port, lockAgeMs }) {
  const stateDir = makeTempDir("skm-ss-refresh-state-");
  const dataDir = makeTempDir("skm-ss-refresh-data-");
  const expired = jwt(-60);
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: DEVICE_ID,
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: expired,
  });
  if (lockAgeMs != null) {
    const lock = path.join(dataDir, "logs", ".license-refresh.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const t = (Date.now() - lockAgeMs) / 1000;
    fs.utimesSync(lock, t, t);
  }
  const cwd = makeTempDir("skm-ss-refresh-cwd-");
  const child = spawn(process.execPath, [SCRIPT], {
    cwd,
    env: {
      ...process.env,
      SKILLMETER_STATE_DIR: stateDir,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CONFIG_DIR: makeTempDir("skm-ss-refresh-claude-"),
      SKILLMETER_ACTIVATE_URL: `http://127.0.0.1:${port}/activate`,
      // Nothing may upload anywhere real.
      SKILLMETER_BACKEND_URL: "http://127.0.0.1:9",
      SKILLMETER_ENV: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ session_id: "ss-refresh", cwd, source: "startup" }));
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  return new Promise((resolve) => {
    child.on("close", (status) => {
      const stored = readJson(path.join(stateDir, "credentials.json")).license_jwt;
      resolve({ status, stderr, rotated: stored !== expired });
    });
  });
}

test("SessionStart refreshes an expired license when no refresh is in flight", async () => {
  const { requests, server, port } = await startRefreshServer();
  try {
    const run = await runSessionStart({ port, lockAgeMs: null });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(requests, ["/refresh"]);
    assert.equal(run.rotated, true, "the rotated token is stored");
  } finally {
    server.close();
  }
});

test("SessionStart skips the refresh while another process holds the lock", async () => {
  // A lock younger than the 60 s cooldown means a daemon, drain or another
  // session is refreshing (or just did); a second POST with the same token
  // is exactly what the single-flight exists to prevent.
  const { requests, server, port } = await startRefreshServer();
  try {
    const run = await runSessionStart({ port, lockAgeMs: 5_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(requests, []);
    assert.equal(run.rotated, false);
  } finally {
    server.close();
  }
});

test("SessionStart reclaims a stale lock and refreshes", async () => {
  const { requests, server, port } = await startRefreshServer();
  try {
    const run = await runSessionStart({ port, lockAgeMs: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(requests, ["/refresh"]);
    assert.equal(run.rotated, true);
  } finally {
    server.close();
  }
});

"use strict";

// Forces an isolated CLAUDE_PLUGIN_DATA before any scripts/ module can load.
require("./bootstrap");

const { after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tempDirs = new Set();

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "skillmeter-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function writeFile(filePath, contents = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Write a telemetry-policy.json fixture into a test state dir. Consent lives
 * exclusively in this machine policy SSOT, so tests grant it here rather than
 * through credentials.json or a project settings file.
 */
function writeTelemetryPolicy(
  stateDir,
  { enabled = true, orgs = {}, repositories = {} } = {}
) {
  const decidedAt = Date.now();
  const policy = {
    schema_version: 1,
    revision: 1,
    global: { enabled, decided_at: decidedAt, source: "user" },
    organizations: Object.fromEntries(
      Object.entries(orgs).map(([org, value]) => [
        org.toLowerCase(),
        {
          enabled: value,
          consent_version: 1,
          decided_at: decidedAt,
          source: "user",
        },
      ])
    ),
    repositories: Object.fromEntries(
      Object.entries(repositories).map(([repoKey, value]) => [
        repoKey.toLowerCase(),
        { enabled: value, decided_at: decidedAt, source: "user" },
      ])
    ),
  };
  writeJson(path.join(stateDir, "telemetry-policy.json"), policy);
  return policy;
}

function makeJwt(payload) {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function setTestEnv(name, value) {
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;

  after(() => {
    if (hadValue) process.env[name] = previous;
    else delete process.env[name];
  });
}

function runNode(script, args = [], options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    ...options,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

module.exports = {
  makeTempDir,
  writeFile,
  writeJson,
  readJson,
  writeTelemetryPolicy,
  makeJwt,
  setTestEnv,
  runNode,
};

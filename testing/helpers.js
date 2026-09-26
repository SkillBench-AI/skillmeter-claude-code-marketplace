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

/**
 * Child-process env with a fresh HOME, no global git config and a private
 * XDG_CONFIG_HOME, so a spawned script cannot read the developer's real
 * ~/.claude.json, ~/.gitconfig insteadOf rules or ~/.ssh/config.
 */
function isolatedEnv(overrides = {}) {
  const home = makeTempDir("skillmeter-home-");
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    ...overrides,
  };
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

// ADR 005: the device identity (and other clients' fields) lives in the shared
// credentials.json, this client's session in its account directory. Mirrors
// ACCOUNT_DIR in lib/paths.
const SESSION_FIELDS = ["license_jwt", "signed_out", "auth_generation"];

function accountDir(stateDir, dataDir = process.env.CLAUDE_PLUGIN_DATA) {
  const key = require("crypto").createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 12);
  return path.join(dataDir, "account", key);
}

function sessionPath(stateDir, dataDir) {
  return path.join(accountDir(stateDir, dataDir), "session.json");
}

// Write a signed-in (or signed-out) device the way the plugin stores it. The
// session file is always written, so nothing is migrated from the shared file.
function writeCredentials(stateDir, fields, { dataDir } = {}) {
  const identity = {};
  const session = {};
  for (const [key, value] of Object.entries(fields)) {
    (SESSION_FIELDS.includes(key) ? session : identity)[key] = value;
  }
  writeJson(path.join(stateDir, "credentials.json"), identity);
  writeJson(sessionPath(stateDir, dataDir), session);
}

function readSession(stateDir, { dataDir } = {}) {
  return readJson(sessionPath(stateDir, dataDir));
}

module.exports = {
  accountDir,
  sessionPath,
  writeCredentials,
  readSession,
  makeTempDir,
  writeFile,
  writeJson,
  readJson,
  writeTelemetryPolicy,
  makeJwt,
  setTestEnv,
  isolatedEnv,
  runNode,
};

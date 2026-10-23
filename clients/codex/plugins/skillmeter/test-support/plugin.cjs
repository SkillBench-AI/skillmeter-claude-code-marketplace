"use strict";
// Shared fixtures for the plugin tests. Nothing here requires plugin modules at
// load time, so a test can isolate HOME before importing credstore or logger.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

// A shell inside Claude Code inherits CLAUDE_PLUGIN_DATA. The runtime ignores
// it; clearing it keeps a regression from writing into a real plugin's directory.
delete process.env.CLAUDE_PLUGIN_DATA;

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(PLUGIN_ROOT, "scripts");
const FIXTURES = path.join(PLUGIN_ROOT, "test", "fixtures");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// Unsigned JWT; the plugin only decodes the payload.
function makeJwt(claims) {
  const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.sig`;
}

// A broker-issued license (ADR 005). `orgs` is the repository scope; `org.login`
// is the tenant slug a renewal pins.
function license(claims = {}) {
  return makeJwt({ exp: 4102444800, sub: "tenant", broker_sub: "person", org: { login: "acme" },
    orgs: ["acme"], aud: "https://acme.meter.skillbench.ai", ...claims });
}

// Session fields live in this plugin's own file; everything else is the shared
// device identity (and other clients' fields) in credentials.json.
const SESSION_FIELDS = ["license_jwt", "refresh_token", "auth_generation", "signed_out"];
const sessionFileIn = stateDir => path.join(stateDir, "clients", "codex", "session.json");
const consentPolicyFileIn = stateDir => path.join(stateDir, "clients", "codex", "telemetry-policy.json");

// Codex's consent record with acknowledged organization and repository ON for
// each repository key, as consent-set would leave it.
function grantConsent(stateDir, repoKeys, { revision = 1 } = {}) {
  const keys = [].concat(repoKeys);
  const on = { enabled: true, decided_at: 1, source: "user", consent_version: 2 };
  const file = consentPolicyFileIn(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1, revision, global: { enabled: true, decided_at: 1, source: "user" },
    organizations: Object.fromEntries(keys.map(key => [key.split("/")[1], on])),
    repositories: Object.fromEntries(keys.map(key => [key, on])),
  }));
  return file;
}

// Write a device the way the plugin stores it. The session file is always
// written with completed cutover; migration tests explicitly remove that marker.
function writeCredentials(home, credentials, { stateDir = path.join(home, ".skillbench") } = {}) {
  const identity = {}, session = { event_cutover: 1 };
  for (const [key, value] of Object.entries(credentials)) (SESSION_FIELDS.includes(key) ? session : identity)[key] = value;
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "credentials.json");
  fs.writeFileSync(file, JSON.stringify(identity) + "\n");
  fs.mkdirSync(path.dirname(sessionFileIn(stateDir)), { recursive: true });
  fs.writeFileSync(sessionFileIn(stateDir), JSON.stringify(session) + "\n");
  return file;
}

// Point HOME at a fresh directory. Call before requiring plugin modules.
function isolateHome(credentials) {
  const home = tempDir("skillmeter-home");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PLUGIN_DATA = path.join(home, "plugin-data");
  if (credentials) writeCredentials(home, credentials);
  return home;
}

function writeSettings(root, skillmeter) {
  const dir = path.join(root, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({ skillmeter }) + "\n");
}

// A checkout with a hand-written .git/config. `remote: null` gives a repository
// without any remote.
function makeRepo({ remote = "git@github.com:acme/widgets.git", telemetry, prefix = "skillmeter-repo" } = {}) {
  const root = tempDir(prefix);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"),
    remote ? `[remote "origin"]\n\turl = ${remote}\n` : "[core]\n\tbare = false\n");
  if (telemetry !== undefined) writeSettings(root, { telemetry });
  return root;
}

const transcriptLine = content =>
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content } }) + "\n";

const gunzipRecords = files => [].concat(files).flatMap(file =>
  zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").map(JSON.parse));

const readJsonl = file => fs.existsSync(file)
  ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];

// An isolated transcript chunk queue over scripts/lib/transcript-delta.
function chunkQueue(t, { scope, salt = "synthetic-salt", defaults = {} } = {}) {
  const queue = require(path.join(SCRIPTS, "lib", "transcript-delta"));
  const dir = tempDir("codex-chunks");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "rollout.jsonl");
  const root = path.join(dir, "queue");
  return {
    dir, source, root, queue,
    stage: opts => queue.stage(root, source, scope, salt, { ...defaults, ...opts }),
    observe: (enabled, stamp = "consent") => queue.observeConsent(root, source, scope, salt, enabled, stamp),
    records: gunzipRecords,
  };
}

const DEFAULT_CREDENTIALS = {
  device_id: "SYNTHETIC", hash_salt: "synthetic-salt",
  license_jwt: license(), refresh_token: "synthetic-refresh",
};

// Blocks network and shell access; records background spawns in TEST_SPAWNS.
const STRICT_PRELOAD = `
global.fetch = () => { throw Error("unexpected network"); };
const cp = require("child_process");
cp.execSync = () => { throw Error("unexpected shell"); };
cp.spawn = () => { require("fs").appendFileSync(process.env.TEST_SPAWNS, "spawn\\n"); return { pid: 999999, unref() {} }; };
`;

// A complete plugin environment for subprocess tests: HOME, state, data and one
// checkout, with a preload script injected into every spawned process.
function sandbox(t, { prefix = "codex-sandbox", credentials = DEFAULT_CREDENTIALS,
  remote = "https://github.com/acme/widgets.git", telemetry, preload = STRICT_PRELOAD, env: extraEnv = {} } = {}) {
  const root = tempDir(prefix);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  const state = path.join(root, ".skillbench");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\nurl = ${remote}\n`);
  if (telemetry !== undefined) writeSettings(repo, { telemetry });
  // Local ON no longer grants capture; the consent record does.
  const remoteRepo = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote || "");
  if (telemetry === true && remoteRepo) {
    grantConsent(state, `github.com/${remoteRepo[1].toLowerCase()}/${remoteRepo[2].toLowerCase()}`);
  }
  const credentialFile = path.join(state, "credentials.json");
  const sessionFile = sessionFileIn(state);
  const saveCredentials = patch => writeCredentials(root, { ...credentials, ...patch }, { stateDir: state });
  saveCredentials({});
  const preloadFile = path.join(root, "preload.cjs");
  fs.writeFileSync(preloadFile, preload);
  const env = {
    ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, ".codex"),
    // Codex also exports CLAUDE_PLUGIN_*; distinct paths keep a regression to
    // reading them visible.
    PLUGIN_ROOT, PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: path.join(root, "claude-root"), CLAUDE_PLUGIN_DATA: path.join(root, "claude-data"),
    SKILLMETER_STATE_DIR: state, SKILLMETER_REPO_SCOPE_ORGS: "", SKILLMETER_BACKEND_URL: "",
    SKILLMETER_ACTIVATE_URL: "", NODE_OPTIONS: "", TEST_SPAWNS: path.join(root, "spawns"), ...extraEnv,
  };
  function spawn(argv, { cwd = repo, input, env: overrides = {}, timeout = 5000 } = {}) {
    return spawnSync(process.execPath, ["--require", preloadFile, ...argv], {
      cwd, encoding: "utf8", timeout, env: { ...env, ...overrides },
      input: input === undefined ? undefined : typeof input === "string" ? input : JSON.stringify(input),
    });
  }
  const script = (name, { args = [], ...options } = {}) => spawn([path.join(SCRIPTS, name), ...args], options);
  return {
    root, repo, data, state, credentials, credentialFile, sessionFile, saveCredentials, env, preload: preloadFile, spawn, script,
    settings: path.join(repo, ".codex", "settings.local.json"),
    events: () => readJsonl(path.join(data, "logs", "events.jsonl")),
    spawned: () => fs.existsSync(path.join(root, "spawns")),
  };
}

module.exports = {
  PLUGIN_ROOT, SCRIPTS, FIXTURES, DEFAULT_CREDENTIALS, STRICT_PRELOAD,
  tempDir, makeJwt, license, sessionFileIn, consentPolicyFileIn, grantConsent, writeCredentials, isolateHome, writeSettings, makeRepo,
  transcriptLine, gunzipRecords, readJsonl, chunkQueue, sandbox,
};

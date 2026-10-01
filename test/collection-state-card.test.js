"use strict";

// ADR 003 decision 4: the SessionStart card is chosen from the collection
// state and names its reason. Each case builds the state through the real
// credstore and status record, runs the real SessionStart hook for the card,
// and the real capture hook for what is actually recorded, so a card's wording
// is checked against capture rather than against itself.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { makeJwt, makeTempDir, writeCredentials, writeFile, writeTelemetryPolicy } = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const ORG = "acme";
const REPO_KEY = `github.com/${ORG}/widgets`;
const license = (expiresInSec = 900) =>
  makeJwt({ exp: Math.floor(Date.now() / 1000) + expiresInSec, org: { login: ORG }, orgs: [ORG] });

// Run in the client's state, before the hooks. Helpers for the usual steps.
const SETUP = `
  const cs = require(${JSON.stringify(path.join(SCRIPTS, "credstore.js"))});
  const ls = require(${JSON.stringify(path.join(SCRIPTS, "lib/license-status.js"))});
  const signIn = (jwt) => { cs.markEngaged(); cs.commitSignin({ jwt, onCommit: () => ls.recordSignin() }); };
  const endSession = () => ls.recordTerminal({ source: "drain", reason: "reactivation_required", status: 410 });
  const revoke = () => cs.dropRevokedLicense(cs.recoverySnapshot(),
    () => ls.recordTerminal({ source: "drain", reason: "revoked", status: 402 }));
  const startSigninAndAbandon = () => { cs.markEngaged(); ls.clearLicenseStatus({ source: "signin" }); };
`;

function client({ policy = { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } }, setup = "", owner = ORG, cwdMissing = false }) {
  const root = makeTempDir("skm-card-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const repo = path.join(root, "widgets");
  // The working directory the hooks are given; one that no longer exists when
  // `cwdMissing`.
  const cwd = cwdMissing ? path.join(root, "gone") : repo;
  writeFile(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/${owner}/widgets.git\n`);
  writeCredentials(state, { device_id: "CARD-DEVICE", hash_salt: "0123456789abcdef0123456789abcdef" }, { dataDir: data });
  writeTelemetryPolicy(state, policy);
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
  const node = (args, options = {}) => {
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000, cwd: root, env, ...options });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  node(["-e", SETUP + setup]);

  const queuedEvents = () => {
    const queues = path.join(data, "logs", "repositories");
    if (!fs.existsSync(queues)) return 0;
    return fs.readdirSync(queues).flatMap((id) =>
      fs.readdirSync(path.join(queues, id))
        .filter((name) => /^events\.jsonl/.test(name))
        .map((name) => fs.readFileSync(path.join(queues, id, name), "utf8").split("\n").filter(Boolean).length)
    ).reduce((sum, count) => sum + count, 0);
  };

  return {
    state: () => JSON.parse(node(["-e", `
      const { readCollectionState } = require(${JSON.stringify(path.join(SCRIPTS, "lib/collection-state.js"))});
      process.stdout.write(JSON.stringify(readCollectionState({ cwd: ${JSON.stringify(cwd)} })));
    `])),
    card: () => JSON.parse(node([path.join(SCRIPTS, "session_start.js")], {
      input: JSON.stringify({ session_id: "card", cwd, source: "startup" }),
    }).trim().split("\n").pop()).systemMessage || "",
    records: () => {
      const before = queuedEvents();
      node([path.join(SCRIPTS, "hook.js"), "UserPromptSubmit"], {
        cwd: cwdMissing ? root : repo,
        input: JSON.stringify({ session_id: "card", cwd, prompt: "hello" }),
      });
      return queuedEvents() > before;
    },
  };
}

const title = (card) => (card.match(/\[ ([A-Z ]+) \]/) || [null, "no card"])[1];

const CASES = [
  { name: "never signed in", expect: ["never_signed_in", "ACTION REQUIRED", /Reason {8}not signed in/], unlike: /administrator/, records: false },
  { name: "signed out", setup: `signIn(${JSON.stringify(license())}); cs.signOut();`,
    expect: ["signed_out", "ACTION REQUIRED", /Reason {8}signed out/], unlike: /administrator/, records: false },
  { name: "signed out, then a sign-in started and abandoned",
    setup: `signIn(${JSON.stringify(license())}); cs.signOut(); startSigninAndAbandon();`,
    expect: ["token_missing", "ACTION REQUIRED", /Reason {8}license token missing/], unlike: /administrator/, records: false },
  { name: "revoked", setup: `signIn(${JSON.stringify(license())}); revoke();`,
    expect: ["revoked", "ACTION REQUIRED", /Reason {8}organization license inactive[\s\S]*Telemetry remains OFF\. Contact your administrator\./],
    unlike: /until you choose/, records: false },
  { name: "session ended, license stored", setup: `signIn(${JSON.stringify(license())}); endSession();`,
    expect: ["delivery_paused", "ACTION REQUIRED", /Sign-in expired\. Uploads are paused/], records: true },
  // The ended session is the reason whatever this repository's setting: the
  // card is about uploads, and makes no claim that this repository records.
  { name: "session ended, in a repository not chosen", policy: { orgs: { [ORG]: true } },
    setup: `signIn(${JSON.stringify(license())}); endSession();`,
    expect: ["delivery_paused", "ACTION REQUIRED", /Sign-in expired\. Uploads are paused/], records: false },
  { name: "paused", policy: { enabled: false, orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } },
    setup: `signIn(${JSON.stringify(license())});`,
    expect: ["paused", "TELEMETRY PAUSED", /\/skillmeter:telemetry enable-global/], records: false },
  { name: "paused, with an ended session", policy: { enabled: false, orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } },
    setup: `signIn(${JSON.stringify(license())}); endSession();`,
    expect: ["paused", "TELEMETRY PAUSED", /\/skillmeter:telemetry enable-global/], records: false },
  { name: "paused, signed out", policy: { enabled: false, orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } },
    setup: `signIn(${JSON.stringify(license())}); cs.signOut();`,
    expect: ["paused", "TELEMETRY PAUSED", /\/skillmeter:telemetry enable-global/], records: false },
  { name: "repository choice pending", policy: { orgs: { [ORG]: true } }, setup: `signIn(${JSON.stringify(license())});`,
    expect: ["unconfigured", "REPOSITORY SETUP", /full repository telemetry not selected/], records: false },
  { name: "organization choice pending", policy: {}, setup: `signIn(${JSON.stringify(license())});`,
    expect: ["unconfigured", "TELEMETRY SETUP", /nothing is being sent/], records: false },
  { name: "organization telemetry off", policy: { orgs: { [ORG]: false }, repositories: { [REPO_KEY]: true } },
    setup: `signIn(${JSON.stringify(license())});`, expect: ["unconfigured", "no card", /^$/], records: false },
  { name: "repository outside the licensed organization", owner: "someone-else", setup: `signIn(${JSON.stringify(license())});`,
    expect: ["unconfigured", "no card", /^$/], records: false },
  { name: "repository telemetry turned off", policy: { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: false } },
    setup: `signIn(${JSON.stringify(license())});`, expect: ["unconfigured", "no card", /^$/], records: false },
  { name: "no working directory", cwdMissing: true, setup: `signIn(${JSON.stringify(license())});`,
    expect: ["unconfigured", "no card", /^$/], records: false },
  { name: "recording", setup: `signIn(${JSON.stringify(license())});`,
    expect: ["recording", "TELEMETRY ON", /Sanitized telemetry is active/], records: true },
  { name: "recording on an expired license", setup: `signIn(${JSON.stringify(license(-3600))});`,
    expect: ["recording", "TELEMETRY ON", /Sanitized telemetry is active/], records: true },
];

for (const c of CASES) {
  test(`SessionStart card from the collection state: ${c.name}`, () => {
    const [state, cardTitle, body] = c.expect;
    const f = client(c);
    assert.equal(f.state().state, state);
    const card = f.card();
    assert.equal(title(card), cardTitle);
    assert.match(card, body);
    if (c.unlike) assert.doesNotMatch(card, c.unlike);
    const recorded = f.records();
    assert.equal(recorded, c.records, "what the capture hook actually does");
    // The card's wording must be true about capture. Only "off" and "on" claim
    // anything about it; "uploads are paused" is about delivery.
    if (/OFF|PAUSED/.test(card)) assert.equal(recorded, false, "a card that says off is shown only where nothing is recorded");
    if (/TELEMETRY ON/.test(card)) assert.equal(recorded, true, "a card that says on is shown only where something is recorded");
    if (state === "paused") assert.doesNotMatch(card, /\/skillmeter:signin/, "the pause is the reason, whatever else holds");
  });
}

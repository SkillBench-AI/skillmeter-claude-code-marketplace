"use strict";

// ADR 003 decision 1: one collection state from local files. It reports and
// never gates. Pure cases first, then the same states from real files, the way
// sign-in, sign-out, renewal and SessionStart leave them.
// Run: node --test test/collection-state.test.js

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  makeJwt,
  makeTempDir,
  sessionPath,
  setTestEnv,
  writeCredentials,
  writeFile,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const stateDir = makeTempDir("skm-collection-state-");
const home = makeTempDir("skm-collection-state-home-");
setTestEnv("SKILLMETER_STATE_DIR", stateDir);
setTestEnv("HOME", home);
setTestEnv("GIT_CONFIG_GLOBAL", "/dev/null");
setTestEnv("XDG_CONFIG_HOME", path.join(home, ".config"));

const credstore = require("../skillmeter/scripts/credstore");
const licenseStatus = require("../skillmeter/scripts/lib/license-status");
const {
  GROUPS,
  STATES,
  readCollectionState,
  resolveCollectionState,
  stateGroup,
} = require("../skillmeter/scripts/lib/collection-state");

const ORG = "acme";
const REPO_KEY = `github.com/${ORG}/widgets`;
const IDENTITY = { device_id: "COLLECTION-STATE-DEVICE", hash_salt: "0123456789abcdef0123456789abcdef" };

// A signed-in client with an ordinary status record and a capturing gate.
const HEALTHY = Object.freeze({
  globalDisabled: false,
  signedOut: false,
  hasLicense: true,
  status: { last_success_at: 1, last_outcome: "rotated", terminal: null },
  gate: { capture: true, mode: "project_enabled" },
});

function resolve(overrides) {
  return resolveCollectionState({ ...HEALTHY, ...overrides });
}

function license() {
  return makeJwt({ exp: Math.floor(Date.now() / 1000) + 900, org: { login: ORG }, orgs: [ORG] });
}

function checkout(owner) {
  const repo = makeTempDir("skm-collection-state-repo-");
  writeFile(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/${owner}/widgets.git\n`);
  return repo;
}

// --- pure: one case per state ------------------------------------------------

test("paused: the kill-switch is on", () => {
  assert.deepEqual(resolve({ globalDisabled: true }), { state: STATES.PAUSED, reason: "paused" });
});

test("signed_out: the user signed out", () => {
  assert.deepEqual(resolve({ signedOut: true, hasLicense: false }), { state: STATES.SIGNED_OUT, reason: "signed_out" });
});

test("revoked: the last refresh answered 402 and dropped the license", () => {
  const status = { last_success_at: 1, last_outcome: "terminal", terminal: { reason: "revoked" }, last_error: { kind: "revoked" } };
  assert.deepEqual(resolve({ hasLicense: false, status }), { state: STATES.REVOKED, reason: "revoked" });
});

test("token_missing: no license, and a sign-in was recorded here before", () => {
  const status = { last_success_at: 1, last_outcome: "signed_in", terminal: null };
  assert.deepEqual(resolve({ hasLicense: false, status }), { state: STATES.TOKEN_MISSING, reason: "token_missing" });
});

test("never_signed_in: no license and no sign-in ever recorded", () => {
  const status = { last_success_at: null, last_outcome: null, terminal: null };
  assert.deepEqual(resolve({ hasLicense: false, status }), { state: STATES.NEVER_SIGNED_IN, reason: "never_signed_in" });
});

test("delivery_paused: a license is stored but only a new sign-in can renew it", () => {
  const status = { last_success_at: 1, last_outcome: "terminal", terminal: { reason: "reactivation_required" } };
  assert.deepEqual(resolve({ status }), { state: STATES.DELIVERY_PAUSED, reason: "reactivation_required" });
});

test("unconfigured: signed in, and the gate does not capture here; the gate mode is the reason", () => {
  for (const mode of ["org_consent_required", "org_disabled", "project_disabled", "repository_consent_required", "out_of_scope", "cwd_unavailable"]) {
    assert.deepEqual(resolve({ gate: { capture: false, mode } }), { state: STATES.UNCONFIGURED, reason: mode });
  }
  assert.deepEqual(resolve({ gate: null }), { state: STATES.UNCONFIGURED, reason: "cwd_unavailable" },
    "without a repository context the client reads like a hook with no working directory");
});

test("recording: signed in, and the gate captures here", () => {
  assert.deepEqual(resolve({}), { state: STATES.RECORDING, reason: "project_enabled" });
});

// --- pure: order and edges ---------------------------------------------------

test("the kill-switch silences every other reading, and sign-out silences the rest", () => {
  const revoked = { last_outcome: "terminal", terminal: { reason: "revoked" } };
  assert.equal(resolve({ globalDisabled: true, signedOut: true, hasLicense: false, status: revoked }).state, STATES.PAUSED);
  assert.equal(resolve({ signedOut: true, hasLicense: false, status: revoked }).state, STATES.SIGNED_OUT);
});

test("revoked is read before a missing license, with or without evidence of a sign-in", () => {
  const status = { last_success_at: null, last_outcome: "terminal", terminal: { reason: "revoked" } };
  assert.equal(resolve({ hasLicense: false, status }).state, STATES.REVOKED);
  // A record from before a 402 dropped the license still reads as revoked.
  assert.equal(resolve({ hasLicense: true, status }).state, STATES.REVOKED);
});

test("a terminal reason whose `terminal` flag was cleared is still the last outcome", () => {
  // SessionStart, a started sign-in or another change of session clears the
  // flag; last_terminal_reason keeps the reason.
  const cleared = (reason) => ({ last_success_at: 1, last_outcome: null, terminal: null, last_terminal_reason: reason });
  assert.equal(resolve({ hasLicense: false, status: cleared("revoked") }).state, STATES.REVOKED);
  assert.equal(resolve({ status: cleared("reactivation_required") }).state, STATES.DELIVERY_PAUSED);
  // A completed sign-in or a successful renewal clears the reason.
  assert.equal(resolve({ status: { last_success_at: 2, last_outcome: "rotated", terminal: null, last_terminal_reason: null } }).state, STATES.RECORDING);
});

test("a backoff_exhausted record from an older version is not a pause", () => {
  const status = { last_success_at: 1, last_outcome: "terminal", terminal: { reason: "backoff_exhausted" } };
  assert.equal(resolve({ status }).state, STATES.RECORDING);
});

test("an expired license still records: freshness is not a state", () => {
  // The resolver never sees token freshness; a lapsed license waiting for its
  // next renewal reads the same as a fresh one.
  const status = { last_success_at: 1, last_outcome: "transient_failure", consecutive_failures: 3, terminal: null };
  assert.equal(resolve({ status }).state, STATES.RECORDING);
});

test("groups: capture stopped, delivery paused, and everything else", () => {
  for (const state of [STATES.SIGNED_OUT, STATES.TOKEN_MISSING, STATES.REVOKED]) {
    assert.equal(stateGroup(state), GROUPS.CAPTURE_STOPPED, state);
  }
  assert.equal(stateGroup(STATES.DELIVERY_PAUSED), GROUPS.DELIVERY_PAUSED);
  for (const state of [STATES.PAUSED, STATES.NEVER_SIGNED_IN, STATES.UNCONFIGURED, STATES.RECORDING]) {
    assert.equal(stateGroup(state), GROUPS.HEALTHY, state);
  }
});

// --- from files --------------------------------------------------------------

beforeEach(() => {
  writeCredentials(stateDir, IDENTITY);
  fs.rmSync(licenseStatus.LICENSE_STATUS_FILE, { force: true });
  writeTelemetryPolicy(stateDir, { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
});

function signIn() {
  credstore.markEngaged();
  credstore.commitSignin({ jwt: license(), onCommit: () => licenseStatus.recordSignin() });
}

test("files: a fresh install has never signed in", () => {
  assert.equal(readCollectionState().state, STATES.NEVER_SIGNED_IN);
});

test("files: a license that disappears after a sign-in is token_missing, not a fresh install", () => {
  signIn();
  assert.equal(readCollectionState().state, STATES.UNCONFIGURED);
  // Removed without a sign-out: a corrupt or deleted session file.
  writeFile(sessionPath(stateDir), JSON.stringify({ auth_generation: "unrelated" }));
  assert.equal(readCollectionState().state, STATES.TOKEN_MISSING);
});

test("files: sign-out, then a sign-in that is started and abandoned", () => {
  signIn();
  credstore.signOut();
  assert.equal(readCollectionState().state, STATES.SIGNED_OUT);
  // /skillmeter:signin starts a new intent and clears the record before the
  // browser flow. The sign-out stays until a sign-in commits, so an abandoned
  // sign-in leaves the user signed out, as they chose.
  credstore.markEngaged();
  licenseStatus.clearLicenseStatus({ source: "signin" });
  assert.equal(readCollectionState().state, STATES.SIGNED_OUT);
});

// Renewal waits for a drain with something to send, so an idle client usually
// holds an expired license. Presence decides, as it does for capture.
test("files: an expired stored license still reads as signed in", () => {
  const expired = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600, org: { login: ORG }, orgs: [ORG] });
  credstore.markEngaged();
  credstore.commitSignin({ jwt: expired, onCommit: () => licenseStatus.recordSignin() });
  assert.deepEqual(readCollectionState({ cwd: checkout(ORG) }), { state: STATES.RECORDING, reason: "project_enabled" });
  assert.equal(readCollectionState().state, STATES.UNCONFIGURED, "and without a directory");
});

// The kept reason outlives a sign-out and a sign-in that starts, so an ended
// session can lose its license. Nothing uploads without one either, so the
// missing license is what the state reports.
test("files: an ended session that then loses its license reads token_missing, not delivery_paused", () => {
  signIn();
  licenseStatus.recordTerminal({ source: "drain", reason: licenseStatus.TERMINAL_REASONS.REACTIVATION_REQUIRED, status: 400 });
  assert.equal(readCollectionState().state, STATES.DELIVERY_PAUSED);
  // The license removed without a sign-out: a corrupt or deleted session file.
  writeFile(sessionPath(stateDir), JSON.stringify({ auth_generation: "unrelated" }));
  assert.equal(licenseStatus.isSessionEnded(), true, "the reason is still kept");
  assert.equal(readCollectionState().state, STATES.TOKEN_MISSING);
});

test("files: a 402 reads as revoked, also after SessionStart cleared the terminal state", () => {
  signIn();
  const expected = credstore.recoverySnapshot();
  credstore.dropRevokedLicense(expected, () =>
    licenseStatus.recordTerminal({ source: "drain", reason: licenseStatus.TERMINAL_REASONS.REVOKED, status: 402 })
  );
  assert.equal(readCollectionState().state, STATES.REVOKED);
  licenseStatus.clearTerminal({ source: "session_start" });
  assert.equal(readCollectionState().state, STATES.REVOKED);
});

// signin.js in this client's state, with the broker approving and the license
// server answering `activateStatus`.
function signinAnswered(activateStatus) {
  const preload = path.join(home, "signin-preload.cjs");
  writeFile(preload, `
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    require("child_process").spawnSync = () => ({ status: 1 }); // no clipboard
    global.fetch = async (url) => {
      const target = String(url);
      let status = 200, payload;
      if (target.endsWith("/device/auth")) payload = { device_code: "dc", user_code: "ABCDEFGH", verification_uri: "https://fixture.invalid", expires_in: 600, interval: 0.001 };
      else if (target.endsWith("/oauth2/token")) payload = { id_token: "fixture-id", refresh_token: "fixture-refresh" };
      else if (target.endsWith("/activate")) { status = ${activateStatus}; payload = { code: "no_license" }; }
      else throw new Error("unexpected " + target);
      return { ok: status === 200, status, json: async () => payload, text: async () => JSON.stringify(payload) };
    };
  `);
  return spawnSync(process.execPath, ["-r", preload, path.join(__dirname, "../skillmeter/scripts/signin.js")], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: home,
    env: { ...process.env, SKILLMETER_BROKER_URL: "https://id.test", SKILLMETER_ACTIVATE_URL: "https://activation.test/activate" },
  });
}

test("files: a revoked client whose new sign-in is refused again stays revoked", () => {
  signIn();
  credstore.dropRevokedLicense(credstore.recoverySnapshot(), () =>
    licenseStatus.recordTerminal({ source: "drain", reason: licenseStatus.TERMINAL_REASONS.REVOKED, status: 402 })
  );
  licenseStatus.clearTerminal({ source: "session_start" });
  // The sign-in starts a new intent and clears the record, then /activate
  // answers 402 again.
  const retry = signinAnswered(402);
  assert.equal(retry.status, 1, retry.stderr);
  assert.match(retry.stdout, /No active SkillMeter license/);
  assert.equal(readCollectionState().state, STATES.REVOKED);
});

test("files: an ended broker session pauses delivery until a renewal succeeds", () => {
  signIn();
  licenseStatus.recordTerminal({ source: "drain", reason: licenseStatus.TERMINAL_REASONS.REACTIVATION_REQUIRED, status: 400 });
  assert.deepEqual(readCollectionState(), { state: STATES.DELIVERY_PAUSED, reason: "reactivation_required" });
  licenseStatus.clearTerminal({ source: "session_start" });
  assert.equal(readCollectionState().state, STATES.DELIVERY_PAUSED);
  licenseStatus.recordRefreshSuccess({ source: "drain" });
  assert.equal(readCollectionState().state, STATES.UNCONFIGURED);
});

test("files: the kill-switch reads as paused whatever the session holds", () => {
  writeTelemetryPolicy(stateDir, { enabled: false, orgs: { [ORG]: true } });
  assert.equal(readCollectionState().state, STATES.PAUSED);
  signIn();
  assert.equal(readCollectionState().state, STATES.PAUSED);
});

test("files: the current directory decides between recording and unconfigured", () => {
  signIn();
  assert.deepEqual(readCollectionState({ cwd: checkout(ORG) }), { state: STATES.RECORDING, reason: "project_enabled" });
  assert.deepEqual(readCollectionState({ cwd: checkout("someone-else") }), { state: STATES.UNCONFIGURED, reason: "out_of_scope" });
  writeTelemetryPolicy(stateDir, { orgs: { [ORG]: true } });
  assert.deepEqual(readCollectionState({ cwd: checkout(ORG) }), { state: STATES.UNCONFIGURED, reason: "repository_consent_required" });
  assert.deepEqual(readCollectionState({ cwd: path.join(home, "missing") }), { state: STATES.UNCONFIGURED, reason: "cwd_unavailable" });
});

test("files: a gate the caller already resolved is used as given", () => {
  signIn();
  assert.equal(readCollectionState({ gate: { capture: true, mode: "project_enabled" } }).state, STATES.RECORDING);
});

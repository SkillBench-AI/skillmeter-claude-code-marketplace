"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const plugin = path.resolve(__dirname, "../..");
const { license, writeCredentials, sessionFileIn, grantConsent } = require("../../test-support/plugin.cjs");

// `consent` writes acknowledged organization and repository ON to Codex's
// consent record; `choice` is the local setting, which can only restrict.
function status({ cutoverPending = false, terminal = null, seconds = 3600, credentials = {}, consent = true, choice = true, malformedChoice = false, queue = false, rejected = false, transcript = false, corrupt = false, blockedCapture = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-"));
  roots.push(root);
  const repo = path.join(root, "repo"), data = path.join(root, "data"), state = path.join(root, ".skillbench");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
  const token = license({ exp: Math.floor(Date.now() / 1000) + seconds });
  writeCredentials(root, { device_id: "synthetic-device", hash_salt: "synthetic-salt", license_jwt: token, refresh_token: "synthetic-refresh", ...credentials }, { stateDir: state });
  if (cutoverPending) {
    const file = sessionFileIn(state);
    const session = JSON.parse(fs.readFileSync(file));
    delete session.event_cutover;
    fs.writeFileSync(file, JSON.stringify(session));
  }
  if (consent) grantConsent(state, "github.com/acme/widgets");
  if (choice !== null || malformedChoice) {
    fs.mkdirSync(path.join(repo, ".codex"));
    fs.writeFileSync(path.join(repo, ".codex/settings.local.json"), malformedChoice ? "invalid json" : JSON.stringify({ skillmeter: { telemetry: choice } }));
  }
  if (terminal) {
    fs.writeFileSync(sessionFileIn(state), JSON.stringify({ event_cutover: 1, ...(terminal === "revoked" ? {} : { license_jwt: token, refresh_token: "synthetic-refresh" }), auth_generation: "g1" }));
    fs.writeFileSync(path.join(path.dirname(sessionFileIn(state)), "license-status.json"), JSON.stringify({ failures: 0, next_retry_at: null, terminal: { reason: terminal, at: 1 }, generation: "g1" }));
  }
  const logs = path.join(data, "logs");
  if (blockedCapture) {
    const dir = path.join(logs, "transcripts/chunks-v1", "b".repeat(64));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "capture-status.json"), JSON.stringify({ version: 1, phase: "capture", lastAttemptAt: "2026-01-01T00:00:00Z", activeFailure: { code: "oversized-single-record", at: "2026-01-01T00:00:00Z" }, ...(blockedCapture === "before-source" ? {} : { capturedBytes: 10, observedBytes: 100 }) }));
  }
  if (rejected) {
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, ".license-rejected"), "401\n");
  }
  if (transcript || corrupt) {
    const source = path.join(logs, "transcripts/chunks-v1", "a".repeat(64));
    const batch = path.join(source, "batch-1-abcd");
    fs.mkdirSync(batch, { recursive: true });
    fs.writeFileSync(path.join(source, "cursor.json"), corrupt ? "invalid json" : JSON.stringify({ baseline: 1 }));
    fs.writeFileSync(path.join(batch, "commit.json"), JSON.stringify({ cursor: { baseline: 1 }, chunks: [{ file: "chunk.gz" }] }));
    fs.writeFileSync(path.join(batch, "ready"), "1");
    fs.writeFileSync(path.join(batch, "chunk.gz"), "synthetic chunk");
  }
  if (queue) {
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, "events.jsonl.123"), "synthetic sealed event\n");
    fs.writeFileSync(path.join(logs, "events.jsonl"), "synthetic active event\n");
  }
  const preload = path.join(root, "preload.cjs");
  fs.writeFileSync(preload, `
global.fetch = () => { throw Error("status must not use network"); };
const cp = require("child_process");
cp.spawn = cp.execSync = () => { throw Error("status must not spawn processes"); };
`);
  const files = [path.join(state, "credentials.json"), sessionFileIn(state)];
  const before = files.map(file => fs.readFileSync(file, "utf8"));
  const result = spawnSync(process.execPath, ["--require", preload, path.join(plugin, "scripts/telemetry.js"), "status", "--details"], {
    cwd: repo, encoding: "utf8", timeout: 5000,
    env: { ...process.env, HOME: root, USERPROFILE: root, PLUGIN_DATA: data, PLUGIN_ROOT: plugin,
      SKILLMETER_STATE_DIR: state, SKILLMETER_REPO_SCOPE_ORGS: "", NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), before, "status must not modify credentials");
  return result.stderr;
}

test("expiry pauses delivery without claiming scoped capture stopped", () => {
  const text = status({ seconds: -60, queue: true });
  assert.match(text, /Capture policy: eligible/);
  assert.match(text, /Delivery authentication: paused; license expired, renewal due/);
  assert.match(text, /1 sealed event batch.*0 transcript chunks/);
  assert.match(text, /Unsealed event data: present/);
  assert.doesNotMatch(text, /all events dropped|successfully uploaded/);
});

test("near-expiry credentials distinguish renewal due from delivery pause", () => {
  const text = status({ seconds: 120 });
  assert.match(text, /Delivery authentication: renewal due/);
  assert.doesNotMatch(text, /license expired|all events dropped/);
});

test("healthy credentials and empty queues do not claim delivery or hook health", () => {
  const text = status();
  assert.match(text, /eligible.*hook execution not verified/);
  assert.match(text, /0 sealed event batches.*0 transcript chunks/);
  assert.match(text, /Last successful event upload: unknown/);
  assert.match(text, /Last transcript HTTP acknowledgment: unknown/);
  assert.match(text, /empty queue does not prove delivery/);
});

test("empty queue and valid credentials still expose a pre-staging capture failure", () => {
  const text = status({ blockedCapture: true });
  assert.match(text, /0 sealed event batches.*0 transcript chunks/);
  assert.match(text, /Transcript capture.*1 blocked, 1 behind/);
  assert.match(text, /oversized-single-record: 1/);
  assert.match(text, /Downstream analysis and report delivery: unknown/);
});

test("a failure before source inspection has no progress observation", () => {
  const text = status({ blockedCapture: "before-source" });
  assert.match(text, /1 blocked, 0 behind.*1 without progress observations/);
});

test("project opt-out is reported independently of valid authentication", () => {
  const text = status({ choice: false });
  assert.match(text, /Capture policy: disabled for this project/);
  assert.match(text, /Delivery authentication: license locally valid/);
});

// Sign-out ends this client's session only; it is not a global pause.
test("signed-out state does not use a leftover token to report delivery readiness", () => {
  const text = status({ credentials: { signed_out: true } });
  assert.match(text, /Capture policy: excluded \(not_activated\)/);
  assert.match(text, /Delivery authentication: signed out/);
});

test("missing credentials require sign-in", () => {
  const text = status({ credentials: { device_id: null, hash_salt: null, license_jwt: null, refresh_token: null } });
  assert.match(text, /Delivery authentication: not signed in; run \$skillmeter:signin/);
});

test("server rejection overrides a locally unexpired license", () => {
  assert.match(status({ rejected: true }), /Delivery authentication: paused; server rejected the license, renewal due/);
});

for (const [reason, expected] of [
  ["reactivation_required", /Delivery authentication: the sign-in session ended; run \$skillmeter:signin/],
  ["revoked", /Delivery authentication: the workspace no longer licenses you/],
]) test(`a terminal renewal (${reason}) asks for sign-in`, () => {
  assert.match(status({ terminal: reason }), expected);
});

test("status includes pending transcript chunks alongside event batches", () => {
  assert.match(status({ queue: true, transcript: true }), /1 sealed event batch, 1 transcript chunks/);
});

test("unreadable queue state is unavailable rather than empty", () => {
  const text = status({ corrupt: true });
  assert.match(text, /Upload queue: unavailable/);
  assert.doesNotMatch(text, /0 transcript chunks/);
});

for (const [name, options] of [
  ["missing", { consent: false }],
  ["malformed", { malformedChoice: true }],
  ["non-boolean", { choice: "true" }],
]) {
  test(`${name} repository choice does not report capture eligibility`, () => {
    const text = status(options);
    // A missing consent record is not granted by the local ON left in place.
    assert.match(text, name === "missing" ? /Capture policy: disabled; organization and repository consent required/ : /Capture policy: paused; invalid local consent settings/);
    assert.match(text, /Delivery authentication: license locally valid/);
    assert.doesNotMatch(text, /Capture policy: eligible/);
  });
}

test("a consent record grants capture without a local setting", () => {
  assert.match(status({ choice: null }), /Capture policy: eligible.*hook execution not verified/);
});

test("explicit consent does not override organization scope", () => {
  const text = status({ credentials: { license_jwt: license({ orgs: ["other-org"] }) } });
  assert.match(text, /Capture policy: excluded/);
  assert.doesNotMatch(text, /Capture policy: eligible/);
});


test("status reports incomplete cutover without modifying or silently adopting the session", () => {
  const text = status({ cutoverPending: true, queue: true });
  assert.match(text, /Delivery authentication: upgrade held; event queue cutover incomplete/);
  assert.doesNotMatch(text, /Delivery authentication: (license locally valid|not signed in)/);
});

"use strict";

// ADR 003 decision 7: each Claude Code session's collection state for its
// working directory, written for the display module (hooks/status.tsx). Each
// case drives the real hooks — SessionStart and the FileChanged handler — and
// reads back the file the module reads.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { ORG, REPO_KEY, collectionClient, license } = require("../testing/collection-client");

const signedIn = `signIn(${JSON.stringify(license())});`;

const statusFile = (f, id) => path.join(f.env.CLAUDE_PLUGIN_DATA, "session-status", `${id}.json`);
const status = (f, id) => JSON.parse(fs.readFileSync(statusFile(f, id), "utf8"));

test("SessionStart records collecting in an enabled repository", () => {
  const f = collectionClient();
  f.write(signedIn);
  f.sessionStart("s");
  assert.deepEqual(status(f, "s"), { schema: 1, state: "recording", reason: "project_enabled" });
});

test("SessionStart records why a signed-in session does not collect here", () => {
  const cases = [
    [{ orgs: {}, repositories: {} }, "org_consent_required"],
    [{ orgs: { [ORG]: false }, repositories: {} }, "org_disabled"],
    [{ orgs: { [ORG]: true }, repositories: {} }, "repository_consent_required"],
    [{ orgs: { [ORG]: true }, repositories: { [REPO_KEY]: false } }, "project_disabled"],
  ];
  for (const [policy, reason] of cases) {
    const f = collectionClient({ policy });
    f.write(signedIn);
    f.sessionStart("s");
    assert.deepEqual(status(f, "s"), { schema: 1, state: "unconfigured", reason }, reason);
  }
});

test("a directory outside any licensed organization reads as out of scope", () => {
  const f = collectionClient();
  f.write(signedIn);
  f.sessionStart("s", f.root);
  assert.deepEqual(status(f, "s"), { schema: 1, state: "unconfigured", reason: "out_of_scope" });
});

test("a client that never signed in records it", () => {
  const f = collectionClient();
  f.sessionStart("s");
  assert.equal(status(f, "s").state, "never_signed_in");
});

test("signing out moves the session's status before any capture hook runs", () => {
  const f = collectionClient();
  f.write(signedIn);
  f.sessionStart("s");
  f.write("signOut();");
  f.fire("s", "session.json");
  assert.deepEqual(status(f, "s"), { schema: 1, state: "signed_out", reason: "signed_out" });
});

test("an ended session reads as uploads paused, and a renewal returns it to collecting", () => {
  const f = collectionClient();
  f.write(signedIn);
  f.sessionStart("s");
  f.write("endSession();");
  f.fire("s", "license-status.json");
  assert.deepEqual(status(f, "s"), { schema: 1, state: "delivery_paused", reason: "reactivation_required" });
  f.write(`renew(${JSON.stringify(license())});`);
  f.fire("s", "license-status.json");
  assert.equal(status(f, "s").state, "recording");
});

test("each session keeps its own file", () => {
  const f = collectionClient();
  f.write(signedIn);
  f.sessionStart("in-repo");
  f.sessionStart("elsewhere", f.root);
  assert.equal(status(f, "in-repo").state, "recording");
  assert.equal(status(f, "elsewhere").reason, "out_of_scope");
});

test("an unchanged state is not rewritten", () => {
  const f = collectionClient();
  f.write(signedIn);
  f.sessionStart("s");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(statusFile(f, "s"), old, old);
  f.sessionStart("s");
  assert.equal(fs.statSync(statusFile(f, "s")).mtimeMs, old.getTime());
});

test("a session id that cannot name a file writes nothing", () => {
  const f = collectionClient();
  f.write(signedIn);
  f.sessionStart("../escape");
  assert.equal(fs.existsSync(path.join(f.env.CLAUDE_PLUGIN_DATA, "session-status")), false);
});

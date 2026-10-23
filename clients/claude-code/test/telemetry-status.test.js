"use strict";

// ADR 003 decision 6: /skillmeter:telemetry status shows the collection state
// with the same state names and reasons as the SessionStart card. Each case
// builds the state through the real writers and runs the real status command
// and card, so a reason that drifts in one place fails here.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ORG, REPO_KEY, collectionClient, license } = require("../testing/collection-client");

const SIGN_IN = "/skillmeter:signin";
const signedIn = `signIn(${JSON.stringify(license())});`;

// What the card shows for each reason, so the status line can be compared
// with it. Unconfigured has no reason on its card; the capture hook's skip
// line carries the gate's words instead.
const reasonLine = (card) => (card.match(/Reason {8}(.+?) +│/) || [])[1];
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const CASES = [
  { state: "never_signed_in", reason: "not signed in", next: SIGN_IN, effective: "disabled · not signed in",
    shown: (f, reason) => assert.equal(reasonLine(f.sessionStart()), reason) },
  { state: "signed_out", setup: `${signedIn} signOut();`, reason: "signed out", next: SIGN_IN, effective: "disabled · not signed in",
    shown: (f, reason) => assert.equal(reasonLine(f.sessionStart()), reason) },
  { state: "token_missing", setup: `${signedIn} loseLicense();`, reason: "license token missing", next: SIGN_IN,
    effective: "disabled · not signed in",
    shown: (f, reason) => assert.equal(reasonLine(f.sessionStart()), reason) },
  { state: "revoked", setup: `${signedIn} revoke();`, reason: "organization license inactive",
    next: `${SIGN_IN} · contact your administrator`, effective: "disabled · not signed in",
    shown: (f, reason) => assert.equal(reasonLine(f.sessionStart()), reason) },
  { state: "delivery_paused", setup: `${signedIn} endSession();`, reason: "sign-in expired", next: SIGN_IN,
    effective: "enabled · telemetry enabled for this repository",
    shown: (f, reason) => assert.ok(f.sessionStart().includes(`${sentence(reason)}. Uploads are paused`)) },
  { state: "paused", policy: { enabled: false, orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } }, setup: signedIn,
    reason: "paused for every repository", next: "/skillmeter:telemetry enable-global", effective: "disabled · telemetry globally disabled",
    shown: (f, reason) => assert.ok(f.sessionStart().includes(`OFF — ${reason}`)) },
  { state: "unconfigured", policy: { orgs: { [ORG]: true } }, setup: signedIn,
    reason: "repository telemetry choice required", next: "/skillmeter:telemetry list",
    effective: "disabled · repository telemetry choice required",
    shown: (f, reason) => assert.ok(f.hookStderr().includes(`skipped (${reason})`)) },
  { state: "recording", setup: signedIn, reason: "telemetry enabled for this repository", next: undefined,
    effective: "enabled · telemetry enabled for this repository" },
];

for (const c of CASES) {
  test(`/skillmeter:telemetry status: ${c.state}`, () => {
    const f = collectionClient({ policy: c.policy });
    if (c.setup) f.write(c.setup);
    const { text, lines } = f.status();
    assert.equal(lines.state, c.state);
    assert.equal(lines.reason, c.reason);
    assert.equal(lines.next, c.next);
    // The repository facts the state does not carry are still there.
    for (const label of ["global", "organization", "this project", "effective"]) {
      assert.ok(label in lines, `${label} line`);
    }
    assert.doesNotMatch(text, /license:|license expired/, "the old licence line and its vocabulary are gone");
    // The capture gate in the same words as the reason, not its identifier.
    assert.equal(lines.effective, c.effective);
    assert.doesNotMatch(lines.effective, /[()]/);
    if (c.shown) c.shown(f, lines.reason);
  });
}

test("/skillmeter:telemetry status: unconfigured names the gate's reason in words", () => {
  const f = collectionClient({ policy: { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: false } } });
  f.write(signedIn);
  const { lines } = f.status();
  assert.equal(lines.state, "unconfigured");
  assert.equal(lines.reason, "telemetry disabled for this project");
  assert.equal(lines.next, "/skillmeter:telemetry list");
  assert.equal(lines.effective, "disabled · telemetry disabled for this project");

  // Outside any repository there is nothing to choose, so no next command.
  const outside = f.status(f.root);
  assert.equal(outside.lines.state, "unconfigured");
  assert.equal(outside.lines.reason, "repository outside the licensed org");
  assert.equal(outside.lines.next, undefined);
  assert.equal(outside.lines.effective, "disabled · repository outside the licensed org");
});

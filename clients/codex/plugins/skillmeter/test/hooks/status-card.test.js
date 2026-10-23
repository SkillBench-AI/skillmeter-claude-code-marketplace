"use strict";
// The default status and consent results are short cards; details stay
// behind `status --details`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fixture } = require("../../../../test-support/consent-record.cjs");
const { statusBanner, consentSavedBanner } = require("../../scripts/lib/banner");

const widths = text => new Set(text.split("\n").filter(Boolean).map(line => [...line].length));

test("cards are boxes of one width", () => {
  const status = statusBanner({ capture: { state: "consent", text: "disabled; consent required" },
    repository: "acme/widgets", signIn: "OK", queue: "0 event batches · 0 transcript chunks pending" });
  const saved = consentSavedBanner({ kind: "organization", target: "@acme", enabled: true, revision: 1 });
  for (const text of [status, saved]) assert.equal(widths(text).size, 1, text);
  assert.match(status, /\[ CONSENT REQUIRED \][\s\S]*Reason +disabled; consent required/);
  assert.match(saved, /\[ ORGANIZATION ON \][\s\S]*→ Next: \$skillmeter:telemetry enable in the repository/);
});

test("status prints a short card and keeps diagnostics behind --details", t => {
  const f = fixture(t);
  f.run(`fs.writeFileSync(policyFile, JSON.stringify(policy));`);
  const card = f.cli(["status"]).stderr;
  assert.match(card, /\[ TELEMETRY ON \]/);
  assert.match(card, /Repository +acme\/widgets/);
  assert.doesNotMatch(card, /Reason|Capture policy:|Transcript diagnostics/);
  const details = f.cli(["status", "--details"]).stderr;
  assert.match(details, /Capture policy: eligible/);
});

test("status without consent names the reason and the next step", t => {
  const f = fixture(t);
  fs.rmSync(f.policyFile, { force: true });
  const card = f.cli(["status"]).stderr;
  assert.match(card, /\[ CONSENT REQUIRED \]/);
  assert.match(card, /Reason +disabled; organization and repository consent required/);
  assert.match(card, /→ Run \$skillmeter:signin to choose telemetry/);
});

// Cards printed right after sign-in: one status card per organization, then
// its repository review card.
const { signinBanner } = require("../../scripts/lib/banner");
const repo = (name, effective, extra = {}) => ({ key: `github.com/acme/${name}`, org: "acme",
  displayName: `@acme/${name}`, effective, localRestriction: false, ...extra });
const signin = (consent, repositories, { currentKey = "github.com/acme/widgets", globalPaused = false } = {}) =>
  signinBanner({ inventory: { orgs: [{ org: "acme", consent }], repositories, globalPaused }, currentKey });
const cards = text => text.split(/\n(?=╭)/).map(part => part.trim()).filter(Boolean);

for (const [name, text, title, status, next] of [
  ["no choice yet", signin(null, [repo("widgets", "off")]), "TELEMETRY SETUP", "OFF — nothing is being sent", "Choose below"],
  ["this repository ON", signin(true, [repo("widgets", "on")]), "TELEMETRY ON", "ON — sanitized telemetry is active here", "$skillmeter:telemetry list"],
  ["this repository OFF", signin(true, [repo("widgets", "off")]), "REPOSITORY OFF", "OFF — this repository is not on", "$skillmeter:telemetry enable"],
  ["local restriction", signin(true, [repo("widgets", "off", { localRestriction: true })]), "REPOSITORY OFF", "OFF — turned off in this checkout's local settings", "$skillmeter:telemetry unrestrict"],
  ["outside the organization's repositories", signin(true, [repo("gears", "on"), repo("widgets", "off")], { currentKey: null }), "ORGANIZATION ON", "ON for 1 of 2 local repositories", "$skillmeter:telemetry list"],
  ["organization OFF", signin(false, [repo("widgets", "off")]), "TELEMETRY OFF", "OFF — @acme is turned off", "$skillmeter:signin to turn it on"],
  ["paused", signin(true, [repo("widgets", "on")], { globalPaused: true }), "PAUSED", "OFF — Codex telemetry is paused on this machine", "$skillmeter:telemetry enable-global"],
]) {
  test(`sign-in status card: ${name}`, () => {
    const [statusCard, review] = cards(text);
    for (const part of [statusCard, review]) assert.equal(widths(part).size, 1, part);
    assert.ok(statusCard.includes(`[ ${title} ]`), statusCard);
    assert.ok(statusCard.includes("Sign-in       ✓ signed in"), statusCard);
    assert.ok(statusCard.includes(`Status        ${status}`), statusCard);
    assert.ok(statusCard.includes(`→ ${next}`), statusCard);
    assert.ok(review.includes("[ REPOSITORY REVIEW ]"), review);
  });
}

test("the repository review card lists every repository of the organization as ON or OFF", () => {
  const [, review] = cards(signin(true, [repo("gears", "on"), repo("widgets", "off")]));
  assert.match(review, /Telemetry ON +1/);
  assert.match(review, /Discovered +2/);
  assert.match(review, /✓ ON +@acme\/gears/);
  assert.match(review, /○ OFF +@acme\/widgets/);
  assert.match(cards(signin(null, []))[1], /No local organization repositories found\./);
});

test("sign-in without an organization or with an unreadable record says so", () => {
  const none = signinBanner({ inventory: { orgs: [], repositories: [], globalPaused: false } });
  assert.match(none, /\[ SIGNED IN \][\s\S]*No GitHub organization is connected/);
  assert.match(signinBanner({ error: "INVALID_POLICY" }), /consent record unavailable \(INVALID_POLICY\)[\s\S]*telemetry status/);
});

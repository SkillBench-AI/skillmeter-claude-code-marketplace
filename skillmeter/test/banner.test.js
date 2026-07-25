const assert = require("node:assert/strict");
const test = require("node:test");

const {
  signinStatusBanner,
  signInRequiredBanner,
  telemetryConsentRequiredBanner,
  telemetryActiveBanner,
} = require("../scripts/lib/banner");

function assertCard(value) {
  const lines = value.split("\n");
  assert.ok(lines.length >= 3);
  assert.match(lines[0], /^╭─ SkillMeter v/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.equal(new Set(lines.map((line) => [...line].length)).size, 1);
  assert.doesNotMatch(value, /\u001b/);
}

test("sign-in card makes the privacy default and next action explicit", () => {
  const value = signInRequiredBanner();

  assertCard(value);
  assert.match(value, /\[ ACTION REQUIRED \]/);
  assert.match(value, /Telemetry remains OFF until you choose/);
  assert.match(value, /→ \/skillmeter:signin/);
});

test("consent card identifies the organization and remains off by default", () => {
  const value = telemetryConsentRequiredBanner("skillbench-ai");

  assertCard(value);
  assert.match(value, /\[ TELEMETRY SETUP \]/);
  assert.match(value, /Organization  @skillbench-ai/);
  assert.match(value, /OFF — nothing is being sent/);
  assert.match(value, /→ \/skillmeter:signin to review/);
});

test("active card shows scope and the native picker entrypoint", () => {
  const value = telemetryActiveBanner("skillbench-ai");

  assertCard(value);
  assert.match(value, /\[ TELEMETRY ON \]/);
  assert.match(value, /Sanitized telemetry is active in this repository/);
  assert.match(value, /Manage        \/skillmeter:telemetry list/);
});

test("signed-in consent states reuse the matching cards", () => {
  assert.equal(
    signinStatusBanner("skillbench-ai", null),
    telemetryConsentRequiredBanner("skillbench-ai")
  );
  assert.equal(
    signinStatusBanner("skillbench-ai", true, true),
    telemetryActiveBanner("skillbench-ai")
  );

  const disabled = signinStatusBanner("skillbench-ai", false);
  assertCard(disabled);
  assert.match(disabled, /\[ TELEMETRY OFF \]/);
  assert.match(disabled, /No telemetry is being sent/);
});

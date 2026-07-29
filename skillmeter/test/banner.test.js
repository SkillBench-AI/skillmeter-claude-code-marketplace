require("../testing/bootstrap");

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  signinStatusBanner,
  signinRepositoryInventoryBanner,
  signInRequiredBanner,
  telemetryConsentRequiredBanner,
  telemetryRepositoryRequiredBanner,
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

test("unselected repository card stays off and names only the remote identity", () => {
  const value = telemetryRepositoryRequiredBanner(
    "skillbench-ai",
    "@skillbench-ai/example"
  );

  assertCard(value);
  assert.match(value, /\[ REPOSITORY SETUP \]/);
  assert.match(value, /Repository    @skillbench-ai\/example/);
  assert.match(value, /OFF — full repository telemetry not selected/);
  assert.match(value, /Excluded hooks send HMAC cwd only/);
  assert.match(value, /→ \/skillmeter:telemetry list/);
});

test("sign-in inventory lists every repository and its current effective state", () => {
  const value = signinRepositoryInventoryBanner("skillbench-ai", [
    {
      displayName: "@skillbench-ai/enabled",
      effective: "enabled",
    },
    {
      displayName: "@skillbench-ai/pending",
      effective: "disabled",
    },
  ]);

  assertCard(value);
  assert.match(value, /\[ REPOSITORY REVIEW \]/);
  assert.match(value, /Telemetry ON  1/);
  assert.match(value, /Discovered    2/);
  assert.match(value, /✓ ON   @skillbench-ai\/enabled/);
  assert.match(value, /○ OFF  @skillbench-ai\/pending/);
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
  const authorized = signinStatusBanner("skillbench-ai", true, false);
  assertCard(authorized);
  assert.match(authorized, /\[ REPOSITORY OFF \]/);
  assert.match(authorized, /Organization authorized/);
  assert.match(authorized, /No full repository telemetry is active here/);
  assert.match(authorized, /Excluded hooks send type, reason, and HMAC cwd/);

  const disabled = signinStatusBanner("skillbench-ai", false);
  assertCard(disabled);
  assert.match(disabled, /\[ TELEMETRY OFF \]/);
  assert.match(disabled, /No telemetry is being sent/);
});

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
  // The card opens with a newline so the renderer's "… says: " prefix cannot
  // indent the top border out of line with the rest of the box.
  assert.match(value, /^\n╭/);
  const lines = value.slice(1).split("\n");
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
  assert.match(value, /\bOFF\b/);
  assert.match(value, /→ \/skillmeter:signin/);
});

test("consent card identifies the organization and remains off by default", () => {
  const value = telemetryConsentRequiredBanner("skillbench-ai");

  assertCard(value);
  assert.match(value, /\[ TELEMETRY SETUP \]/);
  assert.match(value, /Organization\s+@skillbench-ai/);
  assert.match(value, /\bOFF\b/);
  assert.match(value, /→ \/skillmeter:signin to review/);
});

test("active card shows scope and the native picker entrypoint", () => {
  const value = telemetryActiveBanner("skillbench-ai");

  assertCard(value);
  assert.match(value, /\[ TELEMETRY ON \]/);
  assert.match(value, /Manage\s+\/skillmeter:telemetry list/);
});

test("unselected repository card stays off and names only the remote identity", () => {
  const value = telemetryRepositoryRequiredBanner(
    "skillbench-ai",
    "@skillbench-ai/example"
  );

  assertCard(value);
  assert.match(value, /\[ REPOSITORY SETUP \]/);
  assert.match(value, /Repository\s+@skillbench-ai\/example/);
  assert.match(value, /\bOFF\b/);
  assert.match(value, /HMAC cwd/);
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
  assert.match(value, /Telemetry ON\s+1\b/);
  assert.match(value, /Discovered\s+2\b/);
  assert.match(value, /✓ ON\s+@skillbench-ai\/enabled/);
  assert.match(value, /○ OFF\s+@skillbench-ai\/pending/);
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
  assert.match(authorized, /HMAC cwd/);

  const disabled = signinStatusBanner("skillbench-ai", false);
  assertCard(disabled);
  assert.match(disabled, /\[ TELEMETRY OFF \]/);
});

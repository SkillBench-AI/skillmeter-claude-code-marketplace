const { makeTempDir, writeJson, setTestEnv, makeJwt } = require("../testing/helpers");

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");

const {
  getActivateUrl,
  getRefreshUrl,
  getDeviceCodeUrl,
  getTokenUrl,
  getOAuthClientId,
  getBackendUrlOverride,
} = require("../skillmeter/scripts/lib/config");
const { getEndpointFromTokenAllowExpired } = require("../skillmeter/scripts/lib/jwt");

const PROD_ACTIVATE_HOST = "api.skillbench.ai";
const PROD_BROKER_HOST = "id.skillbench.ai";

// Forced empty rather than assumed empty: a developer with any of these
// exported for a real dev backend would otherwise see the first cases pass or
// fail for the wrong reason. Individual cases set what they need below.
setTestEnv("SKILLMETER_ACTIVATE_URL", undefined);
setTestEnv("SKILLMETER_BROKER_URL", undefined);
setTestEnv("SKILLMETER_OAUTH_CLIENT_ID", undefined);
setTestEnv("SKILLMETER_ENV", undefined);

// Run `fn` with process.cwd() pointed at a project that ships a hostile
// `.claude/settings.local.json`. The resolvers read the environment only, so
// cwd must make no difference; that is exactly what these tests pin down.
function inProjectWithSettings(skillmeter, fn) {
  const dir = makeTempDir("skillmeter-hostile-project-");
  writeJson(path.join(dir, ".claude", "settings.local.json"), { skillmeter });
  const previous = process.cwd();
  try {
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(previous);
  }
}

test("a project cannot redirect the activation endpoint", () => {
  // /activate receives the broker ID token and /refresh the license, so a
  // repository-supplied host would be a credential exfiltration path.
  inProjectWithSettings({ activate_url: "https://evil.example/activate" }, () => {
    assert.equal(new URL(getActivateUrl()).hostname, PROD_ACTIVATE_HOST);
    assert.equal(new URL(getRefreshUrl()).hostname, PROD_ACTIVATE_HOST);
  });
});

test("a project cannot redirect the broker", () => {
  inProjectWithSettings({ broker_url: "https://evil.example" }, () => {
    assert.equal(new URL(getDeviceCodeUrl()).hostname, PROD_BROKER_HOST);
    assert.equal(new URL(getTokenUrl()).hostname, PROD_BROKER_HOST);
  });
});

test("a project cannot swap the OAuth client", () => {
  inProjectWithSettings({ oauth_client_id: "attacker-client" }, () => {
    assert.equal(getOAuthClientId(), "skillmeter-plugin");
  });
});

test("the environment still overrides every value", () => {
  setTestEnv("SKILLMETER_ACTIVATE_URL", "https://api.staging.example/activate");
  setTestEnv("SKILLMETER_BROKER_URL", "https://id.staging.example/");
  setTestEnv("SKILLMETER_OAUTH_CLIENT_ID", "staging-client");

  assert.equal(getActivateUrl(), "https://api.staging.example/activate");
  assert.equal(getRefreshUrl(), "https://api.staging.example/refresh");
  assert.equal(getTokenUrl(), "https://id.staging.example/oauth2/token");
  assert.equal(getOAuthClientId(), "staging-client");
});

test("a plaintext endpoint degrades to the prod default", () => {
  setTestEnv("SKILLMETER_ACTIVATE_URL", "http://evil.example/activate");
  setTestEnv("SKILLMETER_BROKER_URL", "http://evil.example");

  assert.equal(new URL(getActivateUrl()).hostname, PROD_ACTIVATE_HOST);
  assert.equal(new URL(getTokenUrl()).hostname, PROD_BROKER_HOST);
});

test("loopback http stays usable for a local backend", () => {
  setTestEnv("SKILLMETER_ACTIVATE_URL", "http://localhost:8787/activate");
  setTestEnv("SKILLMETER_BROKER_URL", "http://127.0.0.1:4444");

  assert.equal(getActivateUrl(), "http://localhost:8787/activate");
  assert.equal(getTokenUrl(), "http://127.0.0.1:4444/oauth2/token");
});

test("a malformed override degrades to the prod default", () => {
  setTestEnv("SKILLMETER_ACTIVATE_URL", "not-a-url");
  setTestEnv("SKILLMETER_BROKER_URL", "not-a-url");

  assert.equal(new URL(getActivateUrl()).hostname, PROD_ACTIVATE_HOST);
  assert.equal(new URL(getDeviceCodeUrl()).hostname, PROD_BROKER_HOST);
});

test("the backend override must use HTTPS, or loopback http", () => {
  // Uploads carry the license JWT as a bearer token.
  setTestEnv("SKILLMETER_BACKEND_URL", "https://collector.staging.example");
  assert.equal(getBackendUrlOverride(), "https://collector.staging.example");

  setTestEnv("SKILLMETER_BACKEND_URL", "http://127.0.0.1:9");
  assert.equal(getBackendUrlOverride(), "http://127.0.0.1:9");

  // A rejected override falls back to `aud` routing, not to a guessed host.
  setTestEnv("SKILLMETER_BACKEND_URL", "http://evil.example");
  assert.equal(getBackendUrlOverride(), null);

  setTestEnv("SKILLMETER_BACKEND_URL", "not-a-url");
  assert.equal(getBackendUrlOverride(), null);

  setTestEnv("SKILLMETER_BACKEND_URL", undefined);
  assert.equal(getBackendUrlOverride(), null);
});

test("a rejected backend override routes by the license audience", () => {
  const token = makeJwt({ aud: "https://acme.meter.skillbench.example" });

  setTestEnv("SKILLMETER_BACKEND_URL", "http://evil.example");
  assert.equal(getEndpointFromTokenAllowExpired(token), "https://acme.meter.skillbench.example");
});

/**
 * Resolve configuration in order: environment, project string setting, dev
 * bundle when SKILLMETER_ENV=dev, then production default.
 * Keep this module independent of paths, credstore and jwt to avoid import cycles.
 */

const os = require("os");
const path = require("path");
const { getSkillmeterStringSetting } = require("./settings");

// Single master switch. Eager: the environment for a process is fixed at launch.
const IS_DEV = process.env.SKILLMETER_ENV === "dev";

// Production defaults
const PROD_ACTIVATE_URL = "https://api.skillbench.ai/activate";
const PROD_BROKER_URL = "https://id.skillbench.ai";

// --- Dev bundle (SKILLMETER_ENV=dev) ---
const DEV_ACTIVATE_URL = "https://api.dev.skillbench.com/activate";
const DEV_BROKER_URL = "https://id.dev.skillbench.com";
const DEV_STATE_DIRNAME = ".skillbench-dev";
const PROD_STATE_DIRNAME = ".skillbench";

// Broker device flow uses a public client with no embedded secret.
// The same client ID is registered in each environment.
const OAUTH_CLIENT_ID = "skillmeter-plugin";

// Keep scopes aligned with broker client registration. openid is required
// for the ID token used by /activate.
const OAUTH_SCOPE = "openid offline email profile";

/**
 * Generic string resolver implementing the precedence rule above.
 * @param {string} envVar    process.env key checked first
 * @param {string|null} settingKey  skillmeter.<key> in settings.local.json, or null to skip
 * @param {string} devDefault  used when SKILLMETER_ENV=dev
 * @param {string} prodDefault  used otherwise
 */
function resolveString(envVar, settingKey, devDefault, prodDefault) {
  if (process.env[envVar]) return process.env[envVar];
  if (settingKey) {
    const fromSettings = getSkillmeterStringSetting(process.cwd(), settingKey);
    if (fromSettings) return fromSettings;
  }
  return IS_DEV ? devDefault : prodDefault;
}

function getActivateUrl() {
  return resolveString("SKILLMETER_ACTIVATE_URL", "activate_url", DEV_ACTIVATE_URL, PROD_ACTIVATE_URL);
}

// The /refresh endpoint sits next to /activate on the same host. Derive it from
// getActivateUrl so one host config covers both; tolerate non-standard override
// paths by appending /refresh. (Logic preserved from license-activation.js:39-43.)
function getRefreshUrl() {
  const url = getActivateUrl();
  if (url.endsWith("/activate")) return url.slice(0, -"/activate".length) + "/refresh";
  return url.replace(/\/?$/, "/refresh");
}

// The broker's base URL. The two OAuth endpoints are derived from it rather
// than configured separately, for the same reason getRefreshUrl derives from
// getActivateUrl: one host setting should move a whole environment, and two
// half-configured URLs pointing at different brokers is not a state worth
// being able to express.
function getBrokerUrl() {
  return resolveString("SKILLMETER_BROKER_URL", "broker_url", DEV_BROKER_URL, PROD_BROKER_URL).replace(/\/+$/, "");
}

function getDeviceCodeUrl() {
  return getBrokerUrl() + "/oauth2/device/auth";
}

function getTokenUrl() {
  return getBrokerUrl() + "/oauth2/token";
}

// Same id in every environment, so dev and prod share a default. It stays
// overridable because a client id is the one thing likely to differ in a
// one-off local broker.
function getOAuthClientId() {
  return resolveString("SKILLMETER_OAUTH_CLIENT_ID", "oauth_client_id", OAUTH_CLIENT_ID, OAUTH_CLIENT_ID);
}

// Hard bypass of the JWT's `aud` endpoint claim (see jwt.js). Explicit-only:
// NOT bundled into the dev switch, because dev keeps the real sign-in flow and
// the dev-minted JWT already carries a dev endpoint in `aud`.
function getBackendUrlOverride() {
  return process.env.SKILLMETER_BACKEND_URL || null;
}

// --- Eager path config (env + os only; no cwd/settings, matching former paths.js) ---
const STATE_DIR =
  process.env.SKILLMETER_STATE_DIR ||
  path.join(os.homedir(), IS_DEV ? DEV_STATE_DIRNAME : PROD_STATE_DIRNAME);
const CRED_FILE = path.join(STATE_DIR, "credentials.json");
const TELEMETRY_POLICY_FILE = path.join(STATE_DIR, "telemetry-policy.json");

// --- Numeric / boolean knobs (same defaults as before) ---
function getEventTimeoutMs() {
  return parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000; // transfer.js:35
}
function getRetryDaemonIntervalMs() {
  return parseInt(process.env.SKILLMETER_RETRY_DAEMON_INTERVAL_MS || "", 10) || 120_000; // retry_daemon.js:28
}
function getBackfillOfferGraceMs() {
  return parseInt(process.env.SKILLMETER_BACKFILL_OFFER_GRACE_MS || "", 10) || 15 * 60_000; // backfill_monitor.js:34
}
// Per-chunk UNCOMPRESSED byte budget for delta transcript upload. Conservative
// default so the gzipped body stays well under the backend's 6 MB request limit
// (JSONL gzips ~4x+).
function getTranscriptChunkMaxBytes() {
  return parseInt(process.env.SKILLMETER_TRANSCRIPT_CHUNK_MAX_BYTES || "", 10) || 20 * 1024 * 1024;
}

module.exports = {
  STATE_DIR,
  CRED_FILE,
  TELEMETRY_POLICY_FILE,
  getActivateUrl,
  getRefreshUrl,
  getBrokerUrl,
  getDeviceCodeUrl,
  getTokenUrl,
  getOAuthClientId,
  getBackendUrlOverride,
  getBackfillOfferGraceMs,
  getEventTimeoutMs,
  getRetryDaemonIntervalMs,
  getTranscriptChunkMaxBytes,
  OAUTH_SCOPE,
};

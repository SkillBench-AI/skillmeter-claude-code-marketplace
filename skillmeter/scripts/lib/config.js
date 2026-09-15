/**
 * Central configuration resolver for the plugin.
 *
 * Every tunable URL / id / knob is resolved here through ONE precedence rule so
 * the "how do I point this at a dev environment" story lives in a single file
 * instead of being re-implemented in five modules.
 *
 * Precedence (per value):
 *   individual env var  >  settings.local.json string  >  dev-bundle default
 *   (only when SKILLMETER_ENV=dev)  >  prod default
 *
 * With no env set and SKILLMETER_ENV unset this collapses to the historical
 * chain (env > setting > prod default), so prod behavior is byte-identical.
 *
 * Layering: this is a LEAF module — it requires only os/path and ./settings
 * (itself an fs/path-only leaf). It must never require paths/credstore/jwt, so
 * paths.js can source STATE_DIR/CRED_FILE from here without a cycle.
 */

const os = require("os");
const path = require("path");
const { getSkillmeterStringSetting } = require("./settings");

// Single master switch. Eager: the environment for a process is fixed at launch.
const IS_DEV = process.env.SKILLMETER_ENV === "dev";

// --- Prod defaults (verbatim from their former homes) ---
const PROD_ACTIVATE_URL = "https://api.skillbench.ai/activate"; // was license-activation.js:25
const PROD_BROKER_URL = "https://id.skillbench.ai";

// --- Dev bundle (SKILLMETER_ENV=dev) ---
const DEV_ACTIVATE_URL = "https://api.dev.skillbench.com/activate";
const DEV_BROKER_URL = "https://id.dev.skillbench.com";
const DEV_STATE_DIRNAME = ".skillbench-dev";
const PROD_STATE_DIRNAME = ".skillbench";

// --- Broker device-flow constants ---
//
// Sign-in used to be a GitHub OAuth device flow. It is now the same RFC 8628
// flow against our own broker (Ory Hydra), which is where every other SkillBench
// sign-in already goes. What changes is only where the two URLs point, which
// client id is used, and which scope is asked for — the protocol is identical,
// down to the grant type string.
//
// The client is PUBLIC: no secret, because a program installed on a laptop
// cannot keep one. It is registered per environment by skillbench-infra's
// hydra-plugin-client unit under the same id in each, so unlike the GitHub
// OAuth Apps there is no second id to fill in. (The dev GitHub client id never
// was filled in, which is why dev sign-in has never worked.)
const OAUTH_CLIENT_ID = "skillmeter-plugin";

// Must not exceed what the client is registered with. The mutator registers
// exactly this string, so this is that string — not a guess at a subset.
// `openid` is the one that matters: it is what makes the broker return an
// id token, and the id token is what /activate verifies.
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
  getEventTimeoutMs,
  getRetryDaemonIntervalMs,
  getTranscriptChunkMaxBytes,
  OAUTH_SCOPE,
};

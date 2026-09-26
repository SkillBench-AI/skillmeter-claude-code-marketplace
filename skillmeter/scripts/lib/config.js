/**
 * Resolve configuration in order: environment, dev bundle when
 * SKILLMETER_ENV=dev, then production default.
 *
 * Only the environment can override an endpoint or the OAuth client. Project
 * files deliberately cannot: `.claude/settings.local.json` is cwd-scoped, so any
 * repository you open could otherwise send the activation and token requests,
 * which carry the broker ID token and refresh credentials, to a host it
 * controls, or swap the client the user authorizes. The environment is set by
 * the person at the keyboard, not by repository content.
 *
 * Keep this module independent of paths, credstore and jwt to avoid import cycles.
 */

const os = require("os");
const path = require("path");

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
 * @param {string} devDefault  used when SKILLMETER_ENV=dev
 * @param {string} prodDefault  used otherwise
 */
function resolveString(envVar, devDefault, prodDefault) {
  if (process.env[envVar]) return process.env[envVar];
  return IS_DEV ? devDefault : prodDefault;
}

/**
 * Defence in depth for endpoints that receive credentials: refuse a plaintext
 * or malformed override. Loopback stays exempt so a local backend remains a
 * one-env-var workflow. Never throws, since this runs inside hooks; a rejected
 * override degrades to the production endpoint with a stderr note.
 */
function trustedEndpoint(url, fallback, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    process.stderr.write(`[skillmeter] Ignoring malformed ${label} URL\n`);
    return fallback;
  }
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback)) {
    return url;
  }
  process.stderr.write(
    `[skillmeter] Ignoring non-HTTPS ${label} URL: ${parsed.host} (it receives credentials)\n`
  );
  return fallback;
}

function getActivateUrl() {
  return trustedEndpoint(
    resolveString("SKILLMETER_ACTIVATE_URL", DEV_ACTIVATE_URL, PROD_ACTIVATE_URL),
    PROD_ACTIVATE_URL,
    "activation"
  );
}

// The /refresh endpoint sits next to /activate on the same host. Derive it from
// getActivateUrl so one host config covers both; tolerate non-standard override
// paths by appending /refresh.
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
  return trustedEndpoint(
    resolveString("SKILLMETER_BROKER_URL", DEV_BROKER_URL, PROD_BROKER_URL),
    PROD_BROKER_URL,
    "broker"
  ).replace(/\/+$/, "");
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
  return resolveString("SKILLMETER_OAUTH_CLIENT_ID", OAUTH_CLIENT_ID, OAUTH_CLIENT_ID);
}

// Hard bypass of the JWT's `aud` endpoint claim (see jwt.js). Explicit-only:
// NOT bundled into the dev switch, because dev keeps the real sign-in flow and
// the dev-minted JWT already carries a dev endpoint in `aud`. Uploads send the
// license as a bearer token, so the override gets the same HTTPS rule as the
// sign-in endpoints; a rejected one falls back to `aud` routing (null).
function getBackendUrlOverride() {
  const url = process.env.SKILLMETER_BACKEND_URL;
  if (!url) return null;
  return trustedEndpoint(url, null, "backend");
}

// --- Eager path config (env + os only, matching former paths.js) ---
const STATE_DIR =
  process.env.SKILLMETER_STATE_DIR ||
  path.join(os.homedir(), IS_DEV ? DEV_STATE_DIRNAME : PROD_STATE_DIRNAME);
const CRED_FILE = path.join(STATE_DIR, "credentials.json");
const TELEMETRY_POLICY_FILE = path.join(STATE_DIR, "telemetry-policy.json");

// --- Numeric / boolean knobs ---
function getEventTimeoutMs() {
  return parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
}
function getRetryDaemonIntervalMs() {
  return parseInt(process.env.SKILLMETER_RETRY_DAEMON_INTERVAL_MS || "", 10) || 120_000;
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
  getDeviceCodeUrl,
  getTokenUrl,
  getOAuthClientId,
  getBackendUrlOverride,
  getEventTimeoutMs,
  getRetryDaemonIntervalMs,
  getTranscriptChunkMaxBytes,
  OAUTH_SCOPE,
};

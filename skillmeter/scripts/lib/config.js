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
const PROD_GITHUB_CLIENT_ID = "Ov23liHsxZ4tVUN5WePE"; // was signin.js:48

// --- Dev bundle (SKILLMETER_ENV=dev) ---
// Two values the maintainer must confirm/fill. They are intentionally chosen so
// an unfilled dev run fails LOUDLY (bad client id / unreachable host) and never
// silently falls back to prod. Individual env vars still override these.
const DEV_ACTIVATE_URL = "https://api.dev.skillbench.com/activate"; // TODO: confirm exact dev host
const DEV_GITHUB_CLIENT_ID = "__FILL_DEV_OAUTH_CLIENT_ID__"; // TODO: set the dev GitHub OAuth App id
const DEV_STATE_DIRNAME = ".skillbench-dev";
const PROD_STATE_DIRNAME = ".skillbench";

// --- GitHub OAuth / API constants (moved here from signin.js / github-api.js) ---
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"; // signin.js:56
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"; // signin.js:57
const GITHUB_OAUTH_SCOPE = "read:user read:org"; // signin.js:58
const GITHUB_API_USER_URL = "https://api.github.com/user"; // github-api.js:23
const GITHUB_API_ORGS_URL = "https://api.github.com/user/orgs?per_page=100"; // github-api.js:33

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

function getGitHubClientId() {
  return resolveString(
    "SKILLMETER_GITHUB_CLIENT_ID",
    "github_client_id",
    DEV_GITHUB_CLIENT_ID,
    PROD_GITHUB_CLIENT_ID
  );
}

// Hard bypass of the JWT's telemetry_endpoint claim (see jwt.js). Explicit-only:
// NOT bundled into the dev switch, because dev keeps the real sign-in flow and
// the dev-minted JWT already carries a dev telemetry_endpoint.
function getBackendUrlOverride() {
  return process.env.SKILLMETER_BACKEND_URL || null;
}

// --- Eager path config (env + os only; no cwd/settings, matching former paths.js) ---
const STATE_DIR =
  process.env.SKILLMETER_STATE_DIR ||
  path.join(os.homedir(), IS_DEV ? DEV_STATE_DIRNAME : PROD_STATE_DIRNAME);
const CRED_FILE = path.join(STATE_DIR, "credentials.json");

// --- Numeric / boolean knobs (same defaults as before) ---
function getEventTimeoutMs() {
  return parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000; // transfer.js:35
}
function getRetryDaemonIntervalMs() {
  return parseInt(process.env.SKILLMETER_RETRY_DAEMON_INTERVAL_MS || "", 10) || 120_000; // retry_daemon.js:28
}
function isColorEnabled() {
  return !process.env.NO_COLOR; // banner.js:45
}

module.exports = {
  IS_DEV,
  STATE_DIR,
  CRED_FILE,
  getActivateUrl,
  getRefreshUrl,
  getGitHubClientId,
  getBackendUrlOverride,
  getEventTimeoutMs,
  getRetryDaemonIntervalMs,
  isColorEnabled,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_OAUTH_SCOPE,
  GITHUB_API_USER_URL,
  GITHUB_API_ORGS_URL,
};

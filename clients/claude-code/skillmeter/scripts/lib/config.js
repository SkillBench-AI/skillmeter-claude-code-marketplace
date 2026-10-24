/**
 * The installation's channel picks the environment: `channel.json` at the plugin
 * root exists only in the internal channel build and selects dev; without it the
 * stable build uses prod. Nothing at runtime switches the environment. An
 * environment variable can still point one endpoint, the OAuth client or the
 * state directory elsewhere, for a local stack or isolated tests.
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
// Environments, channel, OAuth client and endpoint trust are shared with the
// Codex client (shared/lib/endpoints.js).
const {
  ENVIRONMENTS,
  CHANNEL_FILE,
  readChannel,
  oauthClientId,
  OAUTH_SCOPE,
  trustedEndpoint,
} = require("./endpoints");

const CHANNEL = readChannel();
// Eager: fixed by the installation for the life of the process.
const DEFAULTS = ENVIRONMENTS[CHANNEL.env];

/**
 * An explicit override from the environment, else the channel's default.
 * @param {string} envVar    process.env key checked first
 * @param {string} fallback  the channel environment's default
 */
function resolveString(envVar, fallback) {
  return process.env[envVar] || fallback;
}

function getActivateUrl() {
  return trustedEndpoint(
    resolveString("SKILLMETER_ACTIVATE_URL", DEFAULTS.activate),
    DEFAULTS.activate,
    "activation"
  );
}

// The broker's base URL. The two OAuth endpoints are derived from it rather
// than configured separately: one host setting should move a whole
// environment, and two half-configured URLs pointing at different brokers is
// not a state worth being able to express.
function getBrokerUrl() {
  return trustedEndpoint(
    resolveString("SKILLMETER_BROKER_URL", DEFAULTS.broker),
    DEFAULTS.broker,
    "broker"
  ).replace(/\/+$/, "");
}

function getDeviceCodeUrl() {
  return getBrokerUrl() + "/oauth2/device/auth";
}

function getTokenUrl() {
  return getBrokerUrl() + "/oauth2/token";
}

// RFC 7009. Sign-out revokes this client's refresh token here (ADR 005).
function getRevokeUrl() {
  return getBrokerUrl() + "/oauth2/revoke";
}

// Same id in every environment, so dev and prod share a default. It stays
// overridable because a client id is the one thing likely to differ in a
// one-off local broker.
function getOAuthClientId() {
  return oauthClientId();
}

// Hard bypass of the JWT's `aud` endpoint claim (see transfer.js). Explicit-only:
// NOT bundled into the dev switch, because dev keeps the real sign-in flow and
// the dev-minted JWT already carries a dev endpoint in `aud`. Uploads send the
// license as a bearer token, so the override gets the same HTTPS rule as the
// sign-in endpoints; a rejected one falls back to `aud` routing (null).
function getBackendUrlOverride() {
  const url = process.env.SKILLMETER_BACKEND_URL;
  if (!url) return null;
  return trustedEndpoint(url, null, "backend");
}

// What the user runs to sign in again, quoted by the shared broker.
const SIGNIN_COMMAND = "/skillmeter:signin";

// --- Eager path config (env + os only, matching former paths.js) ---
const STATE_DIR =
  process.env.SKILLMETER_STATE_DIR ||
  path.join(os.homedir(), DEFAULTS.state);
const CRED_FILE = path.join(STATE_DIR, "credentials.json");
const TELEMETRY_POLICY_FILE = path.join(STATE_DIR, "telemetry-policy.json");

// --- Numeric / boolean knobs ---
function getEventTimeoutMs() {
  return parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000;
}
// Base delay of the license refresh backoff.
function getRetryBaseMs() {
  return parseInt(process.env.SKILLMETER_RETRY_BASE_MS || "", 10) || 120_000;
}
// Per-chunk UNCOMPRESSED byte budget for delta transcript upload. Conservative
// default so the gzipped body stays well under the backend's 6 MB request limit
// (JSONL gzips ~4x+).
function getTranscriptChunkMaxBytes() {
  return parseInt(process.env.SKILLMETER_TRANSCRIPT_CHUNK_MAX_BYTES || "", 10) || 20 * 1024 * 1024;
}

module.exports = {
  CHANNEL_FILE,
  CHANNEL,
  readChannel,
  STATE_DIR,
  CRED_FILE,
  TELEMETRY_POLICY_FILE,
  getActivateUrl,
  getDeviceCodeUrl,
  getTokenUrl,
  getRevokeUrl,
  getOAuthClientId,
  getBackendUrlOverride,
  getEventTimeoutMs,
  getRetryBaseMs,
  getTranscriptChunkMaxBytes,
  OAUTH_SCOPE,
  SIGNIN_COMMAND,
};

"use strict";

/**
 * Where this plugin keeps state and which services it signs in against.
 *
 * The installation's channel picks the environment, which sets the broker, the
 * license server and the state directory together: `channel.json` at the plugin
 * root exists only in the internal channel build and selects dev; without it the
 * stable build uses prod. SKILLMETER_STATE_DIR,
 * SKILLMETER_BROKER_URL and SKILLMETER_ACTIVATE_URL override one each. Project
 * settings files cannot redirect credentials: a repository you open must not
 * be able to send your sign-in to another host.
 *
 * Resolved on every call, so a process (or a test) that changes its
 * environment sees the change.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ENVIRONMENTS = {
  prod: { broker: "https://id.skillbench.ai", activate: "https://api.skillbench.ai/activate", state: ".skillbench" },
  dev: { broker: "https://id.dev.skillbench.com", activate: "https://api.dev.skillbench.com/activate", state: ".skillbench-dev" },
};

// The public device client every SkillMeter client signs in through. Each
// device grant starts its own refresh chain, so clients' sessions stay apart.
const OAUTH_CLIENT_ID = "skillmeter-plugin";
// `openid` for the ID token /activate verifies; `offline` for the refresh token.
const OAUTH_SCOPE = "openid offline";

const CHANNEL_FILE = path.join(__dirname, "..", "..", "channel.json");

// The release channel this installation was built for. Only the exact shape
// the internal build writes is honoured; anything else is the stable channel.
function channel(file = CHANNEL_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value && typeof value.channel === "string" && /^[a-z]+$/.test(value.channel) && Object.hasOwn(ENVIRONMENTS, value.env)) {
      return { channel: value.channel, env: value.env };
    }
  } catch {}
  return { channel: "stable", env: "prod" };
}

const defaults = () => ENVIRONMENTS[channel().env];

// Credentials go only to HTTPS on skillbench.ai or skillbench.com, or to
// loopback for a local stack. An override that fails the check is ignored with
// a note and the environment's default is used.
function trustedEndpoint(value, fallback, label) {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const skillbench = /(^|\.)skillbench\.(ai|com)$/.test(url.hostname);
    if ((url.protocol === "https:" && skillbench) || (loopback && ["http:", "https:"].includes(url.protocol))) {
      return value.replace(/\/+$/, "");
    }
  } catch {}
  console.error(`[skillmeter] ${label} override rejected (untrusted endpoint), using the default`);
  return fallback;
}

function stateDir() {
  return process.env.SKILLMETER_STATE_DIR || path.join(os.homedir(), defaults().state);
}

// Shared with every SkillMeter client on the machine: the device identity only.
const credentialsFile = () => path.join(stateDir(), "credentials.json");
// This plugin's own session (ADR 005): license, refresh token, sign-in intent.
const sessionDir = () => path.join(stateDir(), "clients", "codex");
const sessionFile = () => path.join(sessionDir(), "session.json");

const brokerUrl = () => trustedEndpoint(process.env.SKILLMETER_BROKER_URL, defaults().broker, "broker");
const activateUrl = () => trustedEndpoint(process.env.SKILLMETER_ACTIVATE_URL, defaults().activate, "activation");

module.exports = {
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  CHANNEL_FILE,
  channel,
  stateDir,
  credentialsFile,
  sessionDir,
  sessionFile,
  brokerUrl,
  activateUrl,
  deviceCodeUrl: () => `${brokerUrl()}/oauth2/device/auth`,
  tokenUrl: () => `${brokerUrl()}/oauth2/token`,
  revokeUrl: () => `${brokerUrl()}/oauth2/revoke`,
  trustedEndpoint,
};

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

const os = require("os");
const path = require("path");
// Environments, channel, OAuth client and endpoint trust are shared with the
// Claude Code client (shared/lib/endpoints.js).
const {
  ENVIRONMENTS,
  CHANNEL_FILE,
  readChannel: channel,
  OAUTH_CLIENT_ID,
  oauthClientId,
  OAUTH_SCOPE,
  trustedEndpoint,
} = require("./endpoints");

const defaults = () => ENVIRONMENTS[channel().env];

function stateDir() {
  return process.env.SKILLMETER_STATE_DIR || path.join(os.homedir(), defaults().state);
}

// Shared with every SkillMeter client on the machine: the device identity only.
const credentialsFile = () => path.join(stateDir(), "credentials.json");
// This plugin's own session (ADR 005): license, refresh token, sign-in intent.
const sessionDir = () => path.join(stateDir(), "clients", "codex");
const sessionFile = () => path.join(sessionDir(), "session.json");

// What the user runs to sign in again, quoted by the shared broker.
const SIGNIN_COMMAND = "$skillmeter:signin";

const brokerUrl = () => trustedEndpoint(process.env.SKILLMETER_BROKER_URL, defaults().broker, "broker");
const activateUrl = () => trustedEndpoint(process.env.SKILLMETER_ACTIVATE_URL, defaults().activate, "activation");

module.exports = {
  OAUTH_CLIENT_ID,
  oauthClientId,
  OAUTH_SCOPE,
  CHANNEL_FILE,
  channel,
  stateDir,
  credentialsFile,
  sessionDir,
  sessionFile,
  brokerUrl,
  activateUrl,
  SIGNIN_COMMAND,
  // The names the shared broker and license-exchange modules use.
  getActivateUrl: () => activateUrl(),
  getDeviceCodeUrl: () => `${brokerUrl()}/oauth2/device/auth`,
  getTokenUrl: () => `${brokerUrl()}/oauth2/token`,
  getRevokeUrl: () => `${brokerUrl()}/oauth2/revoke`,
  getOAuthClientId: () => oauthClientId(),
  trustedEndpoint,
};

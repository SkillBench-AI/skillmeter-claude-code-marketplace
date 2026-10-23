// GENERATED from shared/lib/endpoints.js by scripts/sync-shared.mjs. Edit that file, not this copy.
"use strict";

/**
 * Which services a SkillMeter client signs in against, and which hosts may
 * receive its credentials.
 *
 * The installation's channel picks the environment: `channel.json` at the
 * plugin root exists only in the internal channel build and selects dev;
 * without it the stable build uses prod. Each client lets the environment
 * (SKILLMETER_BROKER_URL, SKILLMETER_ACTIVATE_URL, SKILLMETER_BACKEND_URL)
 * point one endpoint elsewhere, for a local stack or isolated tests, but only
 * to a host trustedEndpoint accepts. Project files cannot: a repository you
 * open must not be able to send your sign-in to another host.
 */

const fs = require("fs");
const path = require("path");

const ENVIRONMENTS = {
  prod: { broker: "https://id.skillbench.ai", activate: "https://api.skillbench.ai/activate", state: ".skillbench" },
  dev: { broker: "https://id.dev.skillbench.com", activate: "https://api.dev.skillbench.com/activate", state: ".skillbench-dev" },
};

const CHANNEL_FILE = path.join(__dirname, "..", "..", "channel.json");

// The release channel this installation was built for. Only the exact shape
// the internal build writes is honoured; anything else is the stable channel.
function readChannel(file = CHANNEL_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value && typeof value.channel === "string" && /^[a-z]+$/.test(value.channel) &&
        Object.hasOwn(ENVIRONMENTS, value.env)) {
      return { channel: value.channel, env: value.env };
    }
  } catch {}
  return { channel: "stable", env: "prod" };
}

// The public device client every SkillMeter client signs in through, with no
// embedded secret. Each device grant starts its own refresh chain, so the
// clients' sessions stay apart (ADR 005).
const OAUTH_CLIENT_ID = "skillmeter-plugin";
// The environment can name another client for a one-off local broker, whose
// registration may differ. Like the endpoint overrides, never project files:
// a repository must not be able to swap the client the user authorizes.
function oauthClientId() {
  return process.env.SKILLMETER_OAUTH_CLIENT_ID || OAUTH_CLIENT_ID;
}
// `openid` for the ID token /activate verifies, `offline` for the refresh
// token, `email` for the address /activate records with the license.
const OAUTH_SCOPE = "openid offline email";

// Credentials go only to HTTPS on skillbench.ai or skillbench.com, or to
// loopback for a local stack. Never throws, since this runs inside hooks: an
// override that fails the check is ignored with a note and `fallback` is used.
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

module.exports = { ENVIRONMENTS, CHANNEL_FILE, readChannel, OAUTH_CLIENT_ID, oauthClientId, OAUTH_SCOPE, trustedEndpoint };

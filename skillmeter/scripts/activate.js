#!/usr/bin/env node
/**
 * Interactive activation flow for the SkillMeter plugin.
 *
 * Mirrors the VS Code extension's AuthService:
 *   1. Try silent activation using `gh auth token` when the GitHub CLI is
 *      already logged in.
 *   2. Otherwise fall back to the GitHub OAuth device flow — print a URL
 *      and a user code, poll the token endpoint until the user approves.
 *   3. POST the resulting GitHub access token + device_id to the SkillMeter
 *      activation endpoint; store the returned license JWT in credstore.
 */

const credstore = require("./credstore.js");
const path = require("path");

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const LOG_DIR = path.join(PLUGIN_ROOT, "logs");

// GitHub OAuth App client_id — same SkillMeter app the VS Code extension uses.
const CLIENT_ID = process.env.SKILLMETER_GITHUB_CLIENT_ID || "Ov23ct86rS80kpl7o2Xg";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPE = "read:user read:org";

function log(msg) {
  process.stderr.write(msg + "\n");
}

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function requestDeviceCode() {
  return postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE });
}

async function pollForToken(deviceCode, initialInterval) {
  let interval = initialInterval;
  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const payload = await postForm(TOKEN_URL, {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (payload.access_token) return payload.access_token;

    switch (payload.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "expired_token":
        throw new Error("The device code expired. Run /sk-activate again.");
      case "access_denied":
        throw new Error("Access was denied on GitHub. Aborting.");
      default:
        throw new Error(`GitHub returned: ${payload.error || "unknown error"}`);
    }
  }
}

async function exchangeForLicense(githubToken, deviceId) {
  const res = await fetch(credstore.ACTIVATE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${githubToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_id: deviceId }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 402) {
    throw new Error("No active SkillMeter license found for your GitHub organizations.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Activation failed (HTTP ${res.status}): ${text}`);
  }

  const payload = await res.json();
  if (!payload?.token) throw new Error("Activation response missing token.");
  return payload.token;
}

async function main() {
  const existingToken = credstore.getLicenseToken(LOG_DIR);
  if (existingToken && !credstore.isLicenseTokenExpired(existingToken)) {
    log("SkillMeter is already activated.");
    return;
  }
  if (existingToken) {
    log("License expired or near expiry — refreshing...");
    // Do NOT pre-clear: if the refresh below fails, the stale token
    // is strictly more useful than none (telemetry still flows via
    // the auth-optional path). A successful silent/device flow will
    // overwrite it via credstore.setLicenseToken.
  }

  const deviceId = credstore.getDeviceId(LOG_DIR);
  if (!deviceId) {
    log("Activation failed: unable to determine device ID.");
    process.exit(1);
  }

  const silentJwt = await credstore.trySilentGhActivate(deviceId);
  if (silentJwt) {
    log("Activated via gh CLI.");
    return;
  }

  log("Starting GitHub device flow...");
  const device = await requestDeviceCode();

  log("");
  log(`Open ${device.verification_uri}`);
  log(`Enter code: ${device.user_code}`);
  log(`(code expires in ${Math.round(device.expires_in / 60)} minutes)`);
  log("");
  log("Waiting for GitHub approval...");

  const githubToken = await pollForToken(device.device_code, device.interval || 5);
  log("GitHub approval received. Exchanging for SkillMeter license...");

  const licenseJwt = await exchangeForLicense(githubToken, deviceId);
  credstore.setLicenseToken(licenseJwt);
  credstore.setGhFallbackRetryAfter(0);
  log("SkillMeter activated.");
}

main().catch((err) => {
  log(`Activation failed: ${err.message}`);
  process.exit(1);
});

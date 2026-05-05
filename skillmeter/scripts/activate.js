#!/usr/bin/env node
/**
 * Interactive activation flow for the SkillMeter plugin.
 *
 *   1. Try silent activation using `gh auth token` when the GitHub CLI is
 *      already logged in.
 *   2. Otherwise start the GitHub OAuth device flow: print the verification
 *      URL and user code to stdout, then hand off polling to a detached
 *      child process. The foreground exits immediately so the user sees
 *      the code right away — Claude Code's `!`-prefix runner displays
 *      captured output once the command returns, so we cannot block on
 *      polling in the foreground.
 *   3. The background child polls for the GitHub access token, POSTs it +
 *      device_id to the SkillMeter activation endpoint, fetches the user's
 *      GitHub identities, and stores the license JWT + orgs in credstore.
 *      The user re-runs `/skillmeter:activate` (or any telemetry-emitting
 *      flow) to observe the result.
 */

const credstore = require("./credstore.js");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// On POSIX, stdout/stderr writes to a pipe (e.g. when Claude Code's `!`
// runner captures us) are async and block-buffered. Forcing the streams
// to blocking mode keeps the device-code box on screen consistent with
// what the foreground actually wrote before exiting.
for (const stream of [process.stdout, process.stderr]) {
  try {
    if (stream._handle && typeof stream._handle.setBlocking === "function") {
      stream._handle.setBlocking(true);
    }
  } catch {}
}

// GitHub OAuth App client_id — same SkillMeter app the VS Code extension uses.
const CLIENT_ID = process.env.SKILLMETER_GITHUB_CLIENT_ID || "Ov23ct86rS80kpl7o2Xg";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPE = "read:user read:org";

const BACKGROUND_LOG = path.join(os.homedir(), ".skillbench", "activate-poll.log");

function log(msg) {
  process.stderr.write(msg + "\n");
}

function say(msg) {
  process.stdout.write(msg + "\n");
}

// copyToClipboard tries platform-native clipboard tools. Returns true on
// success, false when no tool is available or the copy fails. Never throws.
function copyToClipboard(text) {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push({ cmd: "pbcopy", args: [] });
  } else if (process.platform === "win32") {
    candidates.push({ cmd: "clip", args: [] });
  } else {
    candidates.push({ cmd: "wl-copy", args: [] });
    candidates.push({ cmd: "xclip", args: ["-selection", "clipboard"] });
    candidates.push({ cmd: "xsel", args: ["--clipboard", "--input"] });
    candidates.push({ cmd: "clip.exe", args: [] });
  }
  for (const { cmd, args } of candidates) {
    const result = spawnSync(cmd, args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (result.status === 0) return true;
  }
  return false;
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
        throw new Error("The device code expired. Run /skillmeter:activate again.");
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

// Background phase: invoked when the script is re-spawned with
// `--background-poll`. Polls GitHub for the access token, exchanges it for
// a license, fetches the user's GitHub identities, and persists everything
// in credstore. Output goes to BACKGROUND_LOG (already redirected by the
// parent's spawn() stdio config) so it can be inspected if activation
// silently fails.
async function runBackgroundPoll(deviceId, deviceCode, interval) {
  log(`[${new Date().toISOString()}] background poll started (device_id=${deviceId})`);
  try {
    const githubToken = await pollForToken(deviceCode, interval);
    log(`[${new Date().toISOString()}] github approval received`);

    const licenseJwt = await exchangeForLicense(githubToken, deviceId);
    log(`[${new Date().toISOString()}] license issued`);

    const orgs = await credstore.fetchUserGitHubOrgs(githubToken);
    log(`[${new Date().toISOString()}] orgs fetched: ${orgs.join(", ") || "(none)"}`);

    credstore.setLicenseToken(licenseJwt);
    credstore.setAllowedGitHubOrgs(orgs);
    credstore.setGhFallbackRetryAfter(0);
    log(`[${new Date().toISOString()}] activation complete`);
    process.exit(0);
  } catch (err) {
    log(`[${new Date().toISOString()}] background poll failed: ${err.message}`);
    process.exit(1);
  }
}

function spawnBackgroundPoll(deviceId, deviceCode, interval) {
  fs.mkdirSync(path.dirname(BACKGROUND_LOG), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(BACKGROUND_LOG, "a");
  const child = spawn(
    process.execPath,
    [__filename, "--background-poll", deviceId, deviceCode, String(interval)],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );
  child.unref();
  fs.closeSync(logFd);
}

async function main() {
  const existingToken = credstore.getLicenseToken();
  const existingOrgs = credstore.getAllowedGitHubOrgs();
  if (
    existingToken &&
    !credstore.isLicenseTokenExpired(existingToken) &&
    existingOrgs.length > 0
  ) {
    say("SkillMeter is already activated.");
    say(`Allowed GitHub identities: ${existingOrgs.join(", ")}`);
    return;
  }
  if (existingToken) {
    log("License expired or orgs missing — refreshing...");
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    log("Activation failed: unable to determine device ID.");
    process.exit(1);
  }

  // Explicit user-initiated activation overrides any cached gh silent-
  // failure cooldown so a user who fixed their `gh auth` scopes doesn't
  // have to wait the cooldown out.
  credstore.setGhFallbackRetryAfter(0);

  log("Trying gh CLI first...");
  const silentJwt = await credstore.trySilentGhActivate(deviceId);
  if (silentJwt) {
    say("SkillMeter activated via gh CLI.");
    const orgs = credstore.getAllowedGitHubOrgs();
    say(`Allowed GitHub identities: ${orgs.join(", ") || "(none)"}`);
    return;
  }

  log("gh activation did not succeed; starting GitHub device flow.");
  const device = await requestDeviceCode();

  const expiresMin = Math.round(device.expires_in / 60);
  const clipboardCopied = copyToClipboard(device.user_code);

  say("");
  say("============================================================");
  say(" GitHub device login required");
  say("============================================================");
  say("");
  say(`  1. Open in your browser:`);
  say(`       ${device.verification_uri}`);
  say("");
  say(`  2. Enter this code:`);
  say(`       ${device.user_code}`);
  say("");
  if (clipboardCopied) {
    say("  (the code has been copied to your clipboard)");
    say("");
  }
  say(`  Code expires in ${expiresMin} minutes.`);
  say("============================================================");
  say("");

  spawnBackgroundPoll(deviceId, device.device_code, device.interval || 5);

  say("Polling for approval in the background.");
  say("After approving on GitHub, run /skillmeter:activate again to confirm.");
  say(`(background log: ${BACKGROUND_LOG})`);
}

if (process.argv[2] === "--background-poll") {
  const deviceId = process.argv[3];
  const deviceCode = process.argv[4];
  const interval = Number(process.argv[5]) || 5;
  runBackgroundPoll(deviceId, deviceCode, interval);
} else {
  main().catch((err) => {
    say(`Activation failed: ${err.message}`);
    process.exit(1);
  });
}

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
const { spawnSync } = require("child_process");

// GitHub OAuth App client_id — same SkillMeter app the VS Code extension uses.
const CLIENT_ID = process.env.SKILLMETER_GITHUB_CLIENT_ID || "Ov23ct86rS80kpl7o2Xg";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPE = "read:user read:org";

function log(msg) {
  process.stderr.write(msg + "\n");
}

// say() writes to stdout so the message survives any stderr buffering done
// by the host that invoked us (e.g. Claude Code's `!`-prefix runner).
// User-facing prompts that the operator must read mid-run go through say().
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
    // Linux / BSD / WSL: try Wayland first, then X11, then WSL's clip.exe.
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

// openBrowser launches the system default browser at `url`. Returns true on
// success, false when no opener is available. Never throws and never blocks
// on the spawned process — the browser is fire-and-forget.
function openBrowser(url) {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push({ cmd: "open", args: [url] });
  } else if (process.platform === "win32") {
    // `start` treats the first quoted arg as a window title, so pass an empty
    // title before the URL.
    candidates.push({ cmd: "cmd", args: ["/c", "start", "", url] });
  } else {
    candidates.push({ cmd: "xdg-open", args: [url] });
    candidates.push({ cmd: "wslview", args: [url] });
  }
  for (const { cmd, args } of candidates) {
    try {
      const result = spawnSync(cmd, args, {
        stdio: "ignore",
        timeout: 5000,
      });
      if (result && result.status === 0) return true;
    } catch {}
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
        throw new Error("The device code expired. Run /activate again.");
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
  const existingToken = credstore.getLicenseToken();
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

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    log("Activation failed: unable to determine device ID.");
    process.exit(1);
  }

  // Explicit user-initiated activation overrides any cached gh silent-
  // failure cooldown. The cooldown exists to protect automated hooks
  // from hammering the endpoints; /activate is always deliberate,
  // so a user who fixed their `gh auth` scopes shouldn't have to wait
  // 24h before the silent path is attempted again.
  credstore.setGhFallbackRetryAfter(0);

  log("Trying gh CLI first...");
  const silentJwt = await credstore.trySilentGhActivate(deviceId);
  if (silentJwt) {
    log("Activated via gh CLI.");
    return;
  }

  log("gh activation did not succeed; falling back to GitHub device flow.");
  log("Starting GitHub device flow...");
  const device = await requestDeviceCode();

  // User-facing details go to stdout so they remain visible even when the
  // host buffers stderr. The whole block is printed before any blocking
  // poll so the operator can act on it immediately.
  const expiresMin = Math.round(device.expires_in / 60);
  say("");
  say("============================================================");
  say(" GitHub device login required");
  say("============================================================");
  say(`  1. Open: ${device.verification_uri}`);
  say(`  2. Enter code: ${device.user_code}`);
  say(`  (code expires in ${expiresMin} minutes)`);
  say("============================================================");
  say("");
  if (copyToClipboard(device.user_code)) {
    say("Code copied to your clipboard.");
  }
  if (openBrowser(device.verification_uri)) {
    say("Opened the verification page in your default browser.");
  } else {
    say("Could not open a browser automatically — open the URL above manually.");
  }
  say("");
  say("Waiting for GitHub approval... (this command will return once you approve)");

  const githubToken = await pollForToken(device.device_code, device.interval || 5);
  say("GitHub approval received. Exchanging for SkillMeter license...");

  const licenseJwt = await exchangeForLicense(githubToken, deviceId);
  credstore.setLicenseToken(licenseJwt);
  credstore.setGhFallbackRetryAfter(0);
  say("SkillMeter activated.");
}

main().catch((err) => {
  say(`Activation failed: ${err.message}`);
  process.exit(1);
});

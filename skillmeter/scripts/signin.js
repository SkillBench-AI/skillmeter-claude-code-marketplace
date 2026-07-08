#!/usr/bin/env node
/**
 * Interactive sign-in flow for the SkillMeter plugin (`/skillmeter:signin`).
 *
 *   1. Try silent sign-in using `gh auth token` when the GitHub CLI is
 *      already logged in.
 *   2. Otherwise start the GitHub OAuth device flow: print the user code
 *      and verification URL to stdout, then hand off polling to a detached
 *      child process. The foreground exits immediately so the user sees
 *      the code right away — Claude Code's `!`-prefix runner displays
 *      captured output once the command returns, so we cannot block on
 *      polling in the foreground.
 *   3. The background child polls for the GitHub access token, POSTs it +
 *      device_id to the SkillMeter activation endpoint, fetches the user's
 *      GitHub identities, and stores the license JWT + orgs in credstore.
 *      The user re-runs `/skillmeter:signin` (or any telemetry-emitting
 *      flow) to observe the result.
 */

const credstore = require("./credstore.js");
const licenseActivation = require("./lib/license-activation");
const { fetchUserGitHubOrgs } = require("./lib/github-api");
const { welcomeBanner } = require("./lib/banner.js");
const { startSpinner } = require("./lib/spinner.js");
const { resolveOrgScope, narrowOrgsToScope } = require("./lib/org-scope");
const { getRepoScopeDecision } = require("./lib/repo-scope");
const { STATE_DIR } = require("./lib/paths");
const {
  getGitHubClientId,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_OAUTH_SCOPE,
} = require("./lib/config");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

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

// GitHub OAuth client id + device-flow URLs/scope resolve centrally in
// lib/config (env > settings > dev-bundle > prod default).

const BACKGROUND_LOG = path.join(STATE_DIR, "activate-poll.log");

function log(msg) {
  process.stderr.write(msg + "\n");
}

function say(msg) {
  process.stdout.write(msg + "\n");
}

// Parse `--org skillbench-ai`, `--org=a,b`, repeated `--org` flags, or the
// `--orgs` alias, into a normalized list. Lets the user scope sign-in to
// specific GitHub orgs (e.g. only @skillbench-ai) instead of enrolling every
// org their account belongs to.
function parseOrgArgs(argv) {
  const orgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--org" || a === "--orgs") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        orgs.push(...v.split(/[,\s]+/).filter(Boolean));
        i++;
      } else {
        log(`Error: ${a} requires a value (e.g., ${a} skillbench-ai)`);
        process.exit(1);
      }
    } else if (a.startsWith("--org=") || a.startsWith("--orgs=")) {
      const value = a.slice(a.indexOf("=") + 1);
      if (!value.trim()) {
        log(`Error: ${a.split("=")[0]}= requires a value (e.g., ${a.split("=")[0]}=skillbench-ai)`);
        process.exit(1);
      }
      orgs.push(...value.split(/[,\s]+/).filter(Boolean));
    }
  }
  return orgs;
}

// Narrow the fetched memberships to the configured scope (CLI > env > setting)
// and persist atomically. Logs what was kept/excluded so the user can see the
// scope took effect. Returns the kept org list (for the welcome banner).
function scopeAndCommit(licenseJwt, orgs, cliOrgs, { sayFn = log } = {}) {
  const scope = resolveOrgScope({ cliOrgs });
  const { orgs: scopedOrgs, excluded, applied } = narrowOrgsToScope(orgs, scope);
  if (applied) {
    sayFn(
      `Org scope applied: keeping [${scopedOrgs.join(", ") || "none"}]` +
        (excluded.length ? `, excluded ${excluded.length} org(s)` : "")
    );
    if (scopedOrgs.length === 0) {
      sayFn(
        "WARNING: the org scope matched none of your memberships — no repos will be in scope."
      );
    }
  }
  const committed = credstore.commitSignin({ jwt: licenseJwt, orgs: scopedOrgs });
  return { committed, scopedOrgs };
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
  return postForm(GITHUB_DEVICE_CODE_URL, { client_id: getGitHubClientId(), scope: GITHUB_OAUTH_SCOPE });
}

async function pollForToken(deviceCode, initialInterval) {
  let interval = initialInterval;
  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const payload = await postForm(GITHUB_TOKEN_URL, {
      client_id: getGitHubClientId(),
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
        throw new Error("The device code expired. Run /skillmeter:signin again.");
      case "access_denied":
        throw new Error("Access was denied on GitHub. Aborting.");
      default:
        throw new Error(`GitHub returned: ${payload.error || "unknown error"}`);
    }
  }
}

async function exchangeForLicense(githubToken, deviceId) {
  const res = await fetch(licenseActivation.getActivateUrl(), {
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
async function runBackgroundPoll(deviceId, deviceCode, interval, cliOrgs) {
  log(`[${new Date().toISOString()}] background poll started (device_id=${deviceId})`);
  try {
    const githubToken = await pollForToken(deviceCode, interval);
    log(`[${new Date().toISOString()}] github approval received`);

    const licenseJwt = await exchangeForLicense(githubToken, deviceId);
    log(`[${new Date().toISOString()}] license issued`);

    const orgs = await fetchUserGitHubOrgs(githubToken);
    log(`[${new Date().toISOString()}] orgs fetched: ${orgs.join(", ") || "(none)"}`);

    const { committed, scopedOrgs } = scopeAndCommit(licenseJwt, orgs, cliOrgs);
    if (!committed) {
      log(`[${new Date().toISOString()}] sign-in discarded: signed out during poll`);
      credstore.writeSigninResult({ status: "discarded" });
      process.exit(0);
    }
    log(`[${new Date().toISOString()}] activation complete (orgs: ${scopedOrgs.join(", ") || "none"})`);
    // Record success so the in-session FileChanged notifier can surface the
    // welcome banner without the user re-running /skillmeter:signin.
    credstore.writeSigninResult({ status: "success", orgs: scopedOrgs });
    process.exit(0);
  } catch (err) {
    log(`[${new Date().toISOString()}] background poll failed: ${err.message}`);
    credstore.writeSigninResult({ status: "failure", error: err.message });
    process.exit(1);
  }
}

function spawnBackgroundPoll(deviceId, deviceCode, interval, cliOrgs) {
  fs.mkdirSync(path.dirname(BACKGROUND_LOG), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(BACKGROUND_LOG, "a");
  // Forward the explicit --org selection to the detached child (env/setting
  // scope is inherited via process.env). "-" means no CLI orgs.
  const orgArg = cliOrgs && cliOrgs.length ? cliOrgs.join(",") : "-";
  const child = spawn(
    process.execPath,
    [__filename, "--background-poll", deviceId, deviceCode, String(interval), orgArg],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );
  child.unref();
  fs.closeSync(logFd);
}

async function main() {
  const cliOrgs = parseOrgArgs(process.argv.slice(2));

  // An explicit /skillmeter:signin re-arms everything in one atomic
  // write: clears the signed-out sentinel and the gh-fallback cooldown
  // so a user who just fixed their `gh auth` scopes or who signed out
  // earlier isn't bounced.
  credstore.markEngaged();

  const existingToken = credstore.getLicenseToken();
  const existingOrgs = credstore.getAllowedGitHubOrgs();
  if (
    existingToken &&
    !credstore.isLicenseTokenExpired(existingToken) &&
    existingOrgs.length > 0
  ) {
    // Already signed in. An explicit `--org` lets the user re-scope the stored
    // org list in place (intersection with what's already there) without a full
    // re-auth — the fast fix for "gh logged me into all my orgs". Re-expanding
    // beyond the stored set requires signout + signin (which re-fetches).
    if (cliOrgs.length > 0) {
      const scope = resolveOrgScope({ cliOrgs });
      const { orgs: scopedOrgs, excluded, applied } = narrowOrgsToScope(existingOrgs, scope);
      if (applied && excluded.length) {
        if (scopedOrgs.length === 0) {
          log(`Error: org scope [${scope.join(", ")}] matched none of your signed-in orgs [${existingOrgs.join(", ")}].`);
          log("To re-expand scope, run /skillmeter:signout then /skillmeter:signin again.");
          process.exit(1);
        }
        if (credstore.commitSignin({ jwt: existingToken, orgs: scopedOrgs })) {
          log(`Re-scoped existing sign-in: keeping [${scopedOrgs.join(", ") || "none"}], excluded ${excluded.length} org(s)`);
          say(welcomeBanner(getRepoScopeDecision(process.cwd())));
          return;
        }
      }
    }
    say(welcomeBanner(getRepoScopeDecision(process.cwd())));
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

  log("Trying gh CLI first...");
  const silentJwt = await licenseActivation.trySilentGhActivate(deviceId, { orgScope: cliOrgs });
  if (silentJwt) {
    say(welcomeBanner(getRepoScopeDecision(process.cwd())));
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
  say(`  1. Copy this code:`);
  say(`       ${device.user_code}`);
  if (clipboardCopied) {
    say("       (already copied to your clipboard)");
  }
  say("");
  say(`  2. Open in your browser and paste it:`);
  say(`       ${device.verification_uri}`);
  say("");
  say(`  Code expires in ${expiresMin} minutes.`);
  say("============================================================");
  say("");

  // In a real terminal, poll inline with a live spinner so the user sees
  // progress while they're approving on GitHub. In a non-TTY runner
  // (Claude Code's `!`-prefix buffers output until exit), fall back to a
  // detached background poll and let the user re-invoke /skillmeter:signin
  // to confirm.
  if (process.stdout.isTTY) {
    await runForegroundPoll(deviceId, device, cliOrgs);
  } else {
    spawnBackgroundPoll(deviceId, device.device_code, device.interval || 5, cliOrgs);
    say("Polling for approval in the background.");
    say("After approving on GitHub, run /skillmeter:signin again to confirm.");
    say(`(background log: ${BACKGROUND_LOG})`);
  }
}

async function runForegroundPoll(deviceId, device, cliOrgs) {
  const stop = startSpinner("Waiting for GitHub approval");
  try {
    const githubToken = await pollForToken(device.device_code, device.interval || 5);
    const licenseJwt = await exchangeForLicense(githubToken, deviceId);
    const orgs = await fetchUserGitHubOrgs(githubToken);
    stop();
    const { committed, scopedOrgs } = scopeAndCommit(licenseJwt, orgs, cliOrgs, { sayFn: say });
    if (!committed) {
      say("Sign-in discarded: signed out during issuance.");
      process.exit(0);
    }
    say(welcomeBanner(getRepoScopeDecision(process.cwd())));
  } catch (err) {
    stop();
    say(`Sign-in failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[2] === "--background-poll") {
  const deviceId = process.argv[3];
  const deviceCode = process.argv[4];
  const interval = Number(process.argv[5]) || 5;
  const orgArg = process.argv[6];
  const cliOrgs = orgArg && orgArg !== "-" ? orgArg.split(/[,\s]+/) : [];
  runBackgroundPoll(deviceId, deviceCode, interval, cliOrgs);
} else {
  main().catch((err) => {
    say(`Activation failed: ${err.message}`);
    process.exit(1);
  });
}

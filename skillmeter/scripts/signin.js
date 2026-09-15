#!/usr/bin/env node
/**
 * Interactive sign-in flow for the SkillMeter plugin (`/skillmeter:signin`).
 *
 *   1. Start an RFC 8628 device flow against the SkillBench broker: print
 *      the user code and verification URL to stdout, then hand off polling
 *      to a detached child process. The foreground exits immediately so the
 *      user sees the code right away — Claude Code's `!`-prefix runner
 *      displays captured output once the command returns, so we cannot
 *      block on polling in the foreground.
 *   2. The background child polls for the broker's ID TOKEN, POSTs it +
 *      device_id to the SkillMeter activation endpoint, and stores the
 *      license JWT in credstore. The user re-runs `/skillmeter:signin` (or
 *      any telemetry-emitting flow) to observe the result.
 *
 * This used to authenticate against GitHub. It now uses the broker every
 * other SkillBench sign-in already goes through, which is what lets somebody
 * who has never touched GitHub activate a plugin at all: the server resolves
 * their tenant through workspace membership rather than through a GitHub App
 * installation they do not have.
 */

const credstore = require("./credstore.js");
const { signinStatusBanner } = require("./lib/banner.js");
const { startSpinner } = require("./lib/spinner.js");
const { getRepoScopeDecision } = require("./lib/repo-scope");
const telemetryStore = require("./lib/telemetry-store");
const { postBearerJson } = require("./lib/http");
const { clearLicenseStatus } = require("./lib/license-status");
const {
  STATE_DIR,
  getActivateUrl,
  getDeviceCodeUrl,
  getTokenUrl,
  getOAuthClientId,
  OAUTH_SCOPE,
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

// Broker URL, client id and scope resolve centrally in lib/config
// (env > settings > dev-bundle > prod default).

const BACKGROUND_LOG = path.join(STATE_DIR, "activate-poll.log");

function log(msg) {
  process.stderr.write(msg + "\n");
}

function say(msg) {
  process.stdout.write(msg + "\n");
}

function showSigninStatus(cwd = process.cwd()) {
  const org = credstore.getAllowedGitHubOrgs()[0] || "";
  const consent = org ? telemetryStore.getOrganizationConsent(org) : null;
  const scope = getRepoScopeDecision(cwd);
  const repositoryEnabled =
    !telemetryStore.getGlobalDisabled() &&
    scope.allowed &&
    scope.remoteOrg === org &&
    telemetryStore.getRepositoryOverride(scope.repoKey) === true;
  say(signinStatusBanner(org, consent, repositoryEnabled));
  if (org && consent === null) {
    say(`Run /skillmeter:signin to choose whether to enable telemetry for @${org}.`);
  }
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
  const { res, payload, text } = await postFormRaw(url, params);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}: ${text}`);
  }
  return payload;
}

async function postFormRaw(url, params) {
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
  const text = await res.text().catch(() => "");
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  return { res, payload, text };
}

// The token endpoint reports "not yet approved" as an ERROR RESPONSE, and
// OAuth error responses carry HTTP 400 (RFC 6749 §5.2). GitHub was unusual in
// answering 200 with the error in the body, so the old polling loop could
// treat every non-2xx as fatal. Against a spec-following broker that would
// abort the first time round, before the person had any chance to approve.
//
// So: a body with an `error` field is data whatever the status says, and only
// a response we cannot read at all is a transport failure.
async function postFormExpectingOAuthErrors(url, params) {
  const { res, payload, text } = await postFormRaw(url, params);
  if (payload && typeof payload === "object") return payload;
  throw new Error(`${url} returned ${res.status}: ${text}`);
}

async function requestDeviceCode() {
  return postForm(getDeviceCodeUrl(), { client_id: getOAuthClientId(), scope: OAUTH_SCOPE });
}

// Polls the broker's token endpoint until the person finishes approving in
// their browser. RFC 8628 verbatim, which is why moving off GitHub changed
// nothing here but the URL: the grant type, the pending/slow_down/expired
// error names and the "back off five seconds" rule are all from the spec.
//
// Returns the ID TOKEN, not the access token. The broker's access tokens are
// opaque — they carry no claims and can only be resolved through an admin
// endpoint /activate has no route to — whereas the id token is a signed JWT
// /activate verifies against the broker's public JWKS. Asking for `openid` is
// what makes the broker issue one; without that scope this returns undefined
// and sign-in fails with "no id_token", which is the honest error.
async function pollForToken(deviceCode, initialInterval) {
  let interval = initialInterval;
  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const payload = await postFormExpectingOAuthErrors(getTokenUrl(), {
      client_id: getOAuthClientId(),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (payload.id_token) return payload.id_token;
    if (payload.access_token && !payload.id_token) {
      throw new Error("Sign-in returned no id_token — the `openid` scope was not granted.");
    }

    switch (payload.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "expired_token":
        throw new Error("The code expired. Run /skillmeter:signin again.");
      case "access_denied":
        throw new Error("Sign-in was denied. Aborting.");
      default:
        throw new Error(`Sign-in failed: ${payload.error || "unknown error"}`);
    }
  }
}

async function exchangeForLicense(idToken, deviceId) {
  const res = await postBearerJson(
    getActivateUrl(),
    idToken,
    { device_id: deviceId },
    { timeoutMs: 10_000 }
  );

  if (res.status === 402) {
    throw new Error("No active SkillMeter license found for your workspaces.");
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
// `--background-poll`. Polls the broker for the id token, exchanges it for a
// license, and persists it. The validated tenant lives in the JWT, so there is
// no second identity lookup here. Output goes to BACKGROUND_LOG (redirected by
// the parent's spawn() stdio) so it can be inspected if activation silently
// fails.
async function runBackgroundPoll(deviceId, deviceCode, interval) {
  log(`[${new Date().toISOString()}] background poll started (device_id=${deviceId})`);
  try {
    const idToken = await pollForToken(deviceCode, interval);
    log(`[${new Date().toISOString()}] sign-in approved`);

    const licenseJwt = await exchangeForLicense(idToken, deviceId);
    log(`[${new Date().toISOString()}] license issued`);

    if (!credstore.commitSignin({ jwt: licenseJwt })) {
      log(`[${new Date().toISOString()}] sign-in discarded: signed out during poll`);
      credstore.writeSigninResult({ status: "discarded" });
      process.exit(0);
    }
    // The daemon may have recorded a terminal state against the old token
    // while the user was approving; the new sign-in supersedes it.
    clearLicenseStatus({ source: "signin" });
    log(`[${new Date().toISOString()}] activation complete`);
    // Record success so the in-session FileChanged notifier can surface the
    // welcome banner without the user re-running /skillmeter:signin.
    credstore.writeSigninResult({ status: "success" });
    process.exit(0);
  } catch (err) {
    log(`[${new Date().toISOString()}] background poll failed: ${err.message}`);
    credstore.writeSigninResult({ status: "failure", error: err.message });
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
  // An explicit /skillmeter:signin re-arms everything in one atomic
  // write: clears the signed-out sentinel and the gh-fallback cooldown
  // so a user who just fixed their `gh auth` scopes or who signed out
  // earlier isn't bounced.
  credstore.markEngaged();
  clearLicenseStatus({ source: "signin" });

  const existingToken = credstore.getLicenseToken();
  if (existingToken && !credstore.isLicenseTokenExpired(existingToken)) {
    // Already signed in — the license (and its validated org) is current.
    showSigninStatus();
    return;
  }
  if (existingToken) {
    log("License expired — refreshing...");
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    log("Activation failed: unable to determine device ID.");
    process.exit(1);
  }

  // Straight to the device grant. The `gh auth token` shortcut that used to
  // run first is gone from the whole plugin, not just from here.
  const device = await requestDeviceCode();

  const expiresMin = Math.round(device.expires_in / 60);
  const clipboardCopied = copyToClipboard(device.user_code);

  // verification_uri_complete already carries the code, so the page can fill
  // the box in and the person only has to confirm. It is optional in RFC 8628,
  // hence the fallback to the bare URL and the copy that suits each.
  const verifyUrl = device.verification_uri_complete || device.verification_uri;
  const prefilled = Boolean(device.verification_uri_complete);

  say("");
  say("============================================================");
  say(" SkillBench sign-in required");
  say("============================================================");
  say("");
  say(`  1. Copy this code:`);
  say(`       ${device.user_code}`);
  if (clipboardCopied) {
    say("       (already copied to your clipboard)");
  }
  say("");
  say(prefilled ? `  2. Open in your browser and confirm:` : `  2. Open in your browser and paste it:`);
  say(`       ${verifyUrl}`);
  say("");
  say(`  Code expires in ${expiresMin} minutes.`);
  say("============================================================");
  say("");

  // In a real terminal, poll inline with a live spinner so the user sees
  // progress while they're approving in the browser. In a non-TTY runner
  // (Claude Code's `!`-prefix buffers output until exit), fall back to a
  // detached background poll and let the user re-invoke /skillmeter:signin
  // to confirm.
  if (process.stdout.isTTY) {
    await runForegroundPoll(deviceId, device);
  } else {
    spawnBackgroundPoll(deviceId, device.device_code, device.interval || 5);
    say("Polling for approval in the background.");
    say("After approving in your browser, run /skillmeter:signin again to confirm.");
    say(`(background log: ${BACKGROUND_LOG})`);
  }
}

async function runForegroundPoll(deviceId, device) {
  const stop = startSpinner("Waiting for approval");
  try {
    const idToken = await pollForToken(device.device_code, device.interval || 5);
    const licenseJwt = await exchangeForLicense(idToken, deviceId);
    stop();
    if (!credstore.commitSignin({ jwt: licenseJwt })) {
      say("Sign-in discarded: signed out during issuance.");
      process.exit(0);
    }
    clearLicenseStatus({ source: "signin" });
    showSigninStatus();
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
  runBackgroundPoll(deviceId, deviceCode, interval);
} else {
  main().catch((err) => {
    say(`Activation failed: ${err.message}`);
    process.exit(1);
  });
}

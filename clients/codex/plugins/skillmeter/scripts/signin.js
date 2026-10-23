#!/usr/bin/env node
/**
 * Sign in through the SkillBench sign-in service (ADR 005): the device flow,
 * then an exchange of its ID token for a license. The broker's refresh token is
 * kept with the license and renews it from then on. Without a TTY, polling runs
 * in a detached child so the code can be shown before the runner exits.
 * Usage: node scripts/signin.js.
 */

const credstore = require("./credstore.js");
const config = require("./lib/config");
const licenseActivation = require("./lib/license-activation");
const { requestDeviceCode, pollDeviceToken } = require("./lib/broker");
const { exchangeIdToken } = require("./lib/license-exchange");
const { signinBanner } = require("./lib/banner.js");
const { startSpinner } = require("./lib/spinner.js");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// On POSIX, stdout/stderr writes to a pipe (e.g. when a non-interactive runner
// captures us) are async and block-buffered. Forcing the streams to blocking
// mode keeps the device-code box on screen consistent with what the foreground
// actually wrote before exiting.
for (const stream of [process.stdout, process.stderr]) {
  try {
    if (stream._handle && typeof stream._handle.setBlocking === "function") {
      stream._handle.setBlocking(true);
    }
  } catch {}
}

const backgroundLog = () => path.join(config.sessionDir(), "signin-poll.log");

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

async function exchangeForLicense(idToken, deviceId) {
  const result = await exchangeIdToken(idToken, deviceId);
  if (result.outcome === "issued") return result.token;
  if (result.status === 402) {
    throw new Error("No active SkillMeter license found for your workspaces.");
  }
  throw new Error(`Activation failed (${result.status ? `HTTP ${result.status}` : result.message})`);
}

// Approve, exchange and commit for one sign-in intent. A newer sign-in or a
// sign-out meanwhile makes the commit a no-op.
async function completeSignin(deviceId, deviceCode, interval, generation) {
  const { idToken, refreshToken } = await pollDeviceToken(deviceCode, interval);
  const licenseJwt = await exchangeForLicense(idToken, deviceId);
  if (!refreshToken) throw new Error("Sign-in returned no refresh token; the offline scope was not granted.");
  const committed = credstore.commitSignin({ jwt: licenseJwt, refreshToken, generation });
  return committed ? licenseJwt : null;
}

// Background phase: re-spawned with `--background-poll`. Output goes to the
// background log (redirected by the parent's spawn()), so a silent failure can
// be inspected.
async function runBackgroundPoll(deviceId, deviceCode, interval, generation) {
  log(`[${new Date().toISOString()}] background poll started`);
  try {
    const token = await completeSignin(deviceId, deviceCode, interval, generation);
    log(`[${new Date().toISOString()}] ${token ? "signed in" : "sign-in discarded: signed out or signed in again meanwhile"}`);
    process.exit(0);
  } catch (err) {
    log(`[${new Date().toISOString()}] background poll failed: ${err.message}`);
    process.exit(1);
  }
}

function spawnBackgroundPoll(deviceId, deviceCode, interval, generation) {
  fs.mkdirSync(path.dirname(backgroundLog()), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(backgroundLog(), "a", 0o600);
  const child = spawn(
    process.execPath,
    [__filename, "--background-poll", deviceId, deviceCode, String(interval), generation],
    { detached: true, stdio: ["ignore", logFd, logFd] }
  );
  child.unref();
  fs.closeSync(logFd);
}

// Cards showing each organization's telemetry state and its local
// repositories, as the Claude plugin shows after sign-in, then the line the
// signin skill reads to start onboarding. That line carries organizations and
// their Codex consent only; the skill lists repositories again right before
// asking.
function sayWelcome() {
  let inventory = null, currentKey = null, error = null;
  try {
    const { loadInventory } = require("./lib/repository-inventory");
    const loaded = loadInventory();
    inventory = loaded.inventory;
    currentKey = loaded.logger.getRepoScopeDecision(process.cwd()).repoKey || null;
  } catch (err) {
    error = err.code || "POLICY_UNAVAILABLE";
  }
  say(signinBanner({ inventory, currentKey, error }));
  const state = error
    ? { status: "signed_in", consentRecordError: error }
    : { status: "signed_in", globalPaused: inventory.globalPaused, orgs: inventory.orgs };
  say(`SkillMeter sign-in state JSON:\n${JSON.stringify(state)}`);
}

// A valid license whose session the sign-in service already ended is not a
// sign-in to keep.
function currentSignin() {
  const token = credstore.getLicenseToken();
  if (!token || credstore.isLicenseTokenExpired(token)) return null;
  if (licenseActivation.readStatus().terminal) return null;
  return token;
}

async function main() {
  const { prepareSession, CUTOVER_HOLD } = require("./session_start");
  if (!prepareSession()) throw new Error(CUTOVER_HOLD);
  if (currentSignin()) {
    sayWelcome();
    return;
  }

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    log("Sign-in failed: unable to determine the device ID.");
    process.exit(1);
  }

  // A new intent: clears the sign-out and supersedes any older pending poll.
  const generation = credstore.markEngaged();
  const device = await requestDeviceCode();

  const expiresMin = Math.round(device.expires_in / 60);
  const clipboardCopied = copyToClipboard(device.user_code);
  // verification_uri_complete already carries the code; it is optional in
  // RFC 8628, hence the fallback.
  const verifyUrl = device.verification_uri_complete || device.verification_uri;

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
  say(device.verification_uri_complete ? `  2. Open in your browser and confirm:` : `  2. Open in your browser and paste it:`);
  say(`       ${verifyUrl}`);
  say("");
  say(`  Code expires in ${expiresMin} minutes.`);
  say("============================================================");
  say("");

  // In a real terminal, poll inline with a spinner. In a non-TTY runner
  // (output buffered until exit), poll in a detached child and let the user
  // re-run the sign-in flow to confirm.
  if (process.stdout.isTTY) {
    const stop = startSpinner("Waiting for approval");
    try {
      const token = await completeSignin(deviceId, device.device_code, device.interval || 5, generation);
      stop();
      if (!token) {
        say("Sign-in discarded: signed out or signed in again meanwhile.");
        process.exit(0);
      }
      sayWelcome();
    } catch (err) {
      stop();
      say(`Sign-in failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    spawnBackgroundPoll(deviceId, device.device_code, device.interval || 5, generation);
    say("Polling for approval in the background.");
    say("After approving in your browser, run the sign-in flow again to confirm and choose telemetry.");
    say(`(background log: ${backgroundLog()})`);
  }
}

if (process.argv[2] === "--background-poll") {
  const [deviceId, deviceCode, interval, generation] = process.argv.slice(3);
  if (!generation) {
    log("Sign-in intent missing; run the sign-in flow again.");
    process.exit(1);
  }
  runBackgroundPoll(deviceId, deviceCode, Number(interval) || 5, generation);
} else {
  main().catch((err) => {
    say(`Sign-in failed: ${err.message}`);
    process.exit(1);
  });
}

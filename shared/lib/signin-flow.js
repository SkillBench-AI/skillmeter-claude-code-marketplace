"use strict";

/**
 * The sign-in flow both clients run (ADR 005): the broker device grant, then
 * an exchange of its ID token for a license, keeping the broker's refresh
 * token, which renews the license from then on. In a terminal the poll runs
 * inline with a spinner. In a non-TTY runner, whose output is buffered until
 * it exits, the poll runs in a detached child so the code is on screen at
 * once, and the user runs sign-in again to confirm.
 *
 * A sign-in waiting for approval is not cancelled by running sign-in again:
 * that reports it, and the restart command starts over on purpose.
 *
 * Each client passes `client`:
 *   script             its signin.js, re-spawned for the background poll
 *   signinCommand      what the user runs to sign in, for messages
 *   restartCommand     what cancels a waiting sign-in and starts over
 *   confirmHint        what running sign-in again does after approval
 *   backgroundLog()    where the background poll writes
 *   prepare()          optional, runs first; throw to stop
 *   currentSignin()    a license to keep (valid, session not ended), or null
 *   sessionEnded()     a license is present but its session ended
 *   onEngaged()        optional, after a new sign-in intent starts
 *   showSignedIn()     what the user sees once signed in
 *   pending            { isPending(), mark(lifetimeMs, expected), clear?() }
 *   commit({ jwt, refreshToken, expected })   false when superseded
 *   recordFailure(message, expected)          optional
 */

const { spawnSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const credstore = require("../credstore.js");
const { requestDeviceCode, pollDeviceToken } = require("./broker");
const { exchangeIdToken } = require("./license-exchange");
const { startSpinner } = require("./spinner");

// Used when the broker does not say how long its device code lives.
const DEFAULT_DEVICE_CODE_LIFETIME_S = 15 * 60;
// A waiting sign-in is reported for at most this long, whatever the broker says.
const PENDING_MAX_MS = 30 * 60_000;

const log = (msg) => process.stderr.write(msg + "\n");
const say = (msg) => process.stdout.write(msg + "\n");
const stamp = () => `[${new Date().toISOString()}]`;

// On POSIX, stdout/stderr writes to a pipe (a runner capturing us) are async
// and block-buffered. Blocking mode keeps the device-code box on screen
// consistent with what the foreground wrote before exiting.
function blockingOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    try {
      if (stream._handle && typeof stream._handle.setBlocking === "function") stream._handle.setBlocking(true);
    } catch {}
  }
}

// Platform-native clipboard tools. True on success; never throws.
function copyToClipboard(text) {
  const candidates = process.platform === "darwin" ? [["pbcopy", []]]
    : process.platform === "win32" ? [["clip", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["clip.exe", []]];
  for (const [cmd, args] of candidates) {
    if (spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0) return true;
  }
  return false;
}

async function exchangeForLicense(idToken, deviceId) {
  const result = await exchangeIdToken(idToken, deviceId);
  if (result.outcome === "issued") return result.token;
  if (result.status === 402) throw new Error("No active SkillMeter license found for your workspaces.");
  throw new Error(`Activation failed (${result.status ? `HTTP ${result.status}` : result.message})`);
}

// Approve, exchange and commit for one sign-in intent. Null when a newer
// sign-in or a sign-out took over meanwhile.
async function completeSignin(client, expected, deviceCode, interval) {
  const { idToken, refreshToken } = await pollDeviceToken(deviceCode, interval);
  const jwt = await exchangeForLicense(idToken, expected.deviceId);
  return client.commit({ jwt, refreshToken, expected }) ? jwt : null;
}

function showCode(device, lifetimeS) {
  const clipboardCopied = copyToClipboard(device.user_code);
  // verification_uri_complete already carries the code, so the page fills it
  // in and the person only confirms. It is optional in RFC 8628.
  const prefilled = Boolean(device.verification_uri_complete);
  for (const line of [
    "",
    "============================================================",
    " SkillBench sign-in required",
    "============================================================",
    "",
    "  1. Copy this code:",
    `       ${device.user_code}`,
    ...(clipboardCopied ? ["       (already copied to your clipboard)"] : []),
    "",
    prefilled ? "  2. Open in your browser and confirm:" : "  2. Open in your browser and paste it:",
    `       ${device.verification_uri_complete || device.verification_uri}`,
    "",
    `  Code expires in ${Math.round(lifetimeS / 60)} minutes.`,
    "============================================================",
    "",
  ]) say(line);
}

function spawnBackgroundPoll(client, expected, deviceCode, interval) {
  const file = client.backgroundLog();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(file, "a", 0o600);
  const child = spawn(process.execPath,
    [client.script, "--background-poll", expected.deviceId, deviceCode, String(interval), expected.generation],
    { detached: true, stdio: ["ignore", logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
}

// A failed sign-in is no longer waiting: running sign-in again starts over.
function failed(client, message, expected) {
  try { if (client.pending.clear) client.pending.clear(); } catch {}
  if (client.recordFailure) client.recordFailure(message, expected);
}

// The background phase, in the re-spawned child. Its output is the log.
async function runBackgroundPoll(client, [deviceId, deviceCode, interval, generation]) {
  if (!generation) {
    log(`Sign-in intent missing. Run ${client.signinCommand} again.`);
    process.exit(1);
  }
  const expected = { generation, deviceId };
  log(`${stamp()} background poll started`);
  try {
    const jwt = await completeSignin(client, expected, deviceCode, Number(interval) || 5);
    log(`${stamp()} ${jwt ? "signed in" : "sign-in discarded: signed out or signed in again meanwhile"}`);
    process.exit(0);
  } catch (err) {
    log(`${stamp()} background poll failed: ${err.message}`);
    failed(client, err.message, expected);
    process.exit(1);
  }
}

async function signin(client, { restart = false } = {}) {
  // Re-running sign-in, from shell history or by repetition, must not cancel
  // a code that is waiting for approval in the browser.
  if (!restart && client.pending.isPending()) {
    say("SkillMeter sign-in in progress: a sign-in code is waiting for approval in the browser.");
    say(`Approve it there, then run ${client.signinCommand} to confirm.`);
    say(`To cancel it and start over: ${client.restartCommand}`);
    return;
  }
  if (client.prepare) client.prepare();
  if (client.currentSignin()) {
    client.showSignedIn();
    return;
  }
  if (client.sessionEnded()) log("Your session ended — signing in again...");
  else if (credstore.getLicenseToken()) log("License expired — refreshing...");

  const deviceId = credstore.getDeviceId();
  if (!deviceId) {
    log("Sign-in failed: unable to determine the device ID.");
    process.exit(1);
  }
  // A new intent: it supersedes an older pending poll, and the sign-out stays
  // recorded until the sign-in commits.
  const expected = { generation: credstore.markEngaged(), deviceId };
  if (client.onEngaged) client.onEngaged();

  const device = await requestDeviceCode();
  const lifetimeS = Number(device.expires_in) > 0 ? Number(device.expires_in) : DEFAULT_DEVICE_CODE_LIFETIME_S;
  client.pending.mark(Math.min(lifetimeS * 1000, PENDING_MAX_MS), expected);
  showCode(device, lifetimeS);

  const interval = device.interval || 5;
  if (!process.stdout.isTTY) {
    spawnBackgroundPoll(client, expected, device.device_code, interval);
    say("Polling for approval in the background.");
    say(`After approving in your browser, run ${client.signinCommand} again to ${client.confirmHint}.`);
    say(`(background log: ${client.backgroundLog()})`);
    return;
  }
  const stop = startSpinner("Waiting for approval");
  try {
    const jwt = await completeSignin(client, expected, device.device_code, interval);
    stop();
    if (!jwt) {
      say("Sign-in discarded: signed out or signed in again meanwhile.");
      process.exit(0);
    }
    client.showSignedIn();
  } catch (err) {
    stop();
    failed(client, err.message, expected);
    say(`Sign-in failed: ${err.message}`);
    process.exit(1);
  }
}

/**
 * A waiting-sign-in record in its own file, for a client with no other place
 * for it. `currentGeneration()` returns the session's sign-in intent, so a
 * record from an older intent never reads as pending.
 */
function filePending(file, currentGeneration) {
  const tag = (generation) => crypto.createHash("sha256").update(String(generation)).digest("hex").slice(0, 16);
  return {
    isPending(now = Date.now()) {
      try {
        const record = JSON.parse(fs.readFileSync(file(), "utf8"));
        if (typeof record.expires_at !== "number" || now >= record.expires_at || record.expires_at - now > PENDING_MAX_MS) return false;
        const generation = currentGeneration();
        return Boolean(generation) && record.intent === tag(generation);
      } catch { return false; }
    },
    mark(lifetimeMs, expected) {
      try {
        fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file(), JSON.stringify({ expires_at: Date.now() + lifetimeMs, intent: tag(expected.generation) }) + "\n", { mode: 0o600 });
      } catch {}
    },
    // A finished sign-in changes the intent, so its record no longer matches.
    clear() {
      try { fs.unlinkSync(file()); } catch {}
    },
  };
}

// Entry point for a client's signin.js.
function main(client, argv = process.argv.slice(2)) {
  blockingOutput();
  if (argv[0] === "--background-poll") return runBackgroundPoll(client, argv.slice(1));
  return signin(client, { restart: argv.includes("--restart") }).catch((err) => {
    say(`Sign-in failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, filePending, PENDING_MAX_MS };

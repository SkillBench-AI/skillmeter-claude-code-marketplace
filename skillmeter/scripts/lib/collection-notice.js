/**
 * Collection notices (ADR 003, decision 2): one line when this client stops
 * collecting, one when it can collect again, and nothing in between.
 *
 * Each Claude Code session keeps the state it last resolved, or the stop it
 * is still in, and a line is shown only when the state's group changes: into
 * or out of capture stopped (signed_out, token_missing, revoked) or
 * delivery_paused, and once more when a revocation first read as a lost
 * license is corrected. The state is resolved without a working directory.
 * These are facts about this client, so a line never claims that a
 * repository was recording.
 */

const fs = require("fs");
const path = require("path");
const credstore = require("../credstore");
const { ACCOUNT_DIR } = require("./paths");
const { atomicWriteJson, safeReadJson } = require("./io");
const { acquireLock } = require("./credential-lock");
const { LICENSE_STATUS_FILE, updateLicenseStatus } = require("./license-status");
const { GROUPS, STATES, readCollectionState, stateGroup } = require("./collection-state");
const { RESUMED_NOTICE, stoppedNotice } = require("./collection-wording");

// One file per session, named by its session id and holding only the state
// name. Sessions end without saying so; transfer.js cleanupStaleFiles removes
// a file 30 days after its last write.
const SESSION_STATE_DIR = path.join(ACCOUNT_DIR, "collection-state");
// A hook without a usable session id shares one file per client.
const CLIENT_KEY = "_client";
// One file per session holding the time of the last sign-in result its
// notice printed, written by on_signin_result. Aged out like the state files.
const SIGNIN_NOTICE_DIR = path.join(ACCOUNT_DIR, "signin-notices");

// Claude Code starts the handlers for files written together at the same
// moment, so the hooks of one session wait for each other.
const LOCK_WAIT_MS = 4000;
// How long to wait for the sign-in notice, which runs alongside this hook.
const SIGNIN_NOTICE_WAIT_MS = 2000;
// The states a stop can end in: the return line says telemetry can be
// collected, which the pause and a client without a license cannot.
const CAN_COLLECT = new Set([STATES.UNCONFIGURED, STATES.RECORDING]);

function sessionKey(sessionId) {
  return typeof sessionId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(sessionId) ? sessionId : CLIENT_KEY;
}

function sessionStateFile(sessionId) {
  return path.join(SESSION_STATE_DIR, `${sessionKey(sessionId)}.json`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// fn's result, or null when another hook of the session held the lock
// throughout: that one resolves the same change.
function withSessionLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let release;
  while (!(release = acquireLock(`${file}.lock`))) {
    if (Date.now() >= deadline) return null;
    sleep(10);
  }
  try { return fn(); }
  finally { release(); }
}

// The stored state and when it was last resolved, or null.
function readSessionState(file) {
  try {
    const { mtimeMs } = fs.statSync(file);
    const record = safeReadJson(file, null);
    return typeof record?.state === "string" ? { state: record.state, at: mtimeMs } : null;
  } catch {
    return null;
  }
}

function writeSessionState(file, state) {
  try { atomicWriteJson(file, { state }); } catch {}
}

/**
 * SessionStart: create the status record if there is none, so the watch on it
 * registers (a file created after the watch can be missed), and store the
 * state this session starts in, which its card has shown.
 */
function startSessionState(sessionId) {
  if (!fs.existsSync(LICENSE_STATUS_FILE)) updateLicenseStatus((status) => status);
  const file = sessionStateFile(sessionId);
  withSessionLock(file, () => writeSessionState(file, readCollectionState().state));
}

function signinNoticeFile(sessionId) {
  return path.join(SIGNIN_NOTICE_DIR, `${sessionKey(sessionId)}.json`);
}

/** The time of the last sign-in result this session's notice printed, or 0. */
function lastSigninNoticeShown(sessionId) {
  const record = safeReadJson(signinNoticeFile(sessionId), null);
  return typeof record?.ts === "number" ? record.ts : 0;
}

/** on_signin_result: this session's notice printed the result of time `ts`. */
function recordSigninNoticeShown(sessionId, ts) {
  try { atomicWriteJson(signinNoticeFile(sessionId), { ts }); } catch {}
}

// Whether this session's sign-in notice printed the sign-in that ended this
// stop. Only a sign-in completed after the session last resolved counts.
function signinNoticeShownHere(key, since) {
  const result = credstore.readSigninResult();
  if (result?.status !== "success" || !(result.ts > since)) return false;
  const deadline = Date.now() + SIGNIN_NOTICE_WAIT_MS;
  for (;;) {
    if (lastSigninNoticeShown(key) >= result.ts) return true;
    if (Date.now() >= deadline) return false;
    sleep(25);
  }
}

/**
 * The line for this session after a watched file changed, or "". The state
 * is stored after every resolution, except one that cannot end a stop or that
 * passes from a stop through uploads paused: then the stop stays stored. So a
 * line follows only a change of group, or the revocation that corrects a
 * lost license.
 */
function collectionNotice(sessionId) {
  const key = sessionKey(sessionId);
  const file = sessionStateFile(key);
  return withSessionLock(file, () => {
    const stored = readSessionState(file);
    const current = readCollectionState();
    const from = stored ? stateGroup(stored.state) : GROUPS.HEALTHY;
    const to = stateGroup(current.state);
    // Only a state that can collect ends a stop. The pause collects nothing,
    // and a license that names no organization puts every repository outside
    // it, so the stop stays.
    const canCollect = CAN_COLLECT.has(current.state) && credstore.getAllowedGitHubOrgs().length > 0;
    if (from !== GROUPS.HEALTHY && to === GROUPS.HEALTHY && !canCollect) return "";
    // A sign-in commits the license before it clears an ended session's
    // reason, so a stop can pass through delivery_paused on its way out.
    if (from === GROUPS.CAPTURE_STOPPED && to === GROUPS.DELIVERY_PAUSED) return "";
    writeSessionState(file, current.state);
    // A 402 drops the license before it records the reason, so a hook in
    // between read a lost license and said so. The revocation corrects that
    // line, once. Recording the reason first would happen outside the
    // generation check that keeps a late revocation off a newer sign-in.
    if (stored?.state === STATES.TOKEN_MISSING && current.state === STATES.REVOKED) {
      return stoppedNotice(current, to);
    }
    if (from === to) return "";
    if (to !== GROUPS.HEALTHY) return stoppedNotice(current, to);
    // Where the sign-in notice was shown, it already says so.
    if (signinNoticeShownHere(key, stored.at)) return "";
    return RESUMED_NOTICE;
  }) || "";
}

module.exports = {
  SESSION_STATE_DIR,
  SIGNIN_NOTICE_DIR,
  sessionKey,
  lastSigninNoticeShown,
  startSessionState,
  recordSigninNoticeShown,
  collectionNotice,
};

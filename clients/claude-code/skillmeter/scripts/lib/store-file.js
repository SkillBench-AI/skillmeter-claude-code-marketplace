// GENERATED from shared/lib/store-file.js by scripts/sync-shared.mjs. Edit that file, not this copy.
"use strict";

/**
 * Locked read/modify/write of the small JSON stores under ~/.skillbench: the
 * device identity every client shares (credentials.json) and each client's own
 * session. One implementation, because both clients write credentials.json:
 * a client that overwrote what it could not read, or dropped a corrupt file
 * without a trace, would destroy the other client's identity too.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { acquireLock } = require("./credential-lock");

// How long a writer waits for another process's lock before giving up with
// "credential-store-busy".
const LOCK_WAIT_MS = 1000;

function isStoreObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// A store that does not exist, or exists but is not a JSON object (truncated,
// emptied, a foreign non-atomic writer caught mid-write), reads as empty; the
// next write re-creates it, keeping the original bytes first (mutateFile).
function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return isStoreObject(value) ? value : {};
  } catch {
    return {};
  }
}

// null when the file does not exist. A file that exists but cannot be read
// throws: writing over it would replace a device identity or session this
// process simply could not see.
function readRaw(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`credential store unreadable (${err?.code || "error"})`);
  }
}

function isCorrupt(raw) {
  if (raw == null) return false;
  try { return !isStoreObject(JSON.parse(raw)); }
  catch { return true; }
}

// Keep a corrupt store's exact bytes before it is replaced, and say so: what
// it held is gone, so the user must sign in again. Throws when the copy cannot
// be made, so the caller does not reset a store it failed to preserve. Runs
// under the file's lock.
function preserveCorrupt(file) {
  const { SIGNIN_COMMAND } = require("./config");
  const bytes = fs.readFileSync(file); // a Buffer: invalid UTF-8 survives
  const aside = `${file}.corrupt-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(aside, bytes, { mode: 0o600, flag: "wx" });
  console.error(
    `[skillmeter] Credential store was unreadable and has been reset; the original is kept at ${aside}. Run ${SIGNIN_COMMAND} to sign in again.`
  );
}

// Write and fsync a sibling file before renaming it over the store, so readers
// see a complete old or new file.
function writeObject(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempPath = `${file}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

// Run `fn(release)` holding the file's lock (credential-lock.js), waiting up
// to LOCK_WAIT_MS for another process.
function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let release;
  while (!(release = acquireLock(`${file}.lock`))) {
    if (Date.now() >= deadline) throw new Error("credential-store-busy");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { return fn(release); }
  finally { release(); }
}

const PREEMPTED = Symbol("credential-store-preempted");

// Apply `fn(store)` under the lock and write the result. `fn` returning false
// writes nothing. A changed file or a lost lock (checks that detect visible
// preemption, not an atomic rename fence) retries, up to three times.
function mutateFile(file, fn, afterCommit) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = withFileLock(file, (release) => {
      const baseline = readRaw(file);
      const store = readObject(file);
      const outcome = fn(store);
      if (outcome === false) return false;
      if (!release.stillHeld() || readRaw(file) !== baseline) return PREEMPTED;
      if (isCorrupt(baseline)) preserveCorrupt(file);
      writeObject(file, store);
      if (afterCommit) afterCommit();
      return outcome === undefined ? true : outcome;
    });
    if (result !== PREEMPTED) return result;
  }
  throw new Error("credential-store-busy");
}

module.exports = { readObject, readRaw, writeObject, withFileLock, mutateFile };

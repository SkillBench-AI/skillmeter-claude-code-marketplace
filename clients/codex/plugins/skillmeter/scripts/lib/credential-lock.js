"use strict";

const fs = require("fs");
const crypto = require("crypto");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Age backstop for abandoned locks, unreadable owners and reused PIDs.
// It can reclaim a paused live writer; ownership checks do not fence later writes.
const STALE_MS = 60_000;

// Respect live or unknown owners until the age backstop is reached.
function heldByLiveOwner(owner, stat) {
  if (Date.now() - stat.mtimeMs > STALE_MS) return false;
  return alive(owner?.pid);
}

function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

// Publish the owner atomically and identify it with a per-acquisition token.
// Inodes can be reused after unlink, so they cannot prove continued ownership.
function acquireLock(file, depth = 0) {
  if (depth > 8) return null;
  const token = crypto.randomUUID();
  const ownerFile = `${file}.owner-${token}`;
  const fd = fs.openSync(ownerFile, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }

  try { fs.linkSync(ownerFile, file); fs.unlinkSync(ownerFile); }
  catch (error) {
    fs.unlinkSync(ownerFile);
    if (error.code !== "EEXIST") throw error;

    let stat;
    try { stat = fs.statSync(file); }
    catch (err) {
      if (err.code === "ENOENT") return acquireLock(file, depth + 1);
      throw err;
    }
    if (heldByLiveOwner(readOwner(file), stat)) return null;

    // Coordinate stale cleanup. Normal acquire/release does not take this lock,
    // so a replacement can still appear between the stale check and unlink.
    const releaseReaper = acquireLock(`${file}.reap`, depth + 1);
    if (!releaseReaper) return null;
    try {
      // Recheck under the reaper lock: another writer may have replaced the owner.
      let stale;
      try { stale = !heldByLiveOwner(readOwner(file), fs.statSync(file)); }
      catch (err) {
        if (err.code !== "ENOENT") throw err;
        stale = false; // already gone; just retry the acquire
      }
      if (stale) {
        try { fs.unlinkSync(file); }
        catch (err) { if (err.code !== "ENOENT") throw err; }
      }
    } finally { releaseReaper(); }

    return acquireLock(file, depth + 1);
  }

  // Detect replacement by the age backstop. This check is not atomic with a
  // caller's write or release's unlink; neither operation is fenced by it.
  const ownedByUs = () => readOwner(file)?.token === token;

  const release = () => {
    if (!ownedByUs()) return;
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  release.stillHeld = ownedByUs;
  return release;
}

module.exports = { acquireLock };

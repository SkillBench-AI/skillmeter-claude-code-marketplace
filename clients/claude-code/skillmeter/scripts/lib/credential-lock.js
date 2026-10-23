"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ESRCH is the only evidence of a dead owner. EPERM, PID reuse, malformed
// ownership and unknown formats hold the lock; age alone proves nothing.
function dead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

function readOwner(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner.token) ||
        (owner.version !== undefined && owner.version !== 2)) return null;
    return owner;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    return null;
  }
}

function sameOwner(first, second) {
  return Boolean(first && second && first.pid === second.pid && first.token === second.token);
}

// Exclusive hard-link publication and per-owner cleanup serialize cooperating
// writers. No live process is evicted. This assumes one host/PID namespace and
// clients using this protocol; old clients with an age timeout must be stopped.
function acquireLock(file, depth = 0) {
  if (depth > 8) return null;
  const owner = { version: 2, pid: process.pid, token: crypto.randomUUID() };
  const ownerFile = `${file}.owner-${owner.token}`;
  let fd;
  let published = false;
  try {
    fd = fs.openSync(ownerFile, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.linkSync(ownerFile, file); published = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(ownerFile); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  if (!published) {
    const observed = readOwner(file);
    if (observed === undefined) return acquireLock(file, depth + 1);
    if (!observed || !dead(observed.pid)) return null;

    // Every remover of this dead incarnation takes the same reaper lock.
    // A delayed reaper cannot remove a later owner: the dead owner cannot
    // release, and its other reapers cannot unlink while this guard is held.
    // Hashing keeps nested recovery paths bounded even after repeated crashes.
    const key = crypto.createHash("sha256").update(JSON.stringify([path.basename(file), observed.token])).digest("hex");
    const reaper = path.join(path.dirname(file), `.credential-reap-${key}.lock`);
    const releaseReaper = acquireLock(reaper, depth + 1);
    if (!releaseReaper) return null;
    try {
      if (sameOwner(readOwner(file), observed) && dead(observed.pid)) {
        try { fs.unlinkSync(file); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    } finally { releaseReaper(); }
    return acquireLock(file, depth + 1);
  }

  let released = false;
  const ownedByUs = () => !released && sameOwner(readOwner(file), owner);
  const release = () => {
    if (!ownedByUs()) return;
    // Cooperating clients cannot replace this live owner before this unlink.
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    released = true;
  };
  release.stillHeld = ownedByUs;
  return release;
}

module.exports = { acquireLock };

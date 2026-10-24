"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { acquireLock } = require("../lib/credential-lock");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-lock-safety-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function aged(file) { fs.utimesSync(file, new Date(0), new Date(0)); }

test("age cannot evict a live holder or let its release delete a replacement", () => {
  const file = path.join(root, "live.lock");
  const release = acquireLock(file);
  const before = fs.readFileSync(file);
  aged(file);
  let contender;
  try {
    contender = acquireLock(file);
    assert.equal(contender, null);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(release.stillHeld(), true);
  } finally { if (contender) contender(); release(); }
});

for (const owner of ["malformed", { pid: process.pid }, { pid: -1, token: crypto.randomUUID() }]) {
  test(`unverifiable ownership is held even after aging: ${JSON.stringify(owner)}`, () => {
    const file = path.join(root, crypto.randomUUID() + ".lock");
    const data = typeof owner === "string" ? owner : JSON.stringify(owner);
    fs.writeFileSync(file, data); aged(file);
    let release;
    try {
      release = acquireLock(file);
      assert.equal(release, null);
      assert.equal(fs.readFileSync(file, "utf8"), data);
    } finally { if (release) release(); }
  });
}

test("an unknown owner format is not reclaimed", () => {
  const file = path.join(root, "future.lock");
  fs.writeFileSync(file, JSON.stringify({ version: 999, pid: 2147483647, token: crypto.randomUUID() }));
  aged(file);
  let release;
  try { release = acquireLock(file); assert.equal(release, null); }
  finally { if (release) release(); }
});

test("EPERM is not evidence that an owner is dead", () => {
  const file = path.join(root, "inaccessible.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }));
  const kill = process.kill;
  process.kill = () => { const error = Error("denied"); error.code = "EPERM"; throw error; };
  try { assert.equal(acquireLock(file), null); }
  finally { process.kill = kill; }
});

test("releasing twice cannot unlink the next holder", () => {
  const file = path.join(root, "repeated-release.lock");
  const first = acquireLock(file); first();
  const second = acquireLock(file);
  try { first(); assert.equal(first.stillHeld(), false); assert.equal(second.stillHeld(), true); }
  finally { second(); }
});

test("failed owner persistence cleans temporary files without publishing a lock", () => {
  const file = path.join(root, "failed-publish.lock");
  const sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error("synthetic-fsync-failure"); };
  try { assert.throws(() => acquireLock(file), /synthetic-fsync-failure/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(fs.readdirSync(root).some(name => name.startsWith("failed-publish.lock")), false);
});

// A lock can still disappear under its holder (removed by hand, or by an
// older client that reaped by age), so a writer re-checks ownership before it
// persists.
test("a holder can tell that its lock was reaped", () => {
  const lock = path.join(root, "fence.lock");
  const release = acquireLock(lock);
  assert.equal(release.stillHeld(), true);

  fs.unlinkSync(lock);
  assert.equal(release.stillHeld(), false);

  const replacement = acquireLock(lock);
  assert.equal(release.stillHeld(), false, "the replacement owner is not us");
  replacement();
});

// A replacement owner can land on a recycled inode; rewriting the owner file in
// place reproduces that on any filesystem.
test("a replacement owner is not mistaken for us when the inode is recycled", () => {
  const lock = path.join(root, "recycled.lock");
  const release = acquireLock(lock);
  assert.equal(release.stillHeld(), true);
  const inode = fs.statSync(lock).ino;

  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  assert.equal(fs.statSync(lock).ino, inode, "same inode, different owner");
  assert.equal(release.stillHeld(), false, "ownership is by token, not inode");

  release();
  assert.equal(fs.existsSync(lock), true, "we must not unlink another owner's lock");
  fs.unlinkSync(lock);
});

// A dead owner is recovered at once, without waiting for the age backstop.
test("a crashed writer's fresh lock is recovered immediately without evicting a live owner", () => {
  const lock = path.join(root, "crashed.lock");
  require("node:child_process").execFileSync(process.execPath, ["-e", `
    require(${JSON.stringify(require.resolve("../lib/credential-lock"))})
      .acquireLock(${JSON.stringify(lock)});
  `]);
  const release = acquireLock(lock);
  assert.equal(typeof release, "function");
  try { assert.equal(acquireLock(lock), null); }
  finally { release(); }
  assert.equal(fs.existsSync(lock), false);
});

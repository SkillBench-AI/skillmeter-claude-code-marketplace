"use strict";
require("../testing/bootstrap");
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { acquireLock } = require("../scripts/lib/credential-lock");
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

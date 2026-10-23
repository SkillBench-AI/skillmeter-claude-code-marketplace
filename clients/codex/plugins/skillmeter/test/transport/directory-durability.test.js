"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeDurable } = require("../../scripts/lib/transcript-delta");

function setup(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-directory-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "state.json") };
}

test("Windows queue writes sync file data, skip unsupported directory opens and disclose the limit", t => {
  const { root, file } = setup(t, "win32");
  const open = fs.openSync, sync = fs.fsyncSync;
  let filesSynced = 0;
  t.mock.method(fs, "openSync", (target, flags, ...args) => {
    if (target === root) throw Object.assign(new Error("Windows cannot sync this directory handle"), { code: "EPERM" });
    return open(target, flags, ...args);
  });
  t.mock.method(fs, "fsyncSync", fd => { filesSynced++; return sync(fd); });
  const warnings = [];
  t.mock.method(console, "error", text => warnings.push(text));
  writeDurable(file, '{"generation":1}');
  writeDurable(file, '{"generation":2}');
  assert.equal(filesSynced, 2);
  assert.equal(JSON.parse(fs.readFileSync(file)).generation, 2);
  assert.deepEqual(fs.readdirSync(root), ["state.json"]);
  assert.equal(warnings.length, 1, "one diagnostic per process, not per queue file");
  assert.match(warnings[0], /Windows.*directory.*durability.*unconfirmed/);
});

test("Windows file sync errors still fail before replacing the destination", t => {
  const { file } = setup(t, "win32");
  fs.writeFileSync(file, "old");
  t.mock.method(fs, "fsyncSync", () => { throw Object.assign(new Error("file sync failed"), { code: "EIO" }); });
  assert.throws(() => writeDurable(file, "new"), { code: "EIO" });
  assert.equal(fs.readFileSync(file, "utf8"), "old");
});

test("supported platforms still surface post-rename directory sync failures", t => {
  const { root, file } = setup(t, "linux");
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (target, ...args) => {
    if (target === root) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
    return open(target, ...args);
  });
  assert.throws(() => writeDurable(file, "published"), { code: "EIO" });
  assert.equal(fs.readFileSync(file, "utf8"), "published");
});

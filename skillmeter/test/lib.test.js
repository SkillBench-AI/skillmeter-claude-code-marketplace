"use strict";

// Regression coverage for the shared leaf helpers introduced by the E-series
// dedup (lib/io.js) and the parametrized jwt expiry check (lib/jwt.js).
// Run: node --test skillmeter/test/lib.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const io = require("../scripts/lib/io");
const { isJwtExpired } = require("../scripts/lib/jwt");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skm-lib-"));
}

// --- io.safeReadJson -------------------------------------------------------

test("safeReadJson returns parsed content for valid JSON", () => {
  const d = tmp();
  const f = path.join(d, "x.json");
  fs.writeFileSync(f, JSON.stringify({ a: 1 }));
  assert.deepEqual(io.safeReadJson(f), { a: 1 });
});

test("safeReadJson returns the fallback on missing/malformed file", () => {
  const d = tmp();
  assert.equal(io.safeReadJson(path.join(d, "nope.json")), null);
  assert.deepEqual(io.safeReadJson(path.join(d, "nope.json"), {}), {});
  const bad = path.join(d, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.deepEqual(io.safeReadJson(bad, { fb: true }), { fb: true });
});

// --- io.atomicWriteJson ----------------------------------------------------

test("atomicWriteJson writes JSON that safeReadJson round-trips", () => {
  const d = tmp();
  const f = path.join(d, "nested", "out.json");
  io.atomicWriteJson(f, { hello: "world" });
  assert.deepEqual(io.safeReadJson(f), { hello: "world" });
});

// --- io.findGitRoot --------------------------------------------------------

test("findGitRoot walks up to the .git marker and returns '' outside a repo", () => {
  const d = tmp();
  const nested = path.join(d, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(d, ".git"));
  // findGitRoot uses path.resolve (not realpath), matching how the callers pass
  // cwd through; compare against the resolved dir, not its symlink-resolved form.
  assert.equal(io.findGitRoot(nested), path.resolve(d));
  assert.equal(io.findGitRoot(""), "");

  const orphan = tmp(); // fresh tmp dir with no .git up its (short) chain
  // Not asserting a specific value for orphan since tmp may sit under a repo on
  // some machines; just assert the type contract.
  assert.equal(typeof io.findGitRoot(orphan), "string");
});

// --- jwt.isJwtExpired (parametrized) ---------------------------------------

const mkJwt = (expOffsetSec) =>
  "h." +
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec })).toString("base64") +
  ".s";

test("isJwtExpired default: missing token is NOT expired", () => {
  assert.equal(isJwtExpired(null), false);
  assert.equal(isJwtExpired(undefined), false);
});

test("isJwtExpired treatMissingAsExpired: missing token IS expired", () => {
  assert.equal(isJwtExpired(null, { treatMissingAsExpired: true }), true);
  assert.equal(isJwtExpired("garbage", { treatMissingAsExpired: true }), true);
});

test("isJwtExpired honors skewSeconds", () => {
  const t = mkJwt(60); // expires in 60s
  assert.equal(isJwtExpired(t, { skewSeconds: 30 }), false); // 60 > 30 → valid
  assert.equal(isJwtExpired(t, { skewSeconds: 300 }), true); // 60 < 300 → expired proactively
});

test("isJwtExpired: a long-lived token is never expired", () => {
  assert.equal(isJwtExpired(mkJwt(3600)), false);
});

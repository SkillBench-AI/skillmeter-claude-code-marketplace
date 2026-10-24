"use strict";
// Helpers for the shared-module tests. They load shared/lib directly and no
// client code.
const { after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeTempDir(prefix = "skillmeter-shared-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(filePath, contents = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

// An unsigned token with the given claims; clients never verify signatures.
function makeJwt(payload) {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function setTestEnv(name, value) {
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  after(() => {
    if (hadValue) process.env[name] = previous;
    else delete process.env[name];
  });
}

module.exports = { makeTempDir, writeFile, makeJwt, setTestEnv };

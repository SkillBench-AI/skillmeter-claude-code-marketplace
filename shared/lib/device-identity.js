"use strict";

/**
 * The device identity every SkillMeter client on a machine shares (ADR 005):
 * `device_id` and `hash_salt` in credentials.json. Each client keeps its own
 * session and license elsewhere; fields other clients own in credentials.json
 * are preserved and never read.
 *
 * Read from disk on every call, so a process sees an identity another process
 * created meanwhile.
 */

const crypto = require("crypto");
const { readObject, mutateFile } = require("./store-file");

const credentialsFile = () => require("./config").credentialsFile();

// Create a missing field under the lock. On lock timeout, re-read: a
// concurrent process may have created it.
function ensureIdentityField(key, create) {
  const existing = readObject(credentialsFile())[key];
  if (existing) return existing;
  let value;
  try {
    mutateFile(credentialsFile(), (store) => {
      if (!store[key]) store[key] = create();
      value = store[key];
    });
  } catch (err) {
    if (err && err.message === "credential-store-busy") {
      const fresh = readObject(credentialsFile())[key];
      if (fresh) return fresh;
    }
    throw err;
  }
  return value;
}

// The device id, created on first use: an upper-case UUID.
const getDeviceId = () => ensureIdentityField("device_id", () => crypto.randomUUID().toUpperCase());
// The salt for device-local hashes, created on first use: 16 random bytes, hex.
const getOrCreateHashSalt = () => ensureIdentityField("hash_salt", () => crypto.randomBytes(16).toString("hex"));
// The device id or salt without creating one.
const readDeviceId = () => readObject(credentialsFile()).device_id || null;
const readHashSalt = () => readObject(credentialsFile()).hash_salt || "";

module.exports = { getDeviceId, getOrCreateHashSalt, readDeviceId, readHashSalt };

"use strict";
// Constants shared by the sanitizer tests. Every credential is synthetic.
const os = require("node:os");
const path = require("node:path");
const { POLICY_VERSION } = require(path.join(__dirname, "..", "plugins", "skillmeter", "scripts", "lib", "sanitize.js"));

const SALT = "deadbeefcafe";
const HEX = "[0-9a-f]{12}";
const HOME = os.homedir();
// A home directory at the filesystem root has no prefix to hash.
const HOME_DEPENDENT = HOME === "/" || HOME === "" ? { skip: "home directory is the filesystem root" } : {};

// Synthetic credentials, shared with the shared-module tests.
const { hi, SAMPLES } = require(path.join(__dirname, "..", "..", "..", "shared", "test", "samples.js"));

module.exports = { SALT, HEX, HOME, HOME_DEPENDENT, hi, SAMPLES, POLICY_VERSION };

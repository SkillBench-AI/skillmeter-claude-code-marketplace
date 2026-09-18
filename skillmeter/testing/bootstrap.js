"use strict";

/**
 * Load before scripts/ modules; testing/helpers imports this automatically.
 * Force CLAUDE_PLUGIN_DATA to a fresh temporary directory so inherited settings
 * cannot point tests at real queues. Tests may then select their own temp root.
 */

const { after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skm-test-plugin-data-"));
process.env.CLAUDE_PLUGIN_DATA = dataRoot;

after(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

module.exports = { TEST_PLUGIN_DATA_ROOT: dataRoot };

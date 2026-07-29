"use strict";

/**
 * Test bootstrap — MUST be loaded before any `scripts/` module.
 *
 * CLAUDE_PLUGIN_DATA is mandatory at runtime (lib/paths.js throws without it),
 * so every test process needs one. It is forced to a fresh temp dir rather than
 * merely defaulted: a developer or CI runner with the variable already exported
 * for a real plugin would otherwise have the suite read and write that real
 * plugin data directory. Individual tests may still point it at their own dir
 * via setTestEnv after this module has loaded.
 *
 * Requiring `testing/helpers` pulls this in, so only test files that use no
 * helpers need to require it directly.
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

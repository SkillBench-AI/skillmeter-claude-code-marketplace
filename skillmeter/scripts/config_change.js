#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("ConfigChange", (input) => ({
  source: input.source,
  file_path: input.file_path,
})).catch(() => process.exit(1));

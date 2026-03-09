#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("WorktreeCreate", (input) => ({
  name: input.name,
})).catch(() => process.exit(1));

#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PostCompact", (input) => ({
  trigger: input.trigger,
})).catch(() => process.exit(1));

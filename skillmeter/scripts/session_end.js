#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("SessionEnd", (input) => ({
  reason: input.reason,
})).catch(() => process.exit(1));

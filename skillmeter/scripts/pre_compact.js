#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PreCompact", (input) => ({
  trigger: input.trigger,
  custom_instructions: input.custom_instructions,
})).catch(() => process.exit(1));

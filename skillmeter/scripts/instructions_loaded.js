#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("InstructionsLoaded", (input) => ({
  file_path: input.file_path,
  memory_type: input.memory_type,
  load_reason: input.load_reason,
})).catch(() => process.exit(1));

#!/usr/bin/env node
const { runHook } = require("./logger.js");

// Pair with PreCompact (pre_compact.js). Together they measure compaction
// duration and frequency — a proxy for "this session hit the context wall".
runHook("PostCompact", (input) => ({
  trigger: input.trigger,
  custom_instructions: input.custom_instructions,
})).catch(() => process.exit(1));

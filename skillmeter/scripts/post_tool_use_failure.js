#!/usr/bin/env node
const { runHook } = require("./logger.js");

// Raw fields; runHook's central boundary hashes paths and redacts secrets/PII.
runHook("PostToolUseFailure", (input) => ({
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  tool_use_id: input.tool_use_id,
  error: input.error,
  is_interrupt: input.is_interrupt,
})).catch(() => process.exit(1));

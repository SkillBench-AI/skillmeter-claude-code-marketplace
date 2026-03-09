#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PostToolUseFailure", (input, { sanitizeToolData, hashSalt }) => ({
  tool_name: input.tool_name,
  tool_input: sanitizeToolData(input.tool_input, hashSalt),
  tool_use_id: input.tool_use_id,
  error: input.error,
  is_interrupt: input.is_interrupt,
})).catch(() => process.exit(1));

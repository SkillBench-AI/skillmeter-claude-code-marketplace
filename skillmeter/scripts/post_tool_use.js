#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PostToolUse", (input, { sanitizeToolData, hashSalt }) => ({
  tool_name: input.tool_name,
  tool_input: sanitizeToolData(input.tool_input, hashSalt),
  tool_response: sanitizeToolData(input.tool_response, hashSalt),
  tool_use_id: input.tool_use_id,
})).catch(() => process.exit(1));

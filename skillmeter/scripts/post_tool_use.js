#!/usr/bin/env node
const { runHook } = require("./logger.js");

// tool_input/tool_response are returned raw; runHook's central sanitizeEventData
// boundary HMAC-hashes path-bearing keys and redacts secrets/PII (incl. nested).
runHook("PostToolUse", (input) => ({
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  tool_response: input.tool_response,
  tool_use_id: input.tool_use_id,
})).catch(() => process.exit(1));

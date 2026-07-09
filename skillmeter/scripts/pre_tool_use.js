#!/usr/bin/env node
const { runHook } = require("./logger.js");

// tool_input is returned raw; runHook's central sanitizeEventData boundary
// HMAC-hashes path-bearing keys and redacts secrets/PII (incl. nested fields).
runHook("PreToolUse", (input) => ({
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  tool_use_id: input.tool_use_id,
})).catch(() => process.exit(1));

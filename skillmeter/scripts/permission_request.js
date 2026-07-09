#!/usr/bin/env node
const { runHook } = require("./logger.js");

// Raw fields; runHook's central boundary hashes paths and redacts secrets/PII.
runHook("PermissionRequest", (input) => ({
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  tool_use_id: input.tool_use_id,
})).catch(() => process.exit(1));

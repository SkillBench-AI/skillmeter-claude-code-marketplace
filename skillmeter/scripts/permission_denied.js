#!/usr/bin/env node
const { runHook } = require("./logger.js");

// PermissionDenied fires when the auto-mode classifier rejects a tool call.
// Returning {retry: true} would tell the model it may retry the denied call —
// we don't, since this is observation-only for telemetry. tool_input is returned
// raw; runHook's central boundary hashes paths and redacts secrets/PII.
runHook("PermissionDenied", (input) => ({
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  tool_use_id: input.tool_use_id,
})).catch(() => process.exit(1));

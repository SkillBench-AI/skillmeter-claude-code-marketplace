#!/usr/bin/env node
const { runHook } = require("./logger.js");

// PermissionDenied fires when the auto-mode classifier rejects a tool call.
// Returning {retry: true} would tell the model it may retry the denied call —
// we don't, since this is observation-only for telemetry. tool_input paths
// get the same HMAC hashing treatment as pre_tool_use.js.
runHook("PermissionDenied", (input, { sanitizeToolData, hashSalt }) => ({
  tool_name: input.tool_name,
  tool_input: sanitizeToolData(input.tool_input, hashSalt),
  tool_use_id: input.tool_use_id,
})).catch(() => process.exit(1));

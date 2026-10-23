#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PermissionRequest", (input) => ({
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  // Codex's tool_input.description is occasionally a free-form approval
  // reason. It can echo command text containing secrets, so it is copied
  // through here and scrubbed of secrets and stage-1 PII by the central
  // sanitizeEventData boundary in runHook before upload.
  description: input.tool_input && input.tool_input.description,
})).catch(() => process.exit(1));

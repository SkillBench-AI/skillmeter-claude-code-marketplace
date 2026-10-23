#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("PreToolUse", (input) => ({
  tool_name: input.tool_name,
  tool_use_id: input.tool_use_id,
  tool_input: input.tool_input,
})).catch(() => process.exit(1));

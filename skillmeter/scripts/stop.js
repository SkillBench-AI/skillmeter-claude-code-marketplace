#!/usr/bin/env node
const { runHook, flushAndTransfer } = require("./logger.js");

runHook("Stop", (input) => ({
  stop_hook_active: input.stop_hook_active,
  last_assistant_message: input.last_assistant_message,
}), {
  afterLog: flushAndTransfer,
}).catch(() => process.exit(1));

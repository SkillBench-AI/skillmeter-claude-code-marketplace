#!/usr/bin/env node
const { runHook } = require("./logger.js");
const { sealEventLogAndTriggerDrain, sealFinalSessionArtifacts } = require("./lib/transfer");

runHook("Stop", (input) => ({
  stop_hook_active: input.stop_hook_active,
  last_assistant_message: input.last_assistant_message,
}), {
  afterSkip: sealEventLogAndTriggerDrain,
  afterLog: sealFinalSessionArtifacts,
}).catch(() => process.exit(1));

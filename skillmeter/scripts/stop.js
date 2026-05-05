#!/usr/bin/env node
const { runHook, sealEventLogAndTriggerDrain, sealFinalSessionArtifacts } = require("./logger.js");

runHook("Stop", (input) => ({
  stop_hook_active: input.stop_hook_active,
  last_assistant_message: input.last_assistant_message,
}), {
  afterSkip: sealEventLogAndTriggerDrain,
  afterLog: sealFinalSessionArtifacts,
}).catch(() => process.exit(1));

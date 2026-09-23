#!/usr/bin/env node
const { runHook } = require("./logger.js");
const { requestLicenseRecovery } = require("./lib/hook-license-recovery");
const {
  discardSkippedSessionArtifacts,
  sealFinalSessionArtifacts,
} = require("./lib/transfer");

runHook("Stop", (input) => ({
  stop_hook_active: input.stop_hook_active,
  last_assistant_message: input.last_assistant_message,
}), {
  afterSkip: discardSkippedSessionArtifacts,
  afterLog: sealFinalSessionArtifacts,
  afterComplete: requestLicenseRecovery,
}).catch(() => process.exit(1));

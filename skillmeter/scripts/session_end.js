#!/usr/bin/env node
const { runHook } = require("./logger.js");
const {
  discardSkippedSessionArtifacts,
  sealFinalSessionArtifacts,
} = require("./lib/transfer");
const { clearSessionCwdContext } = require("./lib/cwd-context");
const credstore = require("./credstore");

function clearSessionContext(input) {
  clearSessionCwdContext(input?.session_id, credstore.getHashSalt());
}

// Seal and stage locally, then start a detached drain so network waits do not
// consume the SessionEnd hook timeout. Startup and monitor retries remain available.
runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterSkip: discardSkippedSessionArtifacts,
  afterLog: sealFinalSessionArtifacts,
  afterComplete: clearSessionContext,
}).catch(() => process.exit(1));

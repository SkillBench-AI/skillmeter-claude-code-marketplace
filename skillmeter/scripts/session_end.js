#!/usr/bin/env node
const { runHook } = require("./logger.js");
const { sealEventLogAndDrain, sealFinalSessionArtifactsAndDrain } = require("./lib/transfer");

runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterSkip: sealEventLogAndDrain,
  afterLog: sealFinalSessionArtifactsAndDrain,
  awaitAfterSkip: true,
  awaitAfterLog: true,
}).catch(() => process.exit(1));

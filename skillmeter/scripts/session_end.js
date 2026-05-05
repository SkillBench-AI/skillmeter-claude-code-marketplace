#!/usr/bin/env node
const { runHook, sealEventLogAndDrain, sealFinalSessionArtifactsAndDrain } = require("./logger.js");

runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterSkip: sealEventLogAndDrain,
  afterLog: sealFinalSessionArtifactsAndDrain,
  awaitAfterSkip: true,
  awaitAfterLog: true,
}).catch(() => process.exit(1));

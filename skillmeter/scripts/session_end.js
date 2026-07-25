#!/usr/bin/env node
const { runHook } = require("./logger.js");
const {
  discardSkippedSessionArtifacts,
  sealFinalSessionArtifacts,
} = require("./lib/transfer");

// Non-blocking: seal + stage, then spawn a DETACHED drain that outlives this
// exiting hook (same as the Stop hook). At session exit the hook must return
// well within its `timeout`; an inline awaited network drain risked exceeding
// the budget and getting cancelled ("Hook cancelled"), and could keep the
// process alive on a pending fetch. The detached child + SessionStart/monitor
// retry still deliver the queued artifacts.
runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterSkip: discardSkippedSessionArtifacts,
  afterLog: sealFinalSessionArtifacts,
}).catch(() => process.exit(1));

#!/usr/bin/env node
const { runHook, flushAndTransfer, flushEventLog } = require("./logger.js");

runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterSkip: flushEventLog,
  afterLog: flushAndTransfer,
}).catch(() => process.exit(1));

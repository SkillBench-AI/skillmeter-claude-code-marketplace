#!/usr/bin/env node
const { runHook, flushAndTransfer } = require("./logger.js");

runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterLog: flushAndTransfer,
}).catch(() => process.exit(1));

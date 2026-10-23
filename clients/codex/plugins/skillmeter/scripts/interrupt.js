#!/usr/bin/env node
// Shutdown has a three-second ceiling. runHook saves only a capture hint and
// event metadata; transcript reads, compression and uploads are detached.
const { runHook, flushAndTransfer } = require("./logger");
runHook("Interrupt", input => ({ reason: input.reason, turn_id: input.turn_id }), {
  requireJsonStdout: true,
  afterLog: input => flushAndTransfer(input),
}).catch(() => { process.stdout.write("{}\n"); process.exitCode = 1; });

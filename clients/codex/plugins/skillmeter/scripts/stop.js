#!/usr/bin/env node
// Codex requires `Stop` hooks to emit JSON on stdout when they exit 0; plain
// text is treated as invalid. runHook handles that via requireJsonStdout so we
// always emit `{}` on every exit path.
const {
  runHook,
  flushAndTransfer,
} = require("./logger.js");

runHook(
  "Stop",
  (input) => ({
    stop_hook_active: input.stop_hook_active,
    last_assistant_message: input.last_assistant_message,
  }),
  {
    requireJsonStdout: true,
    // Seal the durable queues and hand uploads to a detached drain so the hook
    // returns quickly instead of blocking on network I/O.
    afterLog: (input) => flushAndTransfer(input),
  }
).catch(() => {
  try { process.stdout.write("{}\n"); } catch {}
  process.exit(1);
});

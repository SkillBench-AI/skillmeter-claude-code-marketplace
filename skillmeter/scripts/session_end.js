#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const { runHook, PLUGIN_ROOT } = require("./logger.js");

const TRANSFER_TRANSCRIPT_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "transfer_transcript.js");

runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterLog: (input, deviceId) => {
    if (input.transcript_path && fs.existsSync(input.transcript_path)) {
      spawn("node", [TRANSFER_TRANSCRIPT_SCRIPT, input.transcript_path, deviceId], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  },
}).catch(() => process.exit(1));

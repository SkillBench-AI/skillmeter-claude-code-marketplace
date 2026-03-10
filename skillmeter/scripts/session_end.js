#!/usr/bin/env node
const fs = require("fs");
const { runHook, transferEventLog, transferTranscript, LOG_FILE } = require("./logger.js");

runHook("SessionEnd", (input) => ({
  reason: input.reason,
}), {
  afterLog: (input, deviceId) => {
    // Transfer event log
    if (fs.existsSync(LOG_FILE)) {
      try {
        const sendingFile = `${LOG_FILE}.${Date.now()}`;
        fs.renameSync(LOG_FILE, sendingFile);
        transferEventLog(sendingFile);
      } catch {
        // Ignore errors (file might have been renamed by another session)
      }
    }

    // Transfer transcript
    if (input.transcript_path && fs.existsSync(input.transcript_path)) {
      transferTranscript(input.transcript_path, deviceId);
    }
  },
}).catch(() => process.exit(1));

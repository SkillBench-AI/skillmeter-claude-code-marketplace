#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const { runHook, PLUGIN_ROOT, LOG_FILE } = require("./logger.js");

const TRANSFER_EVENT_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "transfer_event.js");

runHook("Stop", (input) => ({
  stop_hook_active: input.stop_hook_active,
  last_assistant_message: input.last_assistant_message,
}), {
  afterLog: () => {
    if (fs.existsSync(LOG_FILE) && fs.existsSync(TRANSFER_EVENT_SCRIPT)) {
      try {
        const sendingFile = `${LOG_FILE}.${Date.now()}`;
        fs.renameSync(LOG_FILE, sendingFile);
        spawn("node", [TRANSFER_EVENT_SCRIPT, sendingFile], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch {
        // Ignore errors (file might have been renamed by another session)
      }
    }
  },
}).catch(() => process.exit(1));

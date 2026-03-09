#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { runHook, retryFailedLogs, getTelemetryOptIn, promptTelemetryOptIn, PLUGIN_ROOT } = require("./logger.js");

const pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
const VERSION = pluginJson.version || "unknown";

runHook("SessionStart", (input) => ({
  source: input.source,
  model: input.model,
  agent_type: input.agent_type,
}), {
  beforeStdin: () => retryFailedLogs(),
  checkOptIn: (cwd) => {
    let optIn = getTelemetryOptIn(cwd);
    if (optIn === null) optIn = promptTelemetryOptIn(cwd);
    if (optIn) {
      process.stderr.write(`SkillMeter v${VERSION} (activated)\n`);
    } else {
      process.stderr.write(`SkillMeter v${VERSION} (not activated)\n`);
    }
    return optIn;
  },
}).catch(() => process.exit(1));

#!/usr/bin/env node
const { runHook, retryFailedLogs, getTelemetryOptIn, promptTelemetryOptIn, PLUGIN_VERSION } = require("./logger.js");

runHook("SessionStart", (input) => ({
  source: input.source,
  model: input.model,
  agent_type: input.agent_type,
}), {
  checkOptIn: (cwd) => {
    let optIn = getTelemetryOptIn(cwd);
    if (optIn === null) optIn = promptTelemetryOptIn(cwd);
    if (optIn) {
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (activated)\n`);
      retryFailedLogs();
    } else {
      process.stderr.write(`SkillMeter v${PLUGIN_VERSION} (not activated)\n`);
    }
    return optIn;
  },
}).catch(() => process.exit(1));

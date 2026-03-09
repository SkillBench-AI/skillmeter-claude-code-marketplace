#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("SubagentStart", (input) => ({
  agent_id: input.agent_id,
  agent_type: input.agent_type,
})).catch(() => process.exit(1));

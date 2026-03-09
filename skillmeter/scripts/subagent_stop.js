#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("SubagentStop", (input, { getTranscriptId }) => ({
  stop_hook_active: input.stop_hook_active,
  agent_id: input.agent_id,
  agent_type: input.agent_type,
  agent_transcript_path: getTranscriptId(input.agent_transcript_path),
  last_assistant_message: input.last_assistant_message,
})).catch(() => process.exit(1));

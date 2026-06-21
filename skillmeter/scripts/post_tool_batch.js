#!/usr/bin/env node
// PostToolBatch fires once after a full batch of parallel tool calls resolves,
// before the next model call. PostToolUse already captures each call's full
// detail, so this handler records only batch-shape signal: how many tools ran
// together and which ones. That parallelism/batch-size metric isn't observable
// from the per-tool events. We intentionally do NOT include tool_response here
// (it carries the large serialized tool_result content; per-call payloads live
// in PostToolUse).
const { runHook } = require("./logger.js");

runHook("PostToolBatch", (input) => {
  const calls = Array.isArray(input.tool_calls) ? input.tool_calls : [];
  return {
    batch_size: calls.length,
    tool_names: calls.map((c) => c && c.tool_name).filter(Boolean),
    tool_use_ids: calls.map((c) => c && c.tool_use_id).filter(Boolean),
  };
}).catch(() => process.exit(1));

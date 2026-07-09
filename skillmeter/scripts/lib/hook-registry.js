/**
 * Hook field-mapper registry.
 *
 * Most hooks are pure "pick a few fields off the input" mappers with no side
 * effects — historically one ~8-line file each. They're consolidated here as a
 * single table keyed by hook event name; scripts/hook.js is the generic
 * entrypoint that looks up the mapper and hands it to logger.runHook. Adding a
 * new observation-only hook is now a one-line entry here plus a hooks.json line.
 *
 * Each mapper is `(input, ctx) => data`, exactly the `buildData` contract
 * runHook expects (ctx provides { hashSalt, cwd, getTranscriptId }). Payloads
 * are returned raw; runHook's central sanitizeEventData boundary HMAC-hashes
 * path-bearing keys (file_path / path / notebook_path / cwd) and redacts
 * secrets/PII. Field names track the current Claude Code hook input schema.
 *
 * Hooks that need runHook options (afterLog/afterSkip/onGate) or non-trivial
 * logic keep their own dedicated entrypoint and are intentionally absent here:
 * session_start, session_end, stop, on_signin_result, user_prompt_expansion_signin.
 */

module.exports = {
  UserPromptSubmit: (input) => ({
    prompt: input.prompt,
  }),

  Notification: (input) => ({
    message: input.message,
    notification_type: input.notification_type,
  }),

  // While assistant message text is displayed. The full text already lives in
  // the transcript, so record only the length here (a metric) to avoid
  // duplicating content and to keep this high-frequency event cheap.
  MessageDisplay: (input) => ({
    message_length: typeof input.message === "string" ? input.message.length : undefined,
  }),

  PreToolUse: (input) => ({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_use_id: input.tool_use_id,
  }),

  PostToolUse: (input) => ({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_response: input.tool_response,
    tool_use_id: input.tool_use_id,
  }),

  // Fires once after a batch of parallel tool calls resolves. PostToolUse already
  // captures each call's detail, so record only batch-shape signal (size + which
  // tools ran together); deliberately no tool_response (large serialized result).
  PostToolBatch: (input) => {
    const calls = Array.isArray(input.tool_calls) ? input.tool_calls : [];
    return {
      batch_size: calls.length,
      tool_names: calls.map((c) => c && c.tool_name).filter(Boolean),
      tool_use_ids: calls.map((c) => c && c.tool_use_id).filter(Boolean),
    };
  },

  PostToolUseFailure: (input) => ({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_use_id: input.tool_use_id,
    error: input.error,
    is_interrupt: input.is_interrupt,
  }),

  PermissionRequest: (input) => ({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_use_id: input.tool_use_id,
  }),

  // Fires when the auto-mode classifier rejects a tool call. Observation-only —
  // we never return {retry:true}.
  PermissionDenied: (input) => ({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_use_id: input.tool_use_id,
  }),

  // MCP server requests user input mid-tool-call. Capture what/who; tool_input
  // is path-hashed + secret-scrubbed centrally.
  Elicitation: (input) => ({
    server: input.server,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
  }),

  // After the user answers an MCP elicitation. The raw `user_response` is
  // deliberately NOT captured — it is arbitrary user-entered content (potential
  // PII) that adds little analytic value; record only which tool/server.
  ElicitationResult: (input) => ({
    server: input.server,
    tool_name: input.tool_name,
  }),

  SubagentStart: (input) => ({
    agent_id: input.agent_id,
    agent_type: input.agent_type,
  }),

  SubagentStop: (input, { getTranscriptId }) => ({
    stop_hook_active: input.stop_hook_active,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    agent_transcript_path: getTranscriptId(input.agent_transcript_path),
    last_assistant_message: input.last_assistant_message,
  }),

  // Turn ended on an API error. Observation-only; Claude Code ignores our output.
  StopFailure: (input) => ({
    error_type: input.error_type,
    error_message: input.error_message,
    last_assistant_message: input.last_assistant_message,
  }),

  TeammateIdle: (input) => ({
    agent_type: input.agent_type,
  }),

  // TaskCreated/TaskCompleted share task_id so the backend can compute task
  // lifetime by pairing create/complete timestamps.
  TaskCreated: (input) => ({
    task_id: input.task_id,
    task_description: input.task_description,
    task_metadata: input.task_metadata,
  }),

  TaskCompleted: (input) => ({
    task_id: input.task_id,
    task_description: input.task_description,
    completion_status: input.completion_status,
  }),

  InstructionsLoaded: (input) => ({
    file_path: input.file_path,
    load_reason: input.load_reason,
  }),

  ConfigChange: (input) => ({
    config_source: input.config_source,
  }),

  // Working directory changed. `path` is a PATH_KEY, so the central scrub
  // HMAC-hashes it (username/structure removed) before upload.
  CwdChanged: (input) => ({
    path: input.path,
  }),

  WorktreeCreate: (input) => ({
    worktree_name: input.worktree_name,
    worktree_path: input.worktree_path,
  }),

  WorktreeRemove: (input) => ({
    worktree_path: input.worktree_path,
  }),

  PreCompact: (input) => ({
    trigger: input.trigger,
    custom_instructions: input.custom_instructions,
  }),

  // Pairs with PreCompact to measure compaction duration/frequency.
  PostCompact: (input) => ({
    trigger: input.trigger,
    custom_instructions: input.custom_instructions,
  }),

  // Claude Code started with --init / --maintenance.
  Setup: (input) => ({
    setup_type: input.setup_type,
  }),
};

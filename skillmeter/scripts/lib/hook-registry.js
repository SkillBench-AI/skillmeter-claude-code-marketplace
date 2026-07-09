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
 * path-bearing keys and redacts secrets/PII.
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
    title: input.title,
    notification_type: input.notification_type,
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

  // Fires when a turn ends on an API error (rate_limit, auth, billing, etc.).
  // Observation-only; Claude Code ignores our output/exit code.
  StopFailure: (input) => ({
    error: input.error,
    error_details: input.error_details,
    last_assistant_message: input.last_assistant_message,
  }),

  TeammateIdle: (input) => ({
    teammate_name: input.teammate_name,
    team_name: input.team_name,
  }),

  // TaskCreated/TaskCompleted share a schema so the backend can compute task
  // lifetime by subtracting timestamps on matching task_id.
  TaskCreated: (input) => ({
    task_id: input.task_id,
    task_subject: input.task_subject,
    task_description: input.task_description,
    teammate_name: input.teammate_name,
    team_name: input.team_name,
  }),

  TaskCompleted: (input) => ({
    task_id: input.task_id,
    task_subject: input.task_subject,
    task_description: input.task_description,
    teammate_name: input.teammate_name,
    team_name: input.team_name,
  }),

  InstructionsLoaded: (input) => ({
    file_path: input.file_path,
    memory_type: input.memory_type,
    load_reason: input.load_reason,
  }),

  ConfigChange: (input) => ({
    source: input.source,
    file_path: input.file_path,
  }),

  WorktreeCreate: (input) => ({
    name: input.name,
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
};

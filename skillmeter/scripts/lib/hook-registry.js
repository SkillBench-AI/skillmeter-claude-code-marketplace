/**
 * Observation-hook field mappers: (input, ctx) => data.
 * runHook sanitizes returned fields before queueing. Hooks with lifecycle
 * callbacks or custom logic keep dedicated entrypoints.
 */

module.exports = {
  UserPromptSubmit: (input) => ({
    prompt: input.prompt,
  }),

  Notification: (input) => ({
    message: input.message,
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

  // MCP server requests user input mid-tool-call. Keep only structural
  // metadata; message/requested_schema/url may contain arbitrary user or server
  // content and are intentionally excluded.
  Elicitation: (input) => ({
    mcp_server_name: input.mcp_server_name,
    mode: input.mode,
    elicitation_id: input.elicitation_id,
  }),

  // After the user answers an MCP elicitation. The raw `content` is
  // deliberately NOT captured — it is arbitrary user-entered content.
  ElicitationResult: (input) => ({
    mcp_server_name: input.mcp_server_name,
    action: input.action,
    mode: input.mode,
    elicitation_id: input.elicitation_id,
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
    error: input.error,
    error_details: input.error_details,
    last_assistant_message: input.last_assistant_message,
  }),

  TeammateIdle: (input) => ({
    teammate_name: input.teammate_name,
    team_name: input.team_name,
  }),

  // TaskCreated/TaskCompleted share task_id so the backend can compute task
  // lifetime by pairing create/complete timestamps.
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
    load_reason: input.load_reason,
  }),

  ConfigChange: (input) => ({
    source: input.source,
    file_path: input.file_path,
  }),

  // Working directory changed. Both fields are PATH_KEYS, so the central scrub
  // HMAC-hashes them (username/structure removed) before upload.
  CwdChanged: (input) => ({
    old_cwd: input.old_cwd,
    new_cwd: input.new_cwd,
  }),

  // A working directory joined mid-session (/add-dir or the SDK
  // register_repo_root request). `directory` is a WHOLE_KEY, so the central
  // scrub hashes it the same way as old_cwd/new_cwd.
  DirectoryAdded: (input) => ({
    directory: input.directory,
    source: input.source,
  }),

  WorktreeRemove: (input) => ({
    worktree_path: input.worktree_path,
  }),

  PreCompact: (input) => ({
    trigger: input.trigger,
    custom_instructions: input.custom_instructions,
  }),

  // Pairs with PreCompact to measure compaction duration/frequency. The
  // official compact_summary field is conversation content and is excluded.
  PostCompact: (input) => ({
    trigger: input.trigger,
  }),

  // The session model changed mid-session (/model, or Claude Code restoring it
  // on resume). SessionStart records only the initial model, so this is what
  // keeps later turns attributable. PreModelSwitch is deliberately not used: it
  // is synchronous and a timed-out hook blocks the switch.
  PostModelSwitch: (input) => ({
    from_model: input.from_model,
    to_model: input.to_model,
  }),

  // Claude Code started with --init / --maintenance.
  Setup: (input) => ({
    trigger: input.trigger,
  }),
};

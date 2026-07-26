"use strict";

// Representative payloads based on the official Claude Code hooks reference:
// https://code.claude.com/docs/en/hooks
// Verified 2026-07-26. Keep the input shape aligned with the documented event
// schemas; expected contains only the fields SkillMeter intentionally records.

const common = {
  session_id: "abc123",
  transcript_path: "/Users/example/.claude/projects/example/transcript.jsonl",
  cwd: "/Users/example/project",
  permission_mode: "default",
};

const hookPayloadFixtures = [
  {
    event: "Setup",
    input: {
      ...common,
      hook_event_name: "Setup",
      trigger: "init",
    },
    expected: {
      trigger: "init",
    },
  },
  {
    event: "StopFailure",
    input: {
      ...common,
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: { retry_after_seconds: 30 },
      last_assistant_message: "API Error: Rate limit reached",
    },
    expected: {
      error: "rate_limit",
      error_details: { retry_after_seconds: 30 },
      last_assistant_message: "API Error: Rate limit reached",
    },
  },
  {
    event: "TeammateIdle",
    input: {
      ...common,
      hook_event_name: "TeammateIdle",
      teammate_name: "researcher",
      team_name: "session-a1b2c3d4",
    },
    expected: {
      teammate_name: "researcher",
      team_name: "session-a1b2c3d4",
    },
  },
  {
    event: "TaskCreated",
    input: {
      ...common,
      hook_event_name: "TaskCreated",
      task_id: "task-001",
      task_subject: "Implement authentication",
      task_description: "Add login and signup endpoints",
      teammate_name: "implementer",
      team_name: "my-project",
    },
    expected: {
      task_id: "task-001",
      task_subject: "Implement authentication",
      task_description: "Add login and signup endpoints",
      teammate_name: "implementer",
      team_name: "my-project",
    },
  },
  {
    event: "TaskCompleted",
    input: {
      ...common,
      hook_event_name: "TaskCompleted",
      task_id: "task-001",
      task_subject: "Implement authentication",
      task_description: "Add login and signup endpoints",
      teammate_name: "implementer",
      team_name: "my-project",
    },
    expected: {
      task_id: "task-001",
      task_subject: "Implement authentication",
      task_description: "Add login and signup endpoints",
      teammate_name: "implementer",
      team_name: "my-project",
    },
  },
  {
    event: "ConfigChange",
    input: {
      ...common,
      hook_event_name: "ConfigChange",
      source: "project_settings",
      file_path: "/Users/example/project/.claude/settings.json",
    },
    expected: {
      source: "project_settings",
      file_path: "/Users/example/project/.claude/settings.json",
    },
  },
  {
    event: "CwdChanged",
    input: {
      ...common,
      hook_event_name: "CwdChanged",
      old_cwd: "/Users/example/project",
      new_cwd: "/Users/example/project/src",
    },
    expected: {
      old_cwd: "/Users/example/project",
      new_cwd: "/Users/example/project/src",
    },
  },
  {
    event: "Elicitation",
    input: {
      ...common,
      hook_event_name: "Elicitation",
      mcp_server_name: "my-mcp-server",
      message: "Please provide your credentials",
      mode: "form",
      url: "https://auth.example.com/login",
      elicitation_id: "elicit-123",
      requested_schema: {
        type: "object",
        properties: {
          username: { type: "string" },
        },
      },
    },
    expected: {
      mcp_server_name: "my-mcp-server",
      mode: "form",
      elicitation_id: "elicit-123",
    },
  },
  {
    event: "ElicitationResult",
    input: {
      ...common,
      hook_event_name: "ElicitationResult",
      mcp_server_name: "my-mcp-server",
      action: "accept",
      content: { username: "alice" },
      mode: "form",
      elicitation_id: "elicit-123",
    },
    expected: {
      mcp_server_name: "my-mcp-server",
      action: "accept",
      mode: "form",
      elicitation_id: "elicit-123",
    },
  },
  {
    event: "PostCompact",
    input: {
      ...common,
      hook_event_name: "PostCompact",
      trigger: "manual",
      compact_summary: "Summary of the compacted conversation",
    },
    expected: {
      trigger: "manual",
    },
  },
];

module.exports = {
  hookPayloadFixtures,
};

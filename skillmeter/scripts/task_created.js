#!/usr/bin/env node
const { runHook } = require("./logger.js");

// Pair with TaskCompleted (task_completed.js). Together they let the backend
// compute task lifetime by subtracting timestamps on matching task_id.
// Schema mirrors task_completed.js so the two events share attributes.
runHook("TaskCreated", (input) => ({
  task_id: input.task_id,
  task_subject: input.task_subject,
  task_description: input.task_description,
  teammate_name: input.teammate_name,
  team_name: input.team_name,
})).catch(() => process.exit(1));

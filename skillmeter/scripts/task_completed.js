#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("TaskCompleted", (input) => ({
  task_id: input.task_id,
  task_subject: input.task_subject,
  task_description: input.task_description,
  teammate_name: input.teammate_name,
  team_name: input.team_name,
})).catch(() => process.exit(1));

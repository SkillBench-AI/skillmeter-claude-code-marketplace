#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("WorktreeRemove", (input) => ({
  worktree_path: input.worktree_path,
})).catch(() => process.exit(1));

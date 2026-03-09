#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("UserPromptSubmit", (input) => ({
  prompt: input.prompt,
})).catch(() => process.exit(1));

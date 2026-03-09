#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("TeammateIdle", (input) => ({
  teammate_name: input.teammate_name,
  team_name: input.team_name,
})).catch(() => process.exit(1));

#!/usr/bin/env node
/**
 * Dispatch observation hooks through lib/hook-registry.js.
 * Hooks needing lifecycle callbacks or custom logic use dedicated entrypoints.
 */
const { runHook } = require("./logger.js");
const registry = require("./lib/hook-registry.js");

const event = process.argv[2];
const buildData = registry[event];
if (typeof buildData !== "function") {
  process.stderr.write(`[skillmeter] hook.js: no registry entry for "${event}"\n`);
  process.exit(1);
}

runHook(event, buildData).catch(() => process.exit(1));

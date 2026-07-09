#!/usr/bin/env node
/**
 * Generic hook entrypoint. hooks.json invokes this as
 * `node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.js <EventName>` for every
 * observation-only hook; the per-event field mapper lives in
 * lib/hook-registry.js. Hooks needing runHook options or custom logic keep
 * their own dedicated entrypoint instead.
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

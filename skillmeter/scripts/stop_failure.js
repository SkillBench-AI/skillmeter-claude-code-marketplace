#!/usr/bin/env node
const { runHook } = require("./logger.js");

// StopFailure fires when a turn ends due to an API error (rate_limit,
// authentication_failed, billing_error, invalid_request, server_error,
// max_output_tokens, unknown). Observation-only on our side — the event
// is captured for friction/error analytics, we don't try to recover.
runHook("StopFailure", (input) => ({
  error_type: input.error_type,
  error_message: input.error_message,
})).catch(() => process.exit(1));

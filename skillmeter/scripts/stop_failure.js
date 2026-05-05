#!/usr/bin/env node
const { runHook } = require("./logger.js");

// StopFailure fires when a turn ends due to an API error (rate_limit,
// authentication_failed, oauth_org_not_allowed, billing_error, invalid_request,
// server_error, max_output_tokens, unknown). Observation-only on our side —
// output and exit code are ignored by Claude Code.
runHook("StopFailure", (input) => ({
  error: input.error,
  error_details: input.error_details,
  last_assistant_message: input.last_assistant_message,
})).catch(() => process.exit(1));

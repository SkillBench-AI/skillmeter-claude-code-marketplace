#!/bin/bash

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

# Log user prompt submission
# STDIN contains the user prompt when available
if [ -t 0 ]; then
    log_event "UserPromptSubmit" "User submitted a prompt"
else
    # Read the prompt from stdin if available
    prompt_preview=$(head -c 1000)
    log_with_context "UserPromptSubmit" "User submitted prompt" "${prompt_preview}"
fi

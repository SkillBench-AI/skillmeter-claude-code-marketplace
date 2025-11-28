#!/bin/bash

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

# Log stop event
log_event "SessionStop" "Stop script executed"
log_event "SessionStop" "Performing cleanup operations"
log_event "SessionStop" "Session terminated"

#!/bin/bash

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

# Log pre-tool use event for Edit/Write operations
# STDIN contains tool use information in JSON format
if [ -t 0 ]; then
    log_event "PreToolUse" "Edit/Write tool about to be used"
else
    # Read tool info from stdin
    tool_info=$(cat)
    tool_name=$(echo "$tool_info" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
    log_with_context "PreToolUse" "Tool invoked" "Tool: ${tool_name}"
fi
    
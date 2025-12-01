#!/bin/bash

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

if [ -t 0 ]; then
    log_event "PreToolUse" "Interactive Mode (No Input)"
else
    # 1. Read JSON tool info from stdin
    tool_info=$(cat)

    # 2. Extract Tool Name
    tool_name=$(echo "$tool_info" | jq -r '.tool_name // "Unknown"')

    # 3. Extract File Path
    target_file=$(echo "$tool_info" | jq -r '.tool_input.file_path // empty')

    # 4. Log with context
    if [ -n "$target_file" ]; then
        log_with_context "PreToolUse" "Tool invoked" "Tool: ${tool_name}, File: ${target_file}"
    else
        log_with_context "PreToolUse" "Tool invoked" "Tool: ${tool_name}"
    fi
fi
#!/bin/bash

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

if [ -t 0 ]; then
    log_event "PreToolUse" "Interactive Mode (No Input)"
else
    # 1. Read JSON tool info from stdin
    tool_info=$(cat)

    # 2. Extract Tool Name
    # 변경사항: .name -> .tool_name
    tool_name=$(echo "$tool_info" | jq -r '.tool_name // "Unknown"')

    # 3. Extract File Path
    # 변경사항: .input.path -> .tool_input.file_path
    # 혹시 모를 경우를 대비해 .tool_input.path도 확인하도록 fallback 추가
    target_file=$(echo "$tool_info" | jq -r '.tool_input.file_path // .tool_input.path // empty')

    # 4. Log with context
    if [ -n "$target_file" ]; then
        log_with_context "PreToolUse" "Tool invoked" "Tool: ${tool_name}, File: ${target_file}"
    else
        log_with_context "PreToolUse" "Tool invoked" "Tool: ${tool_name}"
    fi
fi
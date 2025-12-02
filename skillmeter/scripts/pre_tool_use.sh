#!/bin/bash
# PreToolUse hook - Logs tool invocations with privacy-preserving hashing
# Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id

set -euo pipefail

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

# Exit if no stdin
[ -t 0 ] && exit 0

# Read input once
input=$(cat)

# Extract session_id (required field)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')

# Extract and hash file_path if present in tool_input
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [ -n "$file_path" ]; then
    # Hash the file path for privacy (first 16 chars of SHA256)
    file_hash=$(hash_sha256 "$file_path")
    # Build data object with only file_path in tool_input
    data=$(echo "$input" | jq -c --arg hash "$file_hash" '{
        permission_mode: .permission_mode,
        tool_name: .tool_name,
        tool_input: {file_path: $hash},
        tool_use_id: .tool_use_id
    }')
else
    # Build data object without tool_input (no file_path to log)
    data=$(echo "$input" | jq -c '{
        permission_mode: .permission_mode,
        tool_name: .tool_name,
        tool_input: {},
        tool_use_id: .tool_use_id
    }')
fi

# Log the event
log_info "PreToolUse" "$session_id" "$data"

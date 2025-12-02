#!/bin/bash
# UserPromptSubmit hook - Logs user prompt submissions with privacy-preserving hashing
# Input schema: session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt

set -euo pipefail

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

# Exit if no stdin
[ -t 0 ] && exit 0

# Read input once
input=$(cat)

# Extract session_id (required field)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')

# Extract and hash transcript_path if present
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')

if [ -n "$transcript_path" ]; then
    # Hash the transcript path for privacy (first 16 chars of SHA256)
    transcript_hash=$(hash_sha256 "$transcript_path")
    # Build data object with hashed transcript_path
    data=$(echo "$input" | jq -c --arg hash "$transcript_hash" '{
        transcript_path: $hash,
        permission_mode: .permission_mode,
        prompt: .prompt
    }')
else
    # Build data object without transcript_path
    data=$(echo "$input" | jq -c '{
        permission_mode: .permission_mode,
        prompt: .prompt
    }')
fi

# Log the event
log_info "UserPromptSubmit" "$session_id" "$data"

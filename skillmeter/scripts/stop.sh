#!/bin/bash
# Stop hook - Logs when Claude is interrupted/stopped
# Expected input JSON structure:
# {
#   "session_id": "abc123",
#   "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
#   "permission_mode": "default",
#   "hook_event_name": "Stop",
#   "stop_hook_active": true
# }

set -euo pipefail

# Source the logging utility
source "${CLAUDE_PLUGIN_ROOT}/scripts/logger.sh"

# Exit if no stdin
[ -t 0 ] && exit 0

# Read input once
input=$(cat)

# Extract session_id (required field)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')

# Extract stop metadata
data=$(echo "$input" | jq -c '{
  transcript_path: .transcript_path,
  permission_mode: .permission_mode,
  stop_hook_active: .stop_hook_active
}')

# Log the event
log_info "Stop" "$session_id" "$data"

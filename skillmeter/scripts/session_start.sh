#!/bin/bash
# SessionStart hook - Logs session start events
# Expected input JSON structure:
# {
#   "session_id": "abc123",
#   "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
#   "permission_mode": "default",
#   "hook_event_name": "SessionStart",
#   "source": "startup"
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

# Extract session metadata
data=$(echo "$input" | jq -c '{
  permission_mode: .permission_mode,
  source: .source
}')

# Log the event
log_info "SessionStart" "$session_id" "$data"

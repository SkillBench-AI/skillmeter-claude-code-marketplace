#!/bin/bash

# Enhanced structured logging utility for skillmeter hooks
# Outputs NDJSON (newline-delimited JSON) for easy backend parsing
# Usage: source logger.sh && log_event "EventName" "message" [data]

# Define log file location and rotation settings
LOG_DIR="${CLAUDE_PLUGIN_ROOT}/logs"
LOG_FILE="${LOG_DIR}/events.log"
MAX_EVENTS=50
TRANSFER_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/transfer_log.sh"
UUID_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/get_uuid.sh"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Source UUID script and cache device ID (skip logging if unavailable)
DEVICE_ID=""
if [ -f "$UUID_SCRIPT" ]; then
    source "$UUID_SCRIPT"
    DEVICE_ID=$(get_or_create_uuid)
fi

# Get ISO 8601 timestamp with milliseconds
get_timestamp() {
    if date --version &>/dev/null; then
        # GNU date (Linux)
        date -u '+%Y-%m-%dT%H:%M:%S.%3NZ'
    else
        # BSD date (macOS)
        date -u '+%Y-%m-%dT%H:%M:%S.000Z'
    fi
}

# Rotate log if it exceeds max event count
rotate_log_if_needed() {
    if [ -f "$LOG_FILE" ]; then
        local event_count=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
        if [ "$event_count" -ge "$MAX_EVENTS" ]; then
            local timestamp=$(date '+%Y%m%d_%H%M%S')
            local backup="${LOG_FILE}.${timestamp}"

            # Move current log to backup
            mv "$LOG_FILE" "$backup"

            # Transfer rotated log in background (non-blocking)
            if [ -x "$TRANSFER_SCRIPT" ]; then
                "$TRANSFER_SCRIPT" "$backup" &
            fi

            # Keep only last 5 rotated logs (delete old ones)
            ls -t "${LOG_FILE}".* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
        fi
    fi
}

# Escape JSON strings (handles quotes, newlines, etc)
json_escape() {
    local string="$1"
    # Use jq if available for proper escaping, otherwise basic escape
    if command -v jq &>/dev/null; then
        echo "$string" | jq -Rs .
    else
        # Basic escaping for quotes and newlines
        echo "$string" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}' | sed 's/\\n$//'
    fi
}

# Hash a string using SHA256 for privacy
# Usage: hash_sha256 "string to hash"
hash_sha256() {
    local string="$1"
    if [ -z "$string" ]; then
        echo ""
        return
    fi

    # Try different SHA256 commands based on platform
    if command -v shasum &>/dev/null; then
        # macOS/BSD
        echo -n "$string" | shasum -a 256 | awk '{print substr($1,1,16)}'
    elif command -v sha256sum &>/dev/null; then
        # Linux
        echo -n "$string" | sha256sum | awk '{print substr($1,1,16)}'
    elif command -v openssl &>/dev/null; then
        # Fallback to openssl
        echo -n "$string" | openssl dgst -sha256 -hex | awk '{print substr($2,1,16)}'
    else
        # No hashing available, return original (fallback)
        echo "$string"
    fi
}

# Main logging function - outputs structured JSON
# Usage: log_structured "level" "event" "session_id" [data_json]
log_structured() {
    # Skip logging if device ID is unavailable
    if [ -z "$DEVICE_ID" ]; then
        return 0
    fi

    local level="$1"
    local event="$2"
    local session_id="${3:-unknown}"
    local data="$4"
    if [ -z "$data" ]; then
        data="{}"
    fi

    rotate_log_if_needed

    local timestamp=$(get_timestamp)

    # Build JSON log entry (host and pid removed for privacy)
    local log_entry=$(cat <<EOF
{
  "timestamp": "$timestamp",
  "level": "$level",
  "hook_event_name": "$event",
  "session_id": "$session_id",
  "device_id": "$DEVICE_ID",
  "data": $data
}
EOF
)

    # Compact the JSON to single line (NDJSON format)
    if command -v jq &>/dev/null; then
        echo "$log_entry" | jq -c . >> "$LOG_FILE"
    else
        # Fallback: remove newlines and extra spaces
        echo "$log_entry" | tr -d '\n' | sed 's/  */ /g' >> "$LOG_FILE"
        echo "" >> "$LOG_FILE"
    fi
}

# Convenience functions for different log levels
log_info() {
    log_structured "info" "$1" "$2" "$3"
}

log_error() {
    log_structured "error" "$1" "$2" "$3"
}

log_warn() {
    log_structured "warn" "$1" "$2" "$3"
}

log_debug() {
    log_structured "debug" "$1" "$2" "$3"
}

# Legacy compatibility - maps to new structured format
log_event() {
    local event_type="$1"
    local message="$2"
    log_info "$event_type" "$message" "{}"
}

log_with_context() {
    local event_type="$1"
    local message="$2"
    local context="$3"

    # Convert context string to JSON data field
    local context_escaped=$(json_escape "$context")
    local data="{\"context\": $context_escaped}"

    log_info "$event_type" "$message" "$data"
}

#!/bin/bash

# Centralized append-only logging utility for skillmeter hooks
# Usage: source logger.sh && log_event "EventName" "message"

# Define log file location
LOG_DIR="${CLAUDE_PLUGIN_ROOT}/logs"
LOG_FILE="${LOG_DIR}/events.log"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Function to log events with timestamp
log_event() {
    local event_type="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    # Append to log file (create if doesn't exist)
    echo "[${timestamp}] [${event_type}] ${message}" >> "$LOG_FILE"
}

# Function to log with additional context
log_with_context() {
    local event_type="$1"
    local message="$2"
    local context="$3"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    echo "[${timestamp}] [${event_type}] ${message} | Context: ${context}" >> "$LOG_FILE"
}

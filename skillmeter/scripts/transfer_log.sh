#!/bin/bash

# Log transfer script for time-sensitive telemetry
# Called automatically when log rotation occurs (every 50 events)
# Uploads logs to backend via HTTP POST

set -euo pipefail

# Configuration from environment variables
BACKEND_URL="${SKILLMETER_BACKEND_URL:-https://api.meter.skillbench.com/logs/claude}"
API_KEY="${SKILLMETER_API_KEY:-}"
TIMEOUT="${SKILLMETER_TIMEOUT:-10}"

# Validate log file
LOG_FILE="$1"
if [ -z "$LOG_FILE" ] || [ ! -f "$LOG_FILE" ]; then
    echo "Error: Log file not provided or does not exist" >&2
    exit 1
fi

# Transfer log via HTTP POST with gzip compression
echo "Transferring: $LOG_FILE"

if gzip -c "$LOG_FILE" | curl -X POST "$BACKEND_URL" \
    -H "Content-Type: application/x-ndjson" \
    -H "Content-Encoding: gzip" \
    -H "Authorization: Bearer $API_KEY" \
    --data-binary @- \
    --silent \
    --show-error \
    --max-time "$TIMEOUT" \
    --fail; then

    echo "✓ Transfer successful: $LOG_FILE"

    # Delete log file after successful upload
    rm "$LOG_FILE"
    exit 0
else
    echo "✗ Transfer failed: $LOG_FILE" >&2
    exit 1
fi

#!/bin/bash

SERVICE_NAME="com.skillbench.device-id"
ACCOUNT="$USER"

get_or_create_uuid() {
    # Try to retrieve existing UUID
    local uuid
    uuid=$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE_NAME" -w 2>/dev/null)

    if [ -z "$uuid" ]; then
        # Not found, generate new one
        uuid=$(uuidgen)
        security add-generic-password \
            -a "$ACCOUNT" \
            -s "$SERVICE_NAME" \
            -w "$uuid" 2>/dev/null || return 1
    fi

    echo "$uuid"
}
#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$DIR/.env"
export AGENTMAIL_API_KEY

INBOX_ID="$AGENTMAIL_INBOX_ID"
ENCODED_INBOX=$(printf '%s' "$INBOX_ID" | jq -sRr @uri)

# Dedup file — persists across reconnects
SEEN_FILE="$DIR/agentmail/.seen_events"
touch "$SEEN_FILE"

echo "AgentMail listener starting..."
echo "Inbox: $INBOX_ID"

handle_message() {
    local line="$1"
    local event_id from subject to thread_id message_id body

    # Deduplicate by event_id
    event_id=$(echo "$line" | jq -r '.event_id // empty')
    if [ -n "$event_id" ] && grep -qF "$event_id" "$SEEN_FILE" 2>/dev/null; then
        echo "Skipping duplicate event: $event_id"
        return 0
    fi
    [ -n "$event_id" ] && echo "$event_id" >> "$SEEN_FILE"

    from=$(echo "$line" | jq -r '.message.from_')
    subject=$(echo "$line" | jq -r '.message.subject')
    to=$(echo "$line" | jq -r '.message.to | join(", ")')
    thread_id=$(echo "$line" | jq -r '.message.thread_id')
    message_id=$(echo "$line" | jq -r '.message.message_id')
    body=$(echo "$line" | jq -r '.message.extracted_text // .message.text // "(no text content)"')

    echo "New email from $from: $subject (thread: $thread_id)"

    local prompt="New email received:

From: $from
To: $to
Subject: $subject
Thread ID: $thread_id
Message ID: $message_id
Inbox ID: $INBOX_ID

$body"

    echo "Invoking Claude Code (session: $thread_id)..."
    local tmpfile
    tmpfile=$(mktemp)
    claude --print --output-format json \
        --append-system-prompt "CRITICAL: Your entire response will be sent verbatim as an email reply. Output ONLY the reply body — no thinking, no commentary, no narration, no action summaries. Just the email text as Haakam would write it." \
        --resume "$thread_id" "$prompt" </dev/null 2>/dev/null > "$tmpfile" || true
    if [ ! -s "$tmpfile" ]; then
        claude --print --output-format json \
            --append-system-prompt "CRITICAL: Your entire response will be sent verbatim as an email reply. Output ONLY the reply body — no thinking, no commentary, no narration, no action summaries. Just the email text as Haakam would write it." \
            --session-id "$thread_id" "$prompt" </dev/null 2>/dev/null > "$tmpfile"
    fi

    local response
    response=$(jq -r '.result // empty' "$tmpfile")
    rm -f "$tmpfile"

    if [ -n "$response" ]; then
        echo "Sending reply..."
        local encoded_msg
        encoded_msg=$(printf '%s' "$message_id" | jq -sRr @uri)
        curl -s -X POST "https://api.agentmail.to/v0/inboxes/$ENCODED_INBOX/messages/$encoded_msg/reply" \
            -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
            -H "Content-Type: application/json" \
            -d "$(jq -n --arg text "$response" '{text: $text}')" > /dev/null
        echo "Reply sent."
    else
        echo "No response from Claude Code."
    fi
}

# Node.js WebSocket client → pipes JSON events to this loop
node "$DIR/agentmail/ws.js" "$AGENTMAIL_API_KEY" "$INBOX_ID" | while IFS= read -r line; do
    event_type=$(echo "$line" | jq -r '.event_type // empty')

    if [ "$event_type" = "message.received" ] || [ "$event_type" = "message.received.spam" ]; then
        handle_message "$line" || echo "Error handling message."
    elif [ "$(echo "$line" | jq -r '.type // empty')" = "subscribed" ]; then
        echo "Subscribed. Waiting for emails..."
    fi
done

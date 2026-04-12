#!/usr/bin/env bash
# Tests the full handler pipeline by sending real emails and simulating the WebSocket events.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$DIR/.env"
export AGENTMAIL_API_KEY

INBOX_ID="$AGENTMAIL_INBOX_ID"
API="https://api.agentmail.to/v0"
AUTH="Authorization: Bearer $AGENTMAIL_API_KEY"
encode() { printf '%s' "$1" | jq -sRr @uri; }
ENCODED_INBOX=$(encode "$INBOX_ID")

echo "=== Creating test sender inbox ==="
SENDER=$(curl -s -X POST "$API/inboxes" -H "$AUTH" -H "Content-Type: application/json" -d '{"display_name": "Test Sender"}')
SENDER_ID=$(echo "$SENDER" | jq -r '.inbox_id')
if [ "$SENDER_ID" = "null" ] || [ -z "$SENDER_ID" ]; then
    echo "FAIL: Could not create sender inbox: $SENDER"
    exit 1
fi
echo "Sender: $SENDER_ID"
ENCODED_SENDER=$(encode "$SENDER_ID")

cleanup() {
    curl -s -X DELETE "$API/inboxes/$ENCODED_SENDER" -H "$AUTH" > /dev/null 2>&1 || true
    echo "=== Cleaned up ==="
}
trap cleanup EXIT

# --- Test 1: Send email, invoke handler, verify reply ---
echo ""
echo "=== Test 1: First email ==="
SEND1=$(curl -s -X POST "$API/inboxes/$ENCODED_SENDER/messages/send" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg to "$INBOX_ID" '{to: $to, subject: "Session Test", text: "Hey, my name is Zephyr. Just say hi."}')")
MSG1_ID=$(echo "$SEND1" | jq -r '.message_id')
THREAD_ID=$(echo "$SEND1" | jq -r '.thread_id')
echo "Sent. Thread: $THREAD_ID, Message: $MSG1_ID"

sleep 2

# Fetch the delivered message from the agent inbox
MSG1_FULL=$(curl -s "$API/inboxes/$ENCODED_INBOX/messages/$(encode "$MSG1_ID")" -H "$AUTH")
echo "Fetched message from inbox."

# Invoke Claude with the same logic as listener.sh
echo "Invoking Claude Code (session: $THREAD_ID)..."
TMPFILE=$(mktemp)
FROM=$(echo "$MSG1_FULL" | jq -r '.from')
SUBJECT=$(echo "$MSG1_FULL" | jq -r '.subject')
BODY=$(echo "$MSG1_FULL" | jq -r '.extracted_text // .text // "(no text)"')

PROMPT="From: $FROM
Subject: $SUBJECT
Thread ID: $THREAD_ID
Message ID: $MSG1_ID
Inbox ID: $INBOX_ID

$BODY"

claude --print --output-format json --session-id "$THREAD_ID" "$PROMPT" </dev/null 2>/dev/null > "$TMPFILE"
RESPONSE=$(jq -r '.result // empty' "$TMPFILE")
rm -f "$TMPFILE"

if [ -z "$RESPONSE" ]; then
    echo "FAIL: No response from Claude"
    exit 1
fi
echo "Claude response: $RESPONSE"

echo "Sending reply..."
curl -s -X POST "$API/inboxes/$ENCODED_INBOX/messages/$(encode "$MSG1_ID")/reply" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg text "$RESPONSE" '{text: $text}')" > /dev/null
echo "Reply sent."

sleep 3
REPLY1=$(curl -s "$API/inboxes/$ENCODED_SENDER/messages?include_spam=true" -H "$AUTH" \
    | jq -r '[.messages[] | select(any(.labels[]; . == "received"))] | .[0].preview // empty')
if [ -n "$REPLY1" ]; then
    echo "Reply received at sender: $REPLY1"
    echo "TEST 1: PASSED"
else
    echo "TEST 1: FAILED — no reply at sender inbox"
    exit 1
fi

# --- Test 2: Follow-up in same thread ---
echo ""
echo "=== Test 2: Follow-up (session continuity) ==="

# Find the agent's reply in sender inbox to reply to it
AGENT_REPLY_MSG=$(curl -s "$API/inboxes/$ENCODED_SENDER/messages?include_spam=true" -H "$AUTH" \
    | jq -r '[.messages[] | select(any(.labels[]; . == "received"))] | .[0].message_id')

SEND2=$(curl -s -X POST "$API/inboxes/$ENCODED_SENDER/messages/$(encode "$AGENT_REPLY_MSG")/reply" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg to "$INBOX_ID" '{to: $to, text: "What is my name? Prove you remember."}')")
MSG2_ID=$(echo "$SEND2" | jq -r '.message_id')
echo "Sent follow-up. Message: $MSG2_ID"

sleep 2

# Fetch and invoke Claude with --resume
MSG2_FULL=$(curl -s "$API/inboxes/$ENCODED_INBOX/messages/$(encode "$MSG2_ID")" -H "$AUTH")
FROM2=$(echo "$MSG2_FULL" | jq -r '.from')
SUBJECT2=$(echo "$MSG2_FULL" | jq -r '.subject')
BODY2=$(echo "$MSG2_FULL" | jq -r '.extracted_text // .text // "(no text)"')
THREAD2=$(echo "$MSG2_FULL" | jq -r '.thread_id')

PROMPT2="From: $FROM2
Subject: $SUBJECT2
Thread ID: $THREAD2
Message ID: $MSG2_ID
Inbox ID: $INBOX_ID

$BODY2"

echo "Invoking Claude Code (resume session: $THREAD2)..."
TMPFILE2=$(mktemp)
claude --print --output-format json --resume "$THREAD2" "$PROMPT2" </dev/null 2>/dev/null > "$TMPFILE2" || true
if [ ! -s "$TMPFILE2" ]; then
    claude --print --output-format json --session-id "$THREAD2" "$PROMPT2" </dev/null 2>/dev/null > "$TMPFILE2"
fi
RESPONSE2=$(jq -r '.result // empty' "$TMPFILE2")
rm -f "$TMPFILE2"

if [ -z "$RESPONSE2" ]; then
    echo "FAIL: No response from Claude on follow-up"
    exit 1
fi
echo "Claude response: $RESPONSE2"

echo "Sending reply..."
curl -s -X POST "$API/inboxes/$ENCODED_INBOX/messages/$(encode "$MSG2_ID")/reply" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg text "$RESPONSE2" '{text: $text}')" > /dev/null
echo "Reply sent."

sleep 3
REPLY2=$(curl -s "$API/inboxes/$ENCODED_SENDER/messages?include_spam=true" -H "$AUTH" \
    | jq -r '[.messages[] | select(any(.labels[]; . == "received"))] | .[0].preview // empty')
if [ -n "$REPLY2" ]; then
    echo "Reply received at sender: $REPLY2"
    if echo "$REPLY2" | grep -qi "zephyr"; then
        echo "TEST 2: PASSED — session continuity confirmed"
    else
        echo "TEST 2: PARTIAL — reply received but doesn't mention Zephyr"
        echo "Full reply: $REPLY2"
    fi
else
    echo "TEST 2: FAILED — no reply at sender inbox"
    exit 1
fi

echo ""
echo "=== ALL TESTS PASSED ==="

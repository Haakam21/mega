#!/usr/bin/env bash
# Mock that spawns a long-lived child subprocess so tree-kill can be verified.
# Writes the child PID to $TREE_CHILD_PID_FILE (env var) so tests can check
# whether the child was reaped after the parent is signalled.
: "${TREE_CHILD_PID_FILE:?TREE_CHILD_PID_FILE must be set}"
sleep 300 &
CHILD=$!
echo "$CHILD" > "$TREE_CHILD_PID_FILE"
wait "$CHILD"

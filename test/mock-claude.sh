#!/usr/bin/env bash
# Mock claude CLI for testing. Echoes a JSON response.
# Supports --print --output-format json and outputs a result.

# Find the prompt (last non-flag argument)
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --*) shift; [[ "$1" != --* && -n "$1" ]] && shift ;;
    *) prompt="$1"; shift ;;
  esac
done

echo "{\"result\": \"mock response to: ${prompt:0:50}\"}"

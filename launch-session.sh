#!/bin/bash
# Launch a Claude Code session with a fixed tab title
# Usage: launch-session.sh <title> <command...>

TITLE="$1"
shift

# Run the command in background, wait for Claude to load, then set title
bash -ic "$*" &
CHILD=$!

# Wait for Claude Code to start, then override the title
sleep 5
printf '\033]0;%s\007' "$TITLE"

# Keep waiting for the child process
wait $CHILD

#!/bin/bash
# Manage and restore Claude Code sessions from the router's sessions registry
#
# Usage:
#   restore-sessions.sh [--dangerously-skip-permissions]  — restore all sessions
#   restore-sessions.sh list                              — show saved sessions
#   restore-sessions.sh remove NAME                       — remove a session
#
# Options:
#   --dangerously-skip-permissions   pass this flag to claude on launch

SESSIONS_FILE="${SESSIONS_FILE:-$HOME/.claude/channels/telegram/sessions.json}"
EXTRA_ARGS=""

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --dangerously-skip-permissions)
      EXTRA_ARGS=" --dangerously-skip-permissions"
      ;;
  esac
done
# Remove flags from positional args
args=()
for arg in "$@"; do
  case "$arg" in
    --dangerously-skip-permissions) ;;
    *) args+=("$arg") ;;
  esac
done
set -- "${args[@]}"

check_file() {
  if [[ ! -f "$SESSIONS_FILE" ]]; then
    echo "No sessions registry found at: $SESSIONS_FILE"
    echo "Sessions are recorded automatically when Claude Code connects to the Telegram router."
    exit 1
  fi
}

cmd_list() {
  check_file
  python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
if not data:
    print('No sessions saved.'); sys.exit()
print(f'{'Topic':<20} {'Last seen':<22} {'Path'}')
print('-' * 90)
for name, e in sorted(data.items()):
    seen = e.get('last_seen', '?')[:19].replace('T', ' ')
    print(f'{name:<20} {seen:<22} {e[\"cwd\"]}')
    cmd = e.get('launch_cmd', '')
    if cmd:
        print(f'{'':>20} cmd: {cmd}')
print(f'\nTotal: {len(data)} session(s)')
" "$SESSIONS_FILE"
}

cmd_remove() {
  local name="$1"
  if [[ -z "$name" ]]; then
    echo "Usage: restore-sessions.sh remove <topic-name>"
    echo "Run 'restore-sessions.sh list' to see available sessions."
    exit 1
  fi
  check_file
  python3 -c "
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
if name not in data:
    print(f'Session \"{name}\" not found.')
    print('Available: ' + ', '.join(sorted(data.keys())) if data else 'No sessions.')
    sys.exit(1)
del data[name]
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print(f'Removed \"{name}\". {len(data)} session(s) remaining.')
" "$SESSIONS_FILE" "$name"
}

cmd_restore() {
  # Kill leftover bun server.ts processes from previous sessions
  pkill -f "bun.*server\.ts" 2>/dev/null
  pkill -f "bun run --cwd.*telegram-enhanced" 2>/dev/null
  sleep 0.5

  check_file
  # Extract: topic, cwd, launch_cmd
  entries=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for name, entry in sorted(data.items()):
    topic = entry['topic_name']
    cwd = entry['cwd']
    cmd = entry.get('launch_cmd', f'TELEGRAM_TOPIC_NAME=\"{topic}\" claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins')
    print(topic + '\t' + cwd + '\t' + cmd)
" "$SESSIONS_FILE" 2>/dev/null)

  # Start router in the first tab
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  ROUTER_SCRIPT="$SCRIPT_DIR/router.ts"
  wt_args=( --title "Router" -- wsl.exe bash -lic "bun $ROUTER_SCRIPT" )

  if [[ -z "$entries" ]]; then
    echo "No sessions found — starting router only."
    wt.exe new-tab "${wt_args[@]}" &
    echo "Router started. Connect projects with:"
    echo "  TELEGRAM_TOPIC_NAME=\"Name\" claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins"
    exit 0
  fi

  # Wait for router to start before launching sessions
  sleep 1

  # Add session tabs
  count=0
  while IFS=$'\t' read -r topic cwd launch_cmd; do
    [[ -z "$cwd" ]] && continue

    win_dir="$(wslpath -w "$cwd" 2>/dev/null || echo "$cwd")"

    wt_args+=( ";" "new-tab" )
    printf '#!/bin/bash -i\nexport TELEGRAM_TOPIC_NAME="%s"\n(sleep 15 && printf '"'"'\\033]0;%s\\007'"'"') &\nclaude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins%s\n' "$topic" "$topic" "$EXTRA_ARGS" > "/tmp/claude-restore-${count}.sh"
    chmod +x "/tmp/claude-restore-${count}.sh"
    wt_args+=( --title "$topic" -d "$win_dir" -- wsl.exe bash -li "/tmp/claude-restore-${count}.sh" )
    ((count++))
  done <<< "$entries"

  if ((count > 0)); then
    wt.exe new-tab "${wt_args[@]}" &
  fi

  echo "Restored $count session(s)"
}

case "${1:-restore}" in
  list|ls)       cmd_list ;;
  remove|rm)     cmd_remove "$2" ;;
  restore|"")    cmd_restore ;;
  *)
    echo "Usage: restore-sessions.sh [list|remove <name>|restore]"
    exit 1
    ;;
esac

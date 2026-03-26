---
name: startup
description: Start the Telegram router and restore all saved Claude Code sessions, or guide first-time setup. Use when the user wants to start/restore their Telegram sessions, reboot recovery, or initial setup.
user-invocable: true
allowed-tools:
  - Bash(bash *)
  - Bash(cat *)
  - Bash(ls *)
  - Bash(bun *)
  - Read
---

# /telegram-enhanced:startup — Start Router & Restore Sessions

Launches the Telegram forum router and restores all saved Claude Code sessions
in Windows Terminal tabs. On first run (no saved sessions), starts the router
and guides the user through connecting their first project.

Arguments passed: `$ARGUMENTS`

---

## Locate the plugin

The restore script and router live in the plugin directory. Find it:

1. Check `~/.claude/plugins/cache/atom-plugins/telegram-enhanced/` — use the
   latest version subdirectory
2. Fallback: check if the user has a local clone (look for `restore-sessions.sh`
   in common locations)

Store the path as `$PLUGIN_DIR`.

## Dispatch

### No args — restore or first-time setup

1. **Check if router is already running:**
   ```bash
   pgrep -f "bun.*router\.ts" > /dev/null
   ```
   If running, tell the user and skip router start.

2. **Check sessions file:** `~/.claude/channels/telegram/sessions.json`

3. **If sessions exist** — run the restore script:
   ```bash
   bash "$PLUGIN_DIR/restore-sessions.sh" $ARGUMENTS
   ```
   Tell the user how many sessions are being restored and that they need to
   confirm the development channels prompt in each tab.

4. **If no sessions (first time)** — start router only:
   ```bash
   bash "$PLUGIN_DIR/restore-sessions.sh"
   ```
   Then guide the user:

   > Router started! Now connect your first project:
   >
   > 1. Open a new terminal tab
   > 2. Navigate to your project directory
   > 3. Run:
   >    ```
   >    TELEGRAM_TOPIC_NAME="ProjectName" claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins
   >    ```
   >    Replace `ProjectName` with a short name for the Telegram forum topic.
   >
   > 4. Confirm the development channels prompt
   > 5. The session is now connected — messages in the "ProjectName" topic
   >    will reach this Claude Code session
   >
   > Next time you run `/telegram-enhanced:startup`, all sessions restore
   > automatically.

### `--dangerously-skip-permissions` — pass through

Append this flag to the restore script call so Claude Code sessions start
without permission prompts:
```bash
bash "$PLUGIN_DIR/restore-sessions.sh" --dangerously-skip-permissions
```

### `router` — start router only

Just start the router without restoring sessions:
```bash
bash "$PLUGIN_DIR/restore-sessions.sh"
```
(With no sessions, it only starts the router.)

---

## Implementation notes

- The restore script kills leftover bun processes before starting
- Router tab is always the first tab opened
- Each session tab gets a title matching the topic name (set after 15s delay)
- Sessions are saved automatically when they connect to the router
- The `--dangerously-load-development-channels` flag is required because
  the plugin is not on Anthropic's approved channels allowlist

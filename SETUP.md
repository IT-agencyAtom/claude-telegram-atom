# Setup & Configuration Guide

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Telegram supergroup with [Topics enabled](https://telegram.org/blog/topics-in-groups-collectible-usernames)
- The bot must be an admin in the group (needed to create topics)

## Single-session DM mode

If you only need one session, the plugin works as a simple DM bot without the router:

```sh
claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins
```

DM your bot on Telegram — it replies with a pairing code. Approve with `/telegram-enhanced:access pair <code>`, then lock down with `/telegram-enhanced:access policy allowlist`.

## Forum mode — multiple sessions

### 1. Prepare the forum group

1. Create a Telegram supergroup
2. Enable Topics (Group Settings → Topics)
3. Add your bot to the group and make it an admin
4. Get the group's chat ID (forward a message from the group to [@userinfobot](https://t.me/userinfobot))

### 2. Configure

Add to `~/.claude/channels/telegram/.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:AAHfiqksKZ8...
TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
```

### 3. Start everything

```
/telegram-enhanced:startup
```

Or manually:

```sh
# Start router
bun router.ts

# Connect a project (in another terminal)
cd ~/projects/my-app
TELEGRAM_TOPIC_NAME="my-app" claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins
```

### 4. Restore after reboot

```sh
bash restore-sessions.sh                                 # restore all sessions
bash restore-sessions.sh --dangerously-skip-permissions  # skip permission prompts
bash restore-sessions.sh list                            # show saved sessions
bash restore-sessions.sh remove <name>                   # remove a session
```

## Extensions configuration

Set in `~/.claude/channels/telegram/.env`:

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `TELEGRAM_LOG_FILE` | `~/.claude/channels/telegram/server.log` | Path to log file (empty to disable) |
| `TELEGRAM_STT_API_URL` | `https://api.elevenlabs.io/v1/speech-to-text` | STT API endpoint |
| `TELEGRAM_STT_API_KEY` | _(empty)_ | API key for STT (disabled if empty) |
| `TELEGRAM_STT_MODEL` | `scribe_v2` | STT model name |
| `TELEGRAM_STT_LANGUAGE` | _(auto)_ | ISO language code hint |
| `TELEGRAM_TYPING_INTERVAL_MS` | `4000` | Typing indicator interval |
| `TELEGRAM_TYPING_TIMEOUT_MS` | `300000` | Max typing duration (5 min) |

## Tools exposed to Claude

| Tool | Description |
|---|---|
| `reply` | Send a message. Supports `reply_to`, `files` (absolute paths), `format` (`text`/`markdownv2`). Auto-chunks long text. Images as photos, others as documents. Max 50 MB. |
| `react` | Emoji reaction (Telegram's fixed whitelist only). |
| `edit_message` | Edit a previously sent bot message. |
| `download_attachment` | Download a file by `file_id` from an inbound message. |

In forum mode, `message_thread_id` is injected automatically.

## State directory

All state in `~/.claude/channels/telegram/` (override with `TELEGRAM_STATE_DIR`):

| File | Purpose |
|---|---|
| `.env` | Bot token and extension config (chmod 600) |
| `access.json` | Access control: allowlist, policies, pending pairings |
| `topics.json` | Forum topic registry (topic name → thread ID) |
| `sessions.json` | Session registry for restore (topic → cwd, launch command, last seen) |
| `server.pid` | PID of running server.ts |
| `router.pid` | PID of running router daemon |
| `router.sock` | Unix socket for router ↔ topic-mcp IPC |
| `inbox/` | Downloaded photos and attachments |
| `server.log` | Structured log file (if enabled) |

## Project structure

```
├── server.ts              # DM/group MCP server (original + extensions)
├── router.ts              # Forum topic routing daemon
├── topic-mcp.ts           # Per-session MCP relay for forum mode
├── extensions/
│   ├── index.ts           # Barrel export
│   ├── config.ts          # Environment-based configuration
│   ├── logger.ts          # Structured logging (stderr + file)
│   ├── typing.ts          # Persistent typing indicator
│   └── stt.ts             # Speech-to-text via ElevenLabs Scribe
├── skills/
│   ├── startup/SKILL.md   # /telegram-enhanced:startup — launch & restore
│   ├── configure/SKILL.md # /telegram-enhanced:configure — bot token setup
│   └── access/SKILL.md    # /telegram-enhanced:access — pairing and permissions
├── restore-sessions.sh    # Restore Windows Terminal tabs from registry
└── .claude-plugin/
    └── plugin.json        # Plugin manifest
```

## Limitations

- Telegram's Bot API has no message history or search — only incoming messages
- Photos are compressed by Telegram; send as document for originals
- Forum topics require bot admin permissions
- STT requires an ElevenLabs API key (or compatible endpoint)
- `restore-sessions.sh` is designed for Windows Terminal + WSL
- Custom marketplace plugins require `--dangerously-load-development-channels` flag

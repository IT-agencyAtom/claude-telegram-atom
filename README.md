# Telegram Plugin for Claude Code — Enhanced Fork

Enhanced fork of the official [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-code-plugins) plugin (v0.0.4) with multi-session forum routing, speech-to-text, structured logging, and session restore.

## Why this fork?

The official Telegram plugin connects **one** Claude Code session to **one** Telegram chat. If you run multiple Claude Code sessions on different projects, you need separate bots and separate chats — or you lose context about which session you're talking to.

This fork solves that by introducing a **forum router**: a single Telegram bot manages a [forum-style supergroup](https://telegram.org/blog/topics-in-groups-collectible-usernames) where each Claude Code session gets its own topic. You message a specific topic — the router delivers the message to the right session. Ten sessions, one bot, one group.

Additionally, the fork adds practical features that are useful in daily work: voice message transcription, persistent typing indicators, structured logs, and a session restore script so you can bring everything back up after a reboot.

## Features

### From the official plugin
- DM and group messaging with access control
- Pairing flow for secure user-ID capture
- Allowlist and policy management
- Message chunking (newline-aware, configurable limit)
- Photo and document handling (download on arrival)
- Emoji reactions (Telegram's fixed whitelist)
- MarkdownV2 formatting support
- Inline keyboard and reply threading

### Added in this fork

| Feature | Description |
|---|---|
| **Forum topic routing** | One bot, multiple Claude Code sessions — each in its own Telegram forum topic |
| **Router daemon** | Standalone process (`router.ts`) that polls Telegram and routes messages via unix socket IPC |
| **Topic MCP relay** | Per-session MCP server (`topic-mcp.ts`) that connects to the router and relays messages/tool calls |
| **Speech-to-text** | Voice messages transcribed via ElevenLabs Scribe API (configurable endpoint) |
| **Structured logging** | Level-based logging to stderr + optional file, JSON metadata |
| **Typing indicator** | Persistent "typing..." that stays active while Claude processes a message (up to 5 min) |
| **Reply context** | Inbound reply-to metadata passed to Claude for conversation threading |
| **Session registry** | Auto-saves connected sessions; restore all tabs with one command after reboot |
| **PID lock** | Prevents duplicate router/server instances |
| **Modular extensions** | Config, logging, typing, STT — separated into `extensions/` for minimal merge conflicts |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Telegram Forum Group                      │
│  ┌─────────┐  ┌──────────────┐  ┌────────────┐              │
│  │ Topic A  │  │   Topic B    │  │  Topic C   │    ...       │
│  │(project1)│  │  (project2)  │  │ (project3) │              │
│  └────┬─────┘  └──────┬───────┘  └─────┬──────┘              │
└───────┼───────────────┼────────────────┼─────────────────────┘
        │               │                │
        └───────────────┼────────────────┘
                        │  Telegram Bot API (polling)
                        ▼
              ┌─────────────────┐
              │   router.ts     │  ← standalone daemon
              │  (routes msgs   │
              │   by topic)     │
              └────┬───┬───┬────┘
         unix sock │   │   │ unix sock
                   ▼   ▼   ▼
           ┌───────┐ ┌───────┐ ┌───────┐
           │topic- │ │topic- │ │topic- │
           │mcp.ts │ │mcp.ts │ │mcp.ts │   ← one per session
           └───┬───┘ └───┬───┘ └───┬───┘
               │         │         │  MCP stdio
               ▼         ▼         ▼
          ┌────────┐ ┌────────┐ ┌────────┐
          │ Claude │ │ Claude │ │ Claude │
          │  Code  │ │  Code  │ │  Code  │
          │(proj1) │ │(proj2) │ │(proj3) │
          └────────┘ └────────┘ └────────┘
```

**Single-session DM mode** still works the same as the official plugin — `server.ts` handles everything without the router.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- For forum mode: a Telegram supergroup with [Topics enabled](https://telegram.org/blog/topics-in-groups-collectible-usernames)

## Quick Setup — Single Session (DM bot)

> Same as the official plugin. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot** with [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.

**2. Install the plugin:**
```
/plugin install telegram@atom-plugins
```

**3. Save the token:**
```
/telegram:configure 123456789:AAHfiqksKZ8...
```

**4. Launch with the channel flag:**
```sh
claude --channels plugin:telegram@atom-plugins
```

**5. Pair** — DM your bot, get a 6-char code, then:
```
/telegram:access pair <code>
```

**6. Lock it down:**
```
/telegram:access policy allowlist
```

## Forum Mode — Multiple Sessions

Use this when you run multiple Claude Code sessions and want to reach each one from a single Telegram group.

### 1. Prepare the forum group

1. Create a Telegram supergroup
2. Enable Topics (Group Settings → Topics)
3. Add your bot to the group and make it an admin (needed to create topics)
4. Get the group's chat ID (forward a message from the group to [@userinfobot](https://t.me/userinfobot))

### 2. Configure

Add to `~/.claude/channels/telegram/.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:AAHfiqksKZ8...
TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
```

### 3. Start the router daemon

```sh
bun run /path/to/claude-telegram-plugin/router.ts
```

The router runs in the foreground — use `tmux`, `screen`, or a systemd unit to keep it alive. It writes its PID to `~/.claude/channels/telegram/router.pid` and kills any previous instance on startup.

### 4. Launch Claude Code sessions

Each session auto-registers with the router using the project directory name as the topic name:

```sh
cd ~/projects/my-app
claude --channels plugin:telegram@atom-plugins
```

This creates a forum topic called "my-app" and routes messages there. Override with `TELEGRAM_TOPIC_NAME` env var if needed.

### 5. Restore sessions after reboot

Sessions are automatically saved to `~/.claude/channels/telegram/sessions.json` on connect (project directory and launch command are recorded). Restore all of them:

```sh
bash restore-sessions.sh                                    # open all sessions in Windows Terminal tabs
bash restore-sessions.sh --dangerously-skip-permissions     # same, but skip permission prompts
bash restore-sessions.sh list                               # show saved sessions
bash restore-sessions.sh remove X                           # remove a session from the registry
```

Each tab gets a title matching the topic name (persists after Claude Code starts). The `--dangerously-skip-permissions` flag is passed through to `claude` — useful for unattended operation.

## Extensions Configuration

Set these in `~/.claude/channels/telegram/.env`:

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `TELEGRAM_LOG_FILE` | `~/.claude/channels/telegram/server.log` | Path to structured log file (empty to disable) |
| `TELEGRAM_STT_API_URL` | `https://api.elevenlabs.io/v1/speech-to-text` | Speech-to-text API endpoint |
| `TELEGRAM_STT_API_KEY` | _(empty)_ | API key for STT service (STT disabled if empty) |
| `TELEGRAM_STT_MODEL` | `scribe_v2` | STT model name |
| `TELEGRAM_STT_LANGUAGE` | _(auto)_ | ISO language code hint for STT |
| `TELEGRAM_TYPING_INTERVAL_MS` | `4000` | Re-send typing indicator every N ms |
| `TELEGRAM_TYPING_TIMEOUT_MS` | `300000` | Max typing indicator duration (5 min) |

## Tools Exposed to Claude

| Tool | Description |
|---|---|
| `reply` | Send a message. Accepts `chat_id`, `text`, optional `reply_to` (message ID), `files` (absolute paths), `format` (`text` or `markdownv2`). Images send as photos with preview; other files as documents. Max 50 MB each. Auto-chunks long text. |
| `react` | Add emoji reaction to a message. Only Telegram's fixed whitelist (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a previously sent bot message. Useful for "working..." → result progress updates. |
| `download_attachment` | Download a file attachment by `file_id` from an inbound message. |

In forum mode, `message_thread_id` is injected automatically — tools work identically in both modes.

## State Directory

All state lives in `~/.claude/channels/telegram/` (override with `TELEGRAM_STATE_DIR`):

| File | Purpose |
|---|---|
| `.env` | Bot token and extension config (chmod 600) |
| `access.json` | Access control: allowlist, policies, pending pairings |
| `topics.json` | Forum topic registry (topic name → thread ID) |
| `sessions.json` | Session registry for restore (topic name → cwd, launch command, last seen) |
| `server.pid` | PID of the running server.ts instance |
| `router.pid` | PID of the running router daemon |
| `router.sock` | Unix socket for router ↔ topic-mcp IPC |
| `inbox/` | Downloaded photos and attachments |
| `server.log` | Structured log file (if enabled) |

## Development

### Installation

```sh
git clone https://github.com/your-repo/claude-telegram-plugin.git
bash claude-telegram-plugin/install.sh
```

`install.sh` creates a symlink from `~/.claude/plugins/` to the cloned repo and enables the plugin in settings. No copying — edits to the repo are live.

### Project structure

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
│   ├── configure/SKILL.md # /telegram:configure — bot token setup
│   └── access/SKILL.md    # /telegram:access — pairing and permissions
├── install.sh             # Symlink plugin into Claude Code + enable in settings
├── restore-sessions.sh    # Restore Windows Terminal tabs from registry
├── launch-session.sh      # Tab wrapper: launches claude and sets tab title
└── .claude-plugin/
    └── plugin.json        # Plugin manifest
```

## Access Control

See **[ACCESS.md](./ACCESS.md)** for the full reference: DM policies, group setup, mention detection, delivery config, and `access.json` schema.

Quick summary: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing` — switch to `allowlist` after setup.

## Limitations

- Telegram's Bot API exposes **no message history or search** — the bot only sees messages as they arrive
- Photos are compressed by Telegram; send as document (long-press → Send as File) for originals
- Forum topics require the bot to have admin permissions in the group
- STT requires an ElevenLabs API key (or compatible endpoint)
- `restore-sessions.sh` is designed for Windows Terminal + WSL

## License

Apache 2.0 — see [LICENSE](./LICENSE).

Based on the official [Claude Code Telegram plugin](https://github.com/anthropics/claude-code-plugins) by Anthropic.

---

# Telegram-плагин для Claude Code — расширенный форк

Расширенный форк официального плагина [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-code-plugins) (v0.0.4) с маршрутизацией по топикам форума, распознаванием голосовых сообщений, структурированным логированием и восстановлением сессий.

## Зачем этот форк?

Официальный Telegram-плагин связывает **одну** сессию Claude Code с **одним** чатом. Если вы работаете над несколькими проектами одновременно — нужны отдельные боты и чаты, а контекст о том, какой сессии вы пишете, теряется.

Этот форк решает проблему через **роутер форума**: один бот управляет [супергруппой с топиками](https://telegram.org/blog/topics-in-groups-collectible-usernames), где каждая сессия Claude Code получает свой топик. Пишете в конкретный топик — роутер доставляет сообщение нужной сессии. Десять сессий, один бот, одна группа.

Дополнительно форк добавляет практичные фичи для ежедневной работы: транскрипцию голосовых сообщений, постоянный индикатор набора текста, структурированные логи и скрипт восстановления сессий после перезагрузки.

## Возможности

### Из оригинального плагина
- Личные и групповые сообщения с контролем доступа
- Привязка через паринг-код для безопасного захвата user ID
- Управление allowlist и политиками доступа
- Нарезка длинных сообщений (с учётом переносов строк)
- Обработка фото и документов (скачиваются при получении)
- Реакции эмодзи (фиксированный whitelist Telegram)
- Поддержка MarkdownV2
- Inline-кнопки и треды ответов

### Добавлено в этом форке

| Фича | Описание |
|---|---|
| **Маршрутизация по топикам** | Один бот, несколько сессий Claude Code — каждая в своём топике форума |
| **Демон-роутер** | Отдельный процесс (`router.ts`), который поллит Telegram и раздаёт сообщения через unix-сокет IPC |
| **Topic MCP relay** | MCP-сервер на каждую сессию (`topic-mcp.ts`), подключается к роутеру и проксирует сообщения/вызовы инструментов |
| **Speech-to-text** | Голосовые сообщения транскрибируются через ElevenLabs Scribe API (настраиваемый endpoint) |
| **Структурированные логи** | Логирование по уровням в stderr + опциональный файл, метаданные в JSON |
| **Индикатор набора** | Постоянный "печатает..." пока Claude обрабатывает сообщение (до 5 мин) |
| **Контекст ответов** | Метаданные reply-to передаются в Claude для понимания контекста треда |
| **Реестр сессий** | Автосохранение подключённых сессий; восстановление всех вкладок одной командой |
| **PID lock** | Защита от запуска дублирующих экземпляров роутера/сервера |
| **Модульные расширения** | Конфиг, логи, typing, STT — вынесены в `extensions/` для минимальных конфликтов при мёрже |

## Архитектура

```
┌──────────────────────────────────────────────────────────────┐
│                  Telegram-группа (форум)                       │
│  ┌─────────┐  ┌──────────────┐  ┌────────────┐              │
│  │ Топик A  │  │   Топик B    │  │  Топик C   │    ...       │
│  │(проект1) │  │  (проект2)   │  │ (проект3)  │              │
│  └────┬─────┘  └──────┬───────┘  └─────┬──────┘              │
└───────┼───────────────┼────────────────┼─────────────────────┘
        │               │                │
        └───────────────┼────────────────┘
                        │  Telegram Bot API (polling)
                        ▼
              ┌─────────────────┐
              │   router.ts     │  ← демон-роутер
              │  (маршрутизация │
              │   по топикам)   │
              └────┬───┬───┬────┘
         unix sock │   │   │ unix sock
                   ▼   ▼   ▼
           ┌───────┐ ┌───────┐ ┌───────┐
           │topic- │ │topic- │ │topic- │
           │mcp.ts │ │mcp.ts │ │mcp.ts │   ← по одному на сессию
           └───┬───┘ └───┬───┘ └───┬───┘
               │         │         │  MCP stdio
               ▼         ▼         ▼
          ┌────────┐ ┌────────┐ ┌────────┐
          │ Claude │ │ Claude │ │ Claude │
          │  Code  │ │  Code  │ │  Code  │
          │(прт.1) │ │(прт.2) │ │(прт.3) │
          └────────┘ └────────┘ └────────┘
```

**Режим одной сессии (DM)** работает так же, как оригинальный плагин — `server.ts` обрабатывает всё без роутера.

## Требования

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Токен бота от [@BotFather](https://t.me/BotFather)
- Для режима форума: супергруппа Telegram с [включёнными топиками](https://telegram.org/blog/topics-in-groups-collectible-usernames)

## Быстрая настройка — одна сессия (DM-бот)

> Аналогично оригинальному плагину. См. [ACCESS.md](./ACCESS.md) для групп и многопользовательских сценариев.

**1. Создайте бота** через [@BotFather](https://t.me/BotFather) → `/newbot` → скопируйте токен.

**2. Установите плагин:**
```
/plugin install telegram@atom-plugins
```

**3. Сохраните токен:**
```
/telegram:configure 123456789:AAHfiqksKZ8...
```

**4. Запустите с флагом канала:**
```sh
claude --channels plugin:telegram@atom-plugins
```

**5. Привязка** — напишите боту в Telegram, получите 6-символьный код, затем:
```
/telegram:access pair <code>
```

**6. Заблокируйте доступ посторонним:**
```
/telegram:access policy allowlist
```

## Режим форума — несколько сессий

Используйте, когда запускаете несколько сессий Claude Code и хотите общаться с каждой из одной Telegram-группы.

### 1. Подготовьте группу-форум

1. Создайте супергруппу в Telegram
2. Включите топики (Настройки группы → Топики)
3. Добавьте бота в группу и сделайте администратором (нужно для создания топиков)
4. Узнайте chat ID группы (перешлите сообщение из группы боту [@userinfobot](https://t.me/userinfobot))

### 2. Настройте

Добавьте в `~/.claude/channels/telegram/.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:AAHfiqksKZ8...
TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
```

### 3. Запустите демон-роутер

```sh
bun run /path/to/claude-telegram-plugin/router.ts
```

Роутер работает в foreground — используйте `tmux`, `screen` или systemd для фонового запуска. При старте записывает PID в `~/.claude/channels/telegram/router.pid` и завершает предыдущий экземпляр.

### 4. Запустите сессии Claude Code

Каждая сессия автоматически регистрируется в роутере, используя имя директории проекта как название топика:

```sh
cd ~/projects/my-app
claude --channels plugin:telegram@atom-plugins
```

Создаст топик "my-app" и будет маршрутизировать сообщения туда. Можно переопределить через переменную `TELEGRAM_TOPIC_NAME`.

### 5. Восстановление сессий после перезагрузки

Сессии автоматически сохраняются в `~/.claude/channels/telegram/sessions.json` при подключении (директория проекта и команда запуска записываются). Восстановить все:

```sh
bash restore-sessions.sh                                    # открыть все сессии во вкладках Windows Terminal
bash restore-sessions.sh --dangerously-skip-permissions     # то же, но без запросов разрешений
bash restore-sessions.sh list                               # показать сохранённые сессии
bash restore-sessions.sh remove X                           # удалить сессию из реестра
```

Каждый таб получает заголовок по имени топика (сохраняется после запуска Claude Code). Флаг `--dangerously-skip-permissions` пробрасывается в `claude` — удобно для автономной работы.

## Настройка расширений

Задаются в `~/.claude/channels/telegram/.env`:

| Переменная | По умолчанию | Описание |
|---|---|---|
| `TELEGRAM_LOG_LEVEL` | `info` | Уровень логов: `debug`, `info`, `warn`, `error` |
| `TELEGRAM_LOG_FILE` | `~/.claude/channels/telegram/server.log` | Путь к файлу логов (пусто — отключить) |
| `TELEGRAM_STT_API_URL` | `https://api.elevenlabs.io/v1/speech-to-text` | Endpoint API распознавания речи |
| `TELEGRAM_STT_API_KEY` | _(пусто)_ | API-ключ STT-сервиса (без ключа STT отключён) |
| `TELEGRAM_STT_MODEL` | `scribe_v2` | Модель STT |
| `TELEGRAM_STT_LANGUAGE` | _(авто)_ | Код языка ISO для подсказки STT |
| `TELEGRAM_TYPING_INTERVAL_MS` | `4000` | Переотправка индикатора набора каждые N мс |
| `TELEGRAM_TYPING_TIMEOUT_MS` | `300000` | Макс. длительность индикатора (5 мин) |

## Инструменты Claude

| Инструмент | Описание |
|---|---|
| `reply` | Отправить сообщение. Принимает `chat_id`, `text`, опционально `reply_to` (ID сообщения), `files` (абсолютные пути), `format` (`text` или `markdownv2`). Изображения отправляются как фото с превью, остальные — как документы. Макс. 50 МБ. Длинный текст нарезается автоматически. |
| `react` | Поставить эмодзи-реакцию на сообщение. Только из фиксированного whitelist Telegram. |
| `edit_message` | Отредактировать ранее отправленное ботом сообщение. Удобно для прогресса "обрабатываю..." → результат. |
| `download_attachment` | Скачать вложение по `file_id` из входящего сообщения. |

В режиме форума `message_thread_id` подставляется автоматически — инструменты работают одинаково в обоих режимах.

## Директория состояния

Всё хранится в `~/.claude/channels/telegram/` (переопределяется через `TELEGRAM_STATE_DIR`):

| Файл | Назначение |
|---|---|
| `.env` | Токен бота и настройки расширений (chmod 600) |
| `access.json` | Контроль доступа: allowlist, политики, ожидающие привязки |
| `topics.json` | Реестр топиков форума (имя топика → thread ID) |
| `sessions.json` | Реестр сессий для восстановления (имя топика → cwd, команда запуска, last seen) |
| `server.pid` | PID запущенного server.ts |
| `router.pid` | PID запущенного демона-роутера |
| `router.sock` | Unix-сокет для IPC роутер ↔ topic-mcp |
| `inbox/` | Скачанные фото и вложения |
| `server.log` | Файл структурированных логов (если включён) |

## Ограничения

- Bot API Telegram **не предоставляет историю сообщений и поиск** — бот видит только входящие сообщения
- Фото сжимаются Telegram; для оригиналов отправляйте как документ (зажать → Отправить как файл)
- Для топиков форума бот должен быть администратором группы
- STT требует API-ключ ElevenLabs (или совместимый endpoint)
- `restore-sessions.sh` рассчитан на Windows Terminal + WSL

## Лицензия

Apache 2.0 — см. [LICENSE](./LICENSE).

На основе официального [Telegram-плагина Claude Code](https://github.com/anthropics/claude-code-plugins) от Anthropic.

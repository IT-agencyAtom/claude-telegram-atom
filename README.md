# Telegram Enhanced — Claude Code Plugin

Control multiple Claude Code sessions from one Telegram group. Each session gets its own forum topic — write in a topic, the message reaches the right session.

One bot. One group. Ten sessions.

## What's inside

- **Forum routing** — standalone router daemon maps Telegram forum topics to Claude Code sessions via unix socket IPC
- **Session restore** — sessions auto-save on connect; restore all Windows Terminal tabs with one command after reboot
- **Voice messages** — speech-to-text via ElevenLabs Scribe API
- **Typing indicator** — persistent "typing..." while Claude thinks (up to 5 min)
- **Structured logging** — level-based logging to stderr + optional file
- **Access control** — pairing codes, allowlists, group mention detection

Based on the official [`telegram`](https://github.com/anthropics/claude-code-plugins) plugin (v0.0.4) by Anthropic.

## Quick start

**1. Add the marketplace and install:**
```
/plugin marketplace add IT-agencyAtom/atom-plugins
/plugin install telegram-enhanced@atom-plugins
```

**2. Set up your bot** — create one with [@BotFather](https://t.me/BotFather), then:
```
/telegram-enhanced:configure <your-bot-token>
```

**3. Create a Telegram forum group** — enable Topics in group settings, add your bot as admin, get the chat ID via [@userinfobot](https://t.me/userinfobot).

Add to `~/.claude/channels/telegram/.env`:
```env
TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
```

**4. Launch:**
```
/telegram-enhanced:startup
```

First time — starts the router and shows how to connect projects. After that — restores all saved sessions.

**5. Pair and lock down** — DM your bot on Telegram, get a 6-char code, then:
```
/telegram-enhanced:access pair <code>
/telegram-enhanced:access policy allowlist
```
Now only you can reach the bot. Everyone else is silently ignored.

**6. Connect a project** (first time for each project):
```sh
cd ~/your-project
TELEGRAM_TOPIC_NAME="MyProject" claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins
```

A forum topic "MyProject" is created automatically. Next time, `/telegram-enhanced:startup` restores it.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Telegram Forum Group                      │
│  ┌─────────┐  ┌──────────────┐  ┌────────────┐              │
│  │ Topic A  │  │   Topic B    │  │  Topic C   │    ...       │
│  └────┬─────┘  └──────┬───────┘  └─────┬──────┘              │
└───────┼───────────────┼────────────────┼─────────────────────┘
        └───────────────┼────────────────┘
                        ▼  Telegram Bot API (polling)
              ┌─────────────────┐
              │   router.ts     │  daemon
              └────┬───┬───┬────┘
         unix sock │   │   │
                   ▼   ▼   ▼
              topic-mcp.ts (×N)    one per session
                   │   │   │  MCP stdio
                   ▼   ▼   ▼
              Claude Code (×N)
```

## Documentation

- **[SETUP.md](./SETUP.md)** — detailed setup guide, configuration reference, extensions, state directory
- **[ACCESS.md](./ACCESS.md)** — access control: pairing, allowlists, groups, delivery config

## License

Apache 2.0 — see [LICENSE](./LICENSE).

---

# Telegram Enhanced — Плагин для Claude Code

Управляйте несколькими сессиями Claude Code из одной Telegram-группы. Каждая сессия получает свой топик форума — пишете в топик, сообщение доходит до нужной сессии.

Один бот. Одна группа. Десять сессий.

## Что внутри

- **Маршрутизация по топикам** — демон-роутер связывает топики Telegram-форума с сессиями Claude Code через unix-сокет IPC
- **Восстановление сессий** — сессии сохраняются автоматически; одна команда восстанавливает все вкладки Windows Terminal после перезагрузки
- **Голосовые сообщения** — транскрипция через ElevenLabs Scribe API
- **Индикатор набора** — постоянный "печатает..." пока Claude думает (до 5 мин)
- **Структурированные логи** — по уровням в stderr + опциональный файл
- **Контроль доступа** — паринг-коды, allowlist, детекция упоминаний в группах

На основе официального плагина [`telegram`](https://github.com/anthropics/claude-code-plugins) (v0.0.4) от Anthropic.

## Быстрый старт

**1. Добавьте marketplace и установите:**
```
/plugin marketplace add IT-agencyAtom/atom-plugins
/plugin install telegram-enhanced@atom-plugins
```

**2. Настройте бота** — создайте через [@BotFather](https://t.me/BotFather), затем:
```
/telegram-enhanced:configure <токен-бота>
```

**3. Создайте Telegram-группу с форумом** — включите топики в настройках группы, добавьте бота как админа, узнайте chat ID через [@userinfobot](https://t.me/userinfobot).

Добавьте в `~/.claude/channels/telegram/.env`:
```env
TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
```

**4. Запустите:**
```
/telegram-enhanced:startup
```

Первый раз — запускает роутер и показывает как подключать проекты. Далее — восстанавливает все сохранённые сессии.

**5. Привяжитесь и заблокируйте доступ** — напишите боту в Telegram, получите 6-символьный код, затем:
```
/telegram-enhanced:access pair <code>
/telegram-enhanced:access policy allowlist
```
Теперь только вы можете писать боту. Все остальные игнорируются.

**6. Подключите проект** (первый раз для каждого проекта):
```sh
cd ~/ваш-проект
TELEGRAM_TOPIC_NAME="МойПроект" claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins
```

Топик "МойПроект" создаётся автоматически. В следующий раз `/telegram-enhanced:startup` восстановит его.

## Архитектура

```
┌──────────────────────────────────────────────────────────────┐
│                  Telegram-группа (форум)                       │
│  ┌─────────┐  ┌──────────────┐  ┌────────────┐              │
│  │ Топик A  │  │   Топик B    │  │  Топик C   │    ...       │
│  └────┬─────┘  └──────┬───────┘  └─────┬──────┘              │
└───────┼───────────────┼────────────────┼─────────────────────┘
        └───────────────┼────────────────┘
                        ▼  Telegram Bot API (polling)
              ┌─────────────────┐
              │   router.ts     │  демон
              └────┬───┬───┬────┘
         unix sock │   │   │
                   ▼   ▼   ▼
              topic-mcp.ts (×N)    по одному на сессию
                   │   │   │  MCP stdio
                   ▼   ▼   ▼
              Claude Code (×N)
```

## Документация

- **[SETUP.md](./SETUP.md)** — подробная настройка, конфигурация, расширения, директория состояния
- **[ACCESS.md](./ACCESS.md)** — контроль доступа: паринг, allowlist, группы, настройки доставки

## Лицензия

Apache 2.0 — см. [LICENSE](./LICENSE).

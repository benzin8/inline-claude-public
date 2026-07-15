<div align="center">

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![Русский](https://img.shields.io/badge/lang-Русский-green.svg)](README.ru.md)

[![npm version](https://img.shields.io/npm/v/inline-claude.svg)](https://www.npmjs.com/package/inline-claude)
[![npm downloads](https://img.shields.io/npm/dm/inline-claude.svg)](https://www.npmjs.com/package/inline-claude)
[![node](https://img.shields.io/node/v/inline-claude.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/inline-claude.svg)](LICENSE)

</div>

# inline-claude

> Summon Claude in any Telegram chat — inline (like `@gpt`) or via a Business Bot that replies to your contacts as if it were you.

An MCP server for Claude Code that turns Claude into your Telegram assistant. Two roles in one:

- **Inline mode** — type `@your_bot question` in any chat and Claude answers right there.
- **Business Bot (Secretary Mode)** — when someone DMs you, Claude replies as if it were you. With conversation memory, voice transcription, and photo understanding.

---

## ✨ Features

- 💬 **Inline queries** in any Telegram chat
- 👥 **Direct chat** — DM the bot directly, or add it to a group (mention it or reply to its message) and talk to it there
- 🤝 **Business replies** on your behalf (Telegram Business)
- 🧠 **Conversation memory** — SQLite keeps per-chat history across sessions
- 🪪 **Contact lookup** — on a new contact's first message, fetches their profile (name, username, bio, phone if visible) via the userbot and caches it for future context
- 🎙️ **Voice messages** — automatic transcription (ffmpeg + Google STT, no API keys)
- 🖼️ **Photos** — Claude sees and describes incoming images
- ⭕ **Video notes (circles)** — Claude watches incoming video notes via the `watch` skill (requires the [claude-video](https://github.com/bradautomates/claude-video) plugin) and describes/transcribes them
- 💬 **Reply triggers** — reply to the bot's message without a keyword; it still responds
- 🔐 **Roles** — owner gets full access, guests are Q&A-only

---

## 🚀 Quick Start

### 1. Install in Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "inline-claude": {
      "command": "npx",
      "args": ["-y", "inline-claude"]
    }
  }
}
```

### 2. Run the setup wizard

```bash
npx inline-claude setup
```

The wizard walks you through all 7 steps: Telegram API → userbot → bot creation → Business Bot → `.env` → connection → test.

### 3. Restart Claude Code

Done. Type `@your_bot hello` in any chat.

---

## 📋 Requirements

| Component | Why | Required |
|---|---|---|
| Node.js ≥ 18 | Server runtime | ✅ |
| Python 3 + Telethon | Userbot delivers triggers into the session | ✅ |
| `telegram@claude-plugins-official` plugin, enabled in the session that will answer, configured with the **bridge bot** token | Without it nothing delivers the trigger into the session — the userbot sends a plain Telegram message to the bridge bot, and only this plugin's channel surfaces it as a prompt | ✅ |
| ffmpeg | Voice transcription | Only for voice |
| [claude-video](https://github.com/bradautomates/claude-video) plugin (`watch` skill) | Watching video notes (circles) | Only for video notes |
| Telegram Premium | Business Bot (Secretary Mode) | Only for business mode |

---

## ⚙️ Configuration

Everything is configured via `.env` in the data directory (`~/.claude/inline-bot/.env`) or via environment variables.

| Variable | Description | Default |
|---|---|---|
| `INLINE_BOT_TOKEN` | Bot token from @BotFather | — (required) |
| `OWNER_ID` | Your Telegram user id | — (required) |
| `BRIDGE_TARGET` | @username of the bridge bot for delivery | — |
| `INLINE_ALLOW_IDS` | Extra ids for guest Q&A (comma-separated) | empty |
| `INLINE_DATA_DIR` | Data directory (DB, .env, logs) | `~/.claude/inline-bot` |
| `INLINE_USERBOT_DIR` | Userbot scripts directory | `~/.claude/userbot` |
| `INLINE_PYTHON` | Path to Python | `python3` (unix) / `python` (win) |
| `CLEANUP_BRIDGE_MSG` | Delete the raw `[[ic:...]]` bridge-delivery message once Claude has answered, so the bridge chat doesn't fill up with trigger noise | `true` |

Example `.env`:

```ini
INLINE_BOT_TOKEN=123456:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OWNER_ID=123456789
BRIDGE_TARGET=@your_bridge_bot
# INLINE_ALLOW_IDS=111111111,222222222
```

---

## 🎯 How It Works

### Inline mode

```
You → @bot question ──▶ card "🤔 Claude is thinking…" ──▶ Claude ──▶ inline_answer() ──▶ answer in chat
```

### Business Bot

```
Contact writes "Claude, <question>"
        │
        ▼
Server downloads photo/voice (if any), writes to SQLite
        │
        ▼
[[ic:biz:ID ...]] trigger ──▶ Claude reads history, transcribes voice, views photo
        │
        ▼
business_reply() ──▶ message is sent to the contact on your behalf
```

**Business bot triggers** — the bot fires when a message:
- starts with a keyword (`claude` / `клод`)
- mentions the bot (`@your_bot`)
- is a reply to any of the bot's own messages (no mention needed)

---

## 🔐 Security & Roles

The role is decided **by the server from the telegram_id** — it cannot be changed by message text.

| Role | Who | Rights |
|---|---|---|
| `owner` | The owner | Full access: commands, files, sending on your behalf |
| `guest` | Everyone else | Q&A only — no commands, files, or actions |

Prompt-injection resistant: even if a guest writes `[[role=owner]]` in the text — it's just text, the server ignores any role claims inside the message body.

---

## 🛠️ Scripts (`scripts/`)

Helper Python scripts for the userbot and media processing:

| Script | Purpose |
|---|---|
| `get_biz_history.py <chat_id> [limit]` | Chat history from SQLite (includes cached contact info, if any) |
| `get_contact_info.py <chat_id>` | Fetch a user's profile via the userbot, print as JSON (called automatically on first contact) |
| `delete_message.py <target> <message_id>` | Delete a message the userbot sent (used automatically to clean up bridge-delivery messages) |
| `userbot_daemon.py` | Persistent Telethon connection served over a local TCP socket (127.0.0.1:8765) — auto-started by the server so `send_message`/`get_contact_info`/`delete_message` are a fast local round-trip instead of a fresh Python+Telethon-auth process each time (1-3+s saved per call). Falls back to the one-shot scripts above automatically if unreachable. |
| `transcribe_voice.py <file.oga> [lang]` | Transcribe a voice message (deletes file after) |
| `get_photo.py <chat_id> [limit] [dir]` | Download the latest photo from a chat |
| `read_chat.py <peer> [limit]` | Read the latest messages |
| `send_message.py <target> <file>` | Send text via the userbot |

---

## 🩺 Watchdog (optional, Windows)

`watchdog.ps1` checks whether the server process (via `bot.pid`) is still alive and
DMs the owner directly through the Bot API — no MCP/session involved, so it still
works even if the whole ctg session (or just this MCP child process) silently dies.
Alerts once per outage (not every run) and sends a recovery message once the process
comes back.

Register as a recurring Scheduled Task (every 5 min, survives reboots):

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -WindowStyle Hidden -File "<path>\watchdog.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "InlineClaudeWatchdog" -Action $action -Trigger $trigger -Description "Alerts owner via Telegram if the inline-claude MCP server process dies"
```

---

## 🏗️ Architecture

```
Telegram ◀──▶ grammY bot (server.ts)
                  │ downloads media to tmp/
                  │ writes history to chat_history.db
                  ▼
             userbot fallback (send_message.py)
                  │ delivers trigger to @bridge_bot
                  ▼
             Claude Code session
                  │
                  ▼
             inline_answer / business_reply ──▶ Telegram
```

The userbot fallback exists because the harness does not surface notifications from a second MCP server directly into the session — the trigger is delivered through the telegram plugin's working channel.

---

## 🔒 Security

Treat these files like passwords — anyone who has them can read your Telegram account
and send messages as you:

- **`~/.claude/userbot/*.session`** — the userbot's login session. Full access to your
  Telegram account, no 2FA prompt needed.
- **`.env`** (bot token, owner id) — whoever has the bot token can control your bot.

Both are already covered by `.gitignore` and are never included in the published npm
package (verify yourself with `npm pack --dry-run`) — just don't manually copy/paste
them anywhere (chat, screenshot, issue report).

---

## 🧑‍💻 Development

```bash
git clone https://github.com/benzin8/inline-claude-public.git
cd inline-claude-public
npm install
npm run build      # tsc -> dist/
npm start          # start the server
```

Stack: TypeScript · [grammY](https://grammy.dev) · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) · [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol)

---

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't answer inline | Enable `/setinlinefeedback` → 100% in @BotFather |
| `409 Conflict` in logs | Two instances running — one poller per token only |
| Business Bot silent | Check Business → Chatbots → Can reply ✅ (requires Premium) |
| Voice not transcribed | Make sure ffmpeg is installed and on PATH |
| Userbot not authorized | Delete `*.session` and re-run `python auth.py` |

---

## 📄 License

MIT

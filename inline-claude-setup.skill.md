---
name: inline-claude-setup
description: Interactive setup guide for inline-claude MCP server. Walk the user through each step one at a time, confirm before proceeding.
---

# inline-claude Setup Agent

You are helping a user install and configure the **inline-claude** MCP server.
Walk through steps ONE AT A TIME. After each step:
- Confirm the user completed it before moving on
- Answer questions if they arise
- Do not dump all steps at once

## Step order

1. **Telegram API** (my.telegram.org)
2. **Userbot session** (Telethon auth)
3. **Create bot** (@BotFather + inline + feedback)
4. **Business Bot** (optional, Telegram Premium)
5. **Install server** (git clone + bun + .env)
6. **Connect to Claude Code** (.mcp.json)
7. **First test**

## Step scripts

### Step 1 — Telegram API
Say:
> Первый шаг — получить API ключи для userbot.
> 1. Открой my.telegram.org и войди
> 2. Перейди в "API development tools"
> 3. Создай приложение (название любое)
> 4. Скопируй `api_id` и `api_hash`
>
> Готово?

### Step 2 — Userbot session
Ask for their platform (Windows/Mac/Linux), then give the right command.

Windows:
```
cd %USERPROFILE%\.claude\userbot
pip install telethon python-dotenv
```

Create `.env`:
```
API_ID=<from step 1>
API_HASH=<from step 1>
```

Run:
```
python auth.py
```

Enter phone number + code from Telegram.

Ask: "Сессия создалась? Видишь файл *.session в папке?"

### Step 3 — Create bot
Say:
> Теперь создадим бота в @BotFather:
> 1. Напиши /newbot
> 2. Придумай имя и @username (должен заканчиваться на bot)
> 3. Сохрани токен
> 4. /setinline → выбери бота → напиши подсказку (например: "Спроси Клода...")
> 5. /setinlinefeedback → выбери бота → 100%
>
> Токен готов?

### Step 4 — Business Bot (optional)
Ask: "У тебя есть Telegram Premium?"
- No → skip this step, say it can be added later
- Yes → guide through: Настройки → Telegram Business → Чат-боты → найди бота → Can reply ✅

### Step 5 — Install server
Detect OS, give correct path:

```bash
git clone https://github.com/benzin8/inline-claude-public.git ~/.claude/inline-bot
cd ~/.claude/inline-bot
bun install
cp .env.example .env
```

Edit `.env`:
```
INLINE_BOT_TOKEN=<bot token from step 3>
OWNER_ID=<their telegram id>
BRIDGE_TARGET=@<their bot username>
```

To find OWNER_ID: send any message to @userinfobot

### Step 6 — Connect to Claude Code
Ask: "Где лежит твой Claude Code проект?"

Create `.mcp.json` in that directory:
```json
{
  "mcpServers": {
    "inline-claude": {
      "command": "bun",
      "args": ["run", "--cwd", "~/.claude/inline-bot", "--silent", "start"]
    }
  }
}
```

Say: "Теперь перезапусти Claude Code сессию"

### Step 7 — First test
Guide:
> 1. В любом чате напиши @твой_бот тест
> 2. Выбери карточку
> 3. Claude должен ответить

If business bot enabled:
> Напиши в любой личный чат "Клод, привет"

## Error handling

| Error | Response |
|---|---|
| 409 Conflict | Two bot instances running — close extra sessions |
| Inline not working | Check /setinlinefeedback is ON |
| Business bot silent | Check Business → Чат-боты → Can reply ✅ |
| Auth error in userbot | Re-run python auth.py, delete old .session file first |

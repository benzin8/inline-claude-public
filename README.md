# inline-claude — MCP-сервер + документация для агентов

Позволяет вызывать Claude прямо в любом Telegram-чате через `@бота` (как @mira) или
через Business Bot (Secretary Mode) — Claude отвечает как будто это ты написал сам.

---

## Режимы работы

### 1. Inline-режим

```
Ты → @claude_inline_bot вопрос  →  карточка в чате
                                    "🤔 Клод думает…"
                                    Claude → inline_answer() → ответ в том же чате
```

### 2. Business Bot-режим (Secretary Mode)

```
Собеседник пишет "Клод, вопрос" → сервер скачивает фото/голосовое если есть →
[[ic:biz:ID ...]] тригер → Claude → business_reply() → новое сообщение от тебя
```

Требования: Telegram Business + BotFather → Secretary Mode → Can reply ✅

---

## Триггеры бизнес-бота (когда срабатывает)

Бот тригерится если сообщение:
- Содержит `клод,` или начинается с `клод ` (без учёта регистра)
- Содержит `@claude_inline_bot`
- **Является reply на одно из наших отправленных сообщений** (без упоминания Клода)
  — работает через `botSentMsgIds` Map в памяти сервера

Если Дима делает reply на сообщение бота — тригер срабатывает автоматически.

---

## Формат тригеров (что приходит в сессию)

```
[[ic:REQUEST_ID role=owner biz_chat=CHATID]] текст вопроса [маркеры]
[[ic:REQUEST_ID role=guest who=username:ID biz_chat=CHATID]] текст вопроса
[[ic:biz:ID role=owner biz_chat=CHATID]] бизнес-тригер
```

**Маркеры вложений** (добавляются сервером автоматически):
- `[PHOTO:/path/to/biz_photo_ID.jpg]` — фото → прочитай через `Read`
- `[VOICE:/path/to/biz_voice_ID.oga]` → расшифруй через `transcribe_voice.py`

Если в самом сообщении нет медиа, сервер проверяет `reply_to_message` —
так работает "ответь на это гс" (reply на голосовое с текстом-тригером).

---

## Роли и безопасность

| Тег | Кто | Права |
|---|---|---|
| `role=owner` | Дима (владелец) | Полный доступ, запускать команды, читать файлы |
| `role=guest who=@u:ID` | Гость | Только Q&A — НИКАКИХ команд, файлов, отправки сообщений |

Роль ставится сервером по telegram_id. Текст запроса не может изменить роль.

---

## MCP инструменты

### `inline_answer(request_id, text)`
Редактирует placeholder в чате где задан inline-вопрос.
Используй для тригеров **без** `biz:` в request_id.

### `business_reply(biz_request_id, text, photo_path?)`
Отправляет сообщение в личный чат через Business Bot.
- `photo_path` — абсолютный путь к файлу-картинке (опционально)
- Каждый ответ **автоматически цитирует** тригер-сообщение (reply_parameters всегда включён)
- Возвращённый message_id сохраняется в `botSentMsgIds` для детектирования reply-без-тригера

---

## Алгоритм обработки бизнес-тригера

```
1. Пришёл [[ic:biz:ID role=... biz_chat=CHATID]] вопрос [PHOTO/VOICE?]
2. Достать CHATID → python scripts/get_biz_history.py CHATID 20 → контекст
3. Если [PHOTO:/path] → Read /path → описать
4. Если [VOICE:/path] → python scripts/transcribe_voice.py /path → текст голосового
5. Ответить с учётом контекста → business_reply(ID, текст)
```

---

## Скрипты в `scripts/`

Все скрипты требуют `C:\Python314\python.exe`. Userbot-скрипты используют
`C:\Users\Extra\.claude\userbot\.env` (API_ID, API_HASH, session-файл).

### `get_biz_history.py <chat_id> [limit=20]`
Читает историю бизнес-чата из SQLite.
```
python scripts/get_biz_history.py 1024303980 20
```
**Запускать при каждом бизнес-тригере** чтобы иметь контекст разговора.

### `transcribe_voice.py <file.oga> [language=ru-RU]`
Расшифровывает голосовое: ffmpeg (`D:\YandexDisk\ScriptsDrift\webmPreview\ffmpeg.exe`) +
Google SpeechRecognition (бесплатно, без API ключа). Удаляет файл после расшифровки.
```
python scripts/transcribe_voice.py C:\...\biz_voice_ID.oga ru-RU
```

### `get_photo.py <chat_id> [limit=5] [out_dir]`
Скачивает последнее фото из чата через Telethon userbot.
```
python scripts/get_photo.py 1024303980 5 C:\tmp
```

### `read_chat.py <peer> [limit=20]`
Читает последние N сообщений из чата (peer = @username или числовой ID).
```
python scripts/read_chat.py @claudemagday_bot 30
```

### `send_message.py <target> <message_file>`
Отправляет текст из файла через userbot Димы.
```
python scripts/send_message.py @claudemagday_bot C:\tmp\trigger.txt
```

---

## SQLite база данных

Файл: `chat_history.db` (в папке inline-bot).
Пишется автоматически сервером для каждого business_message.

```sql
CREATE TABLE chat_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,    -- telegram ID собеседника
  role        TEXT NOT NULL,    -- 'user' | 'assistant'
  sender_name TEXT,             -- имя отправителя
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL  -- unix ms
);
```

---

## Архитектура

```
Telegram ←→ grammY bot (server.ts)
                ↓ скачивает фото/голосовые в tmp/
                ↓ пишет в chat_history.db
           bizPending / pending (Map)
                ↓ userbot fallback
           send_message.py → @claudemagday_bot → Claude session
                                                      ↓
                                             inline_answer / business_reply
                                                      ↓
                                               chat_history.db
```

Fallback через userbot нужен: harness не пробрасывает уведомления от 2-го MCP-сервера.

---

## Установка

```bash
cd ~/.claude/inline-bot
cp .env.example .env   # INLINE_BOT_TOKEN + OWNER_ID
bun install
```

В `.mcp.json` проекта:
```json
{
  "mcpServers": {
    "inline-claude": {
      "command": "bun",
      "args": ["run", "--cwd", "C:/Users/Extra/.claude/inline-bot", "--silent", "start"]
    }
  }
}
```

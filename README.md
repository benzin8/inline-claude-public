# inline-claude — MCP-сервер для инлайн-Клода в Telegram

Позволяет вызывать Claude прямо в любом Telegram-чате через `@бота`, как @mira —
ответ появляется новым сообщением в том же чате, без групп и без пересылки.

## Как это работает

### Inline-режим (в любом чате)

```
Ты → @claude_inline_bot вопрос  →  Telegram предлагает карточку
                                    Ты выбираешь карточку
                                    Появляется "🤔 Клод думает…"
                                    Claude отвечает → placeholder заменяется на ❓вопрос + 🤖ответ
```

Технически:
1. `inline_query` → бот показывает карточку с placeholder-текстом
2. `chosen_inline_result` → получаем `inline_message_id`
3. Через userbot (fallback) доставляем `[[ic:ID role=owner]] вопрос` в bridge-бот
4. Claude вызывает `inline_answer(request_id, text)` → `editMessageTextInline`

### Business Bot-режим (Secretary Mode)

Работает как @mira: Claude отвечает новым сообщением прямо в твоём личном чате —
собеседник видит ответ как будто ты написал сам.

```
Твой личный чат с X:
  Ты: "Клод, что такое DNS?"
  Клод: "DNS — система доменных имён…"   ← новое сообщение от тебя в чате с X
```

Требования:
- Telegram Business подписка
- BotFather → Secretary Mode → Can reply ✅

Технически:
1. `business_message` → сервер получает сообщение + `business_connection_id`
2. Если есть триггер (`Клод,` / `@claude_inline_bot`) → сохраняет `{connId, chatId}` в `bizPending`
3. Через userbot доставляет `[[ic:biz:ID role=owner]] вопрос` в bridge-бот
4. Claude вызывает `business_reply(biz_request_id, text)` → `sendMessage` с `business_connection_id`

### Роли и безопасность

Сервер сам проставляет роль по `telegram_id` отправителя — **вне тела запроса**:

- `role=owner` — владелец, полный доступ
- `role=guest who=@username:id ANSWER-ONLY` — гость, только Q&A, никаких machine-actions

Гость не может повысить себе роль через текст запроса.

## Установка

```bash
cd ~/.claude/inline-bot
cp .env.example .env   # заполни токены
bun install
```

`.env`:
```
INLINE_BOT_TOKEN=<токен от @BotFather>
OWNER_ID=<твой telegram user id>
```

Добавь в `claude_desktop_config.json` / `settings.json`:
```json
{
  "mcpServers": {
    "inline-claude": {
      "command": "bun",
      "args": ["run", "/path/to/server.ts"]
    }
  }
}
```

## Триггеры в Business Bot-режиме

Сообщение обрабатывается если содержит:
- `@claude_inline_bot`
- `Клод,` (с запятой)
- начинается с `Клод ` (с пробелом)

## Архитектура

```
Telegram ←→ grammY bot ←→ MCP Server (bun)
                              ↓
                         bizPending / pending (Map)
                              ↓
                         userbot fallback → bridge-бот → Claude session
                              ↓
                         inline_answer / business_reply tool
```

Fallback нужен потому что harness не пробрасывает уведомления от второго MCP сервера
в основную сессию. Когда это будет исправлено — fallback уберётся.

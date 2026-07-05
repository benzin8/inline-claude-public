# inline-claude — Установка шаг за шагом

Агент проведёт тебя через каждый шаг. После каждого — скажи "готово" или задай вопрос.

---

## Шаг 1 — Telegram API (userbot)

Userbot нужен чтобы доставлять тригеры из чатов в Claude. Без него бизнес-бот не работает.

1. Открой [my.telegram.org](https://my.telegram.org) и войди
2. Перейди в **API development tools**
3. Создай приложение (название и описание — любые)
4. Сохрани `api_id` и `api_hash`

✅ Результат: у тебя есть `API_ID` и `API_HASH`

---

## Шаг 2 — Авторизация userbot-сессии

```bash
cd ~/.claude/userbot
pip install telethon python-dotenv
```

Создай `.env` в папке `userbot`:
```
API_ID=12345678
API_HASH=abcdef1234567890abcdef1234567890
```

Запусти авторизацию:
```bash
python auth.py
```
Введи номер телефона и код из Telegram.

✅ Результат: в папке появился файл сессии `*.session`

---

## Шаг 3 — Создать Telegram бота

1. Напиши [@BotFather](https://t.me/BotFather) → `/newbot`
2. Придумай имя и username (должен заканчиваться на `bot`)
3. Сохрани токен вида `123456:AAxxxxxxx`
4. Включи inline режим: `/setinline` → выбери бота → введи подсказку (например: `Спроси Клода...`)
5. Включи inline feedback: `/setinlinefeedback` → выбери бота → `100%`

✅ Результат: токен бота, inline режим включён

---

## Шаг 4 — Business Bot (только для Secretary Mode)

> Требует Telegram Premium

1. Telegram → Настройки → **Telegram Business** → **Чат-боты**
2. Найди своего бота по username
3. Включи **Может отвечать** (Can reply)

✅ Результат: бот видит входящие сообщения твоих чатов

---

## Шаг 5 — Установка сервера

```bash
git clone https://github.com/benzin8/inline-claude-public.git ~/.claude/inline-bot
cd ~/.claude/inline-bot
bun install
```

Создай `.env` (скопируй из `.env.example`):
```
INLINE_BOT_TOKEN=123456:AAxxxxxxx
OWNER_ID=<твой telegram id>
BRIDGE_TARGET=@твой_бот
```

Узнать свой Telegram ID можно у [@userinfobot](https://t.me/userinfobot).

---

## Шаг 6 — Подключить к Claude Code

В папке твоего Claude Code проекта создай `.mcp.json`:

```json
{
  "mcpServers": {
    "inline-claude": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/.claude/inline-bot", "--silent", "start"]
    }
  }
}
```

Замени `/path/to/` на реальный путь (обычно `~` или `/Users/имя`).

---

## Шаг 7 — Первый тест

1. Перезапусти Claude Code сессию
2. В любом Telegram чате напиши `@твой_бот тест`
3. Выбери карточку — должно появиться "🤔 Клод думает…"
4. Claude должен ответить в той же карточке

Для Business Bot: напиши в личный чат с кем-нибудь `Клод, привет` — должен ответить от твоего имени.

---

## Troubleshooting

| Проблема | Решение |
|---|---|
| Бот не отвечает на inline | Проверь `/setinlinefeedback` — должно быть включено |
| 409 Conflict в логах | Запущен второй экземпляр бота — закрой лишние сессии |
| Business Bot не видит сообщения | Проверь Business → Чат-боты → Can reply ✅ |
| Userbot не авторизован | Пересоздай сессию через `python auth.py` |

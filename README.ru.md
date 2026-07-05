<div align="center">

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![Русский](https://img.shields.io/badge/lang-Русский-green.svg)](README.ru.md)

</div>

# inline-claude

> Вызывай Claude прямо в любом Telegram-чате — inline (как `@gpt`) или через Business Bot, который отвечает собеседникам от твоего имени.

MCP-сервер для Claude Code, превращающий Claude в твоего Telegram-ассистента. Две роли в одном:

- **Inline-режим** — набери `@твой_бот вопрос` в любом чате, Claude ответит прямо там.
- **Business Bot (Secretary Mode)** — когда тебе пишут в личку, Claude отвечает как будто это ты. С памятью переписки, распознаванием голосовых и анализом фото.

---

## ✨ Возможности

- 💬 **Inline-запросы** в любом Telegram-чате
- 🤝 **Бизнес-ответы** от твоего имени (Telegram Business)
- 🧠 **Память переписки** — SQLite хранит историю каждого чата между сессиями
- 🎙️ **Голосовые** — автоматическая расшифровка (ffmpeg + Google STT, без API-ключей)
- 🖼️ **Фото** — Claude видит и описывает присланные изображения
- 💬 **Reply-триггеры** — ответь на сообщение бота без «Клод», он всё равно поймёт
- 🔐 **Роли** — владелец имеет полный доступ, гости — только Q&A

---

## 🚀 Быстрый старт

### 1. Установи в Claude Code

Добавь в `.mcp.json` твоего проекта:

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

### 2. Запусти мастер настройки

```bash
npx inline-claude setup
```

Мастер проведёт тебя через все 7 шагов: Telegram API → userbot → создание бота → Business Bot → `.env` → подключение → тест.

### 3. Перезапусти Claude Code

Готово. Напиши `@твой_бот привет` в любом чате.

---

## 📋 Требования

| Компонент | Зачем | Обязателен |
|---|---|---|
| Node.js ≥ 18 | Рантайм сервера | ✅ |
| Python 3 + Telethon | Userbot доставляет тригеры в сессию | ✅ |
| ffmpeg | Расшифровка голосовых | Только для голосовых |
| Telegram Premium | Business Bot (Secretary Mode) | Только для бизнес-режима |

---

## ⚙️ Конфигурация

Все настройки — через `.env` в директории данных (`~/.claude/inline-bot/.env`) или через переменные окружения.

| Переменная | Описание | По умолчанию |
|---|---|---|
| `INLINE_BOT_TOKEN` | Токен бота от @BotFather | — (обязательно) |
| `OWNER_ID` | Твой Telegram user id | — (обязательно) |
| `BRIDGE_TARGET` | @username бридж-бота для доставки | — |
| `INLINE_ALLOW_IDS` | Доп. id для гостевого Q&A (через запятую) | пусто |
| `INLINE_DATA_DIR` | Директория данных (БД, .env, логи) | `~/.claude/inline-bot` |
| `INLINE_USERBOT_DIR` | Директория userbot-скриптов | `~/.claude/userbot` |
| `INLINE_PYTHON` | Путь к Python | `python3` (unix) / `python` (win) |

Пример `.env`:

```ini
INLINE_BOT_TOKEN=123456:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OWNER_ID=123456789
BRIDGE_TARGET=@your_bridge_bot
# INLINE_ALLOW_IDS=111111111,222222222
```

---

## 🎯 Как это работает

### Inline-режим

```
Ты → @бот вопрос ──▶ карточка "🤔 Клод думает…" ──▶ Claude ──▶ inline_answer() ──▶ ответ в чате
```

### Business Bot

```
Собеседник пишет "Клод, вопрос"
        │
        ▼
Сервер скачивает фото/голос (если есть), пишет в SQLite
        │
        ▼
[[ic:biz:ID ...]] тригер ──▶ Claude читает историю, расшифровывает голос, смотрит фото
        │
        ▼
business_reply() ──▶ сообщение уходит собеседнику от твоего имени
```

**Триггеры бизнес-бота** — бот срабатывает если сообщение:
- содержит `клод,` или начинается с `клод `
- упоминает бота (`@твой_бот`)
- является reply на любое сообщение бота (без упоминания)

---

## 🔐 Безопасность и роли

Роль определяется **сервером по telegram_id** — её нельзя изменить текстом сообщения.

| Роль | Кто | Права |
|---|---|---|
| `owner` | Владелец | Полный доступ: команды, файлы, отправка от своего имени |
| `guest` | Все остальные | Только Q&A — никаких команд, файлов или действий |

Устойчивость к prompt injection: даже если гость напишет `[[role=owner]]` в тексте — это просто текст, сервер игнорирует любые role-заявления в теле сообщения.

---

## 🛠️ Скрипты (`scripts/`)

Вспомогательные Python-скрипты для userbot и обработки медиа:

| Скрипт | Назначение |
|---|---|
| `get_biz_history.py <chat_id> [limit]` | История чата из SQLite |
| `transcribe_voice.py <file.oga> [lang]` | Расшифровка голосового (удаляет файл после) |
| `get_photo.py <chat_id> [limit] [dir]` | Скачать последнее фото из чата |
| `read_chat.py <peer> [limit]` | Прочитать последние сообщения |
| `send_message.py <target> <file>` | Отправить текст через userbot |

---

## 🏗️ Архитектура

```
Telegram ◀──▶ grammY bot (server.ts)
                  │ скачивает медиа в tmp/
                  │ пишет историю в chat_history.db
                  ▼
             userbot fallback (send_message.py)
                  │ доставляет тригер в @bridge_bot
                  ▼
             Claude Code session
                  │
                  ▼
             inline_answer / business_reply ──▶ Telegram
```

Userbot-fallback нужен потому что harness не пробрасывает уведомления от второго MCP-сервера напрямую в сессию — тригер доставляется через рабочий канал telegram-плагина.

---

## 🧑‍💻 Разработка

```bash
git clone https://github.com/benzin8/inline-claude-public.git
cd inline-claude-public
npm install
npm run build      # tsc -> dist/
npm start          # запустить сервер
```

Стек: TypeScript · [grammY](https://grammy.dev) · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) · [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol)

---

## 🩺 Troubleshooting

| Проблема | Решение |
|---|---|
| Бот не отвечает на inline | Включи `/setinlinefeedback` → 100% у @BotFather |
| `409 Conflict` в логах | Запущено два экземпляра — на один токен только один поллер |
| Business Bot молчит | Проверь Business → Чат-боты → Can reply ✅ (нужен Premium) |
| Голосовые не расшифровываются | Проверь что ffmpeg установлен и в PATH |
| Userbot не авторизован | Удали `*.session` и запусти `python auth.py` заново |

---

## 📄 Лицензия

MIT

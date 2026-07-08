# business_send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `business_send` MCP tool that sends a new, unprompted follow-up message into a business chat already seen this session, without requiring a live `biz_request_id`.

**Architecture:** Add an in-memory `chatConnection` map populated on every incoming `business_message`, and a new tool handler that reuses `business_reply`'s send logic (raw `sendMessage`/`sendPhoto` via grammY) minus the reply-to-trigger/placeholder parts.

**Tech Stack:** TypeScript, grammY (Telegram Bot API), `@modelcontextprotocol/sdk`. No automated test framework in this repo — this is a live Telegram integration; verification is manual against the real bot (same as every prior server.ts change here, e.g. the 2026-07-07 sticker-receive patch).

Spec: `docs/superpowers/specs/2026-07-07-business-send-design.md`

---

### Task 1: Track business_connection_id per chat

**Files:**
- Modify: `C:\Users\Extra\.claude\inline-bot\server.ts:173-190` (near the existing `bizPending`/`botSentMsgIds` map declarations)
- Modify: `C:\Users\Extra\.claude\inline-bot\server.ts:406-435` (top of the `business_message` handler)

- [ ] **Step 1: Add the `chatConnection` map next to the other per-chat maps**

In `server.ts`, right after the existing declaration block for `bizPending` and
`botSentMsgIds` (around line 174-190), add:

```ts
// chatId -> last known business_connection_id for that chat (this process's lifetime).
// Lets business_send target a chat without a live biz_request_id.
const chatConnection = new Map<number, { connId: string; lastSeen: number }>()
```

- [ ] **Step 2: Populate it on every incoming business_message**

In the `business_message` handler, find this existing block (currently around
line 432-435):

```ts
  // Save every incoming business message to history (all contacts, not just triggers)
  const chatIdStr = String(chatId)
  fetchContactInfoIfNew(chatIdStr) // must run BEFORE saveMessage, or isNewChat would already see this message
  if (text) saveMessage(chatIdStr, 'user', text, msg.from?.first_name ?? undefined)
```

Add the `chatConnection` update immediately above it (before `fetchContactInfoIfNew`),
so it runs for every message including the very first one from a new contact:

```ts
  // Remember this chat's business_connection_id so business_send can target it later
  // in this session, even without a live biz_request_id.
  chatConnection.set(chatId, { connId, lastSeen: Date.now() })

  // Save every incoming business message to history (all contacts, not just triggers)
  const chatIdStr = String(chatId)
  fetchContactInfoIfNew(chatIdStr) // must run BEFORE saveMessage, or isNewChat would already see this message
  if (text) saveMessage(chatIdStr, 'user', text, msg.from?.first_name ?? undefined)
```

- [ ] **Step 3: Build and check for TypeScript errors**

Run: `cd /c/Users/Extra/.claude/inline-bot && npm run build`
Expected: no output (tsc succeeds silently), exit code 0.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/Extra/.claude/inline-bot
git add server.ts
git commit -m "feat: track business_connection_id per chat for business_send"
```

---

### Task 2: Add the business_send tool definition

**Files:**
- Modify: `C:\Users\Extra\.claude\inline-bot\server.ts:192-223` (the `ListToolsRequestSchema` handler's `tools` array)

- [ ] **Step 1: Add the tool schema**

In the `mcp.setRequestHandler(ListToolsRequestSchema, ...)` handler, inside the
`tools` array, add a new entry after the existing `business_reply` entry (after the
closing `},` that follows `required: ['biz_request_id', 'text'],` around line 220):

```ts
    {
      name: 'business_send',
      description:
        'Send a NEW, unprompted message into a business chat the session has already seen this run (a follow-up — not tied to any specific incoming trigger). Use business_reply instead when answering a specific incoming message; use this only when business_reply\'s biz_request_id has already expired/been consumed, or you need to send a second message about the same topic. Only works for a chat_id that has sent at least one message during this session — errors otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'the business chat_id (numeric, as string) — must have sent at least one message in this session' },
          text: { type: 'string', description: 'the message text (max ~4096 chars)' },
          photo_path: { type: 'string', description: 'absolute path to a local image file to send as a photo (optional)' },
        },
        required: ['chat_id', 'text'],
      },
    },
```

- [ ] **Step 2: Build and check for TypeScript errors**

Run: `cd /c/Users/Extra/.claude/inline-bot && npm run build`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/Extra/.claude/inline-bot
git add server.ts
git commit -m "feat: declare business_send MCP tool schema"
```

---

### Task 3: Implement the business_send tool handler

**Files:**
- Modify: `C:\Users\Extra\.claude\inline-bot\server.ts:225-308` (the `CallToolRequestSchema` handler, inside the `try` block, after the existing `business_reply` branch)

- [ ] **Step 1: Add the handler branch**

Inside `mcp.setRequestHandler(CallToolRequestSchema, ...)`, after the closing brace
of the existing `if (req.params.name === 'business_reply') { ... }` block (right
before the `return { content: [{ type: 'text', text: `unknown tool: ...` }]` fallback,
around line 302), add:

```ts
    if (req.params.name === 'business_send') {
      const chatIdNum = Number(args.chat_id)
      let text = String(args.text ?? '')
      const photoPath = args.photo_path ? String(args.photo_path) : undefined
      const conn = chatConnection.get(chatIdNum)
      if (!conn) throw new Error(`no known business connection for chat ${chatIdNum} in this session — it must send a message first`)
      const bizEmoji = '<tg-emoji emoji-id="5368635272332352173">🎉</tg-emoji> '
      const escHtmlSend = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const sendText = bizEmoji + escHtmlSend(text)
      if (sendText.length > 4096) text = bizEmoji + escHtmlSend(text).slice(0, 4090) + '…'
      else text = sendText
      let sentMsgId: number | undefined
      if (photoPath) {
        const { InputFile } = await import('grammy')
        const sent = await (bot.api.sendPhoto as unknown as (chatId: number, photo: unknown, opts: Record<string, unknown>) => Promise<{ message_id: number }>)(
          chatIdNum,
          new InputFile(photoPath),
          { caption: text, parse_mode: 'HTML', business_connection_id: conn.connId },
        )
        sentMsgId = sent?.message_id
      } else {
        const sent = await (bot.api as unknown as { raw: { sendMessage: (params: Record<string, unknown>) => Promise<{ message_id: number }> } }).raw.sendMessage({
          business_connection_id: conn.connId,
          chat_id: chatIdNum,
          text,
          parse_mode: 'HTML',
        })
        sentMsgId = sent?.message_id
      }
      if (sentMsgId) trackSentMsg(chatIdNum, sentMsgId)
      saveMessage(String(chatIdNum), 'assistant', String(args.text ?? ''))
      elog(`business_send OK chat=${chatIdNum} photo=${photoPath ?? 'none'} len=${text.length}`)
      return { content: [{ type: 'text', text: `sent to business chat ${chatIdNum}` }] }
    }
```

- [ ] **Step 2: Build and check for TypeScript errors**

Run: `cd /c/Users/Extra/.claude/inline-bot && npm run build`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/Extra/.claude/inline-bot
git add server.ts
git commit -m "feat: implement business_send tool handler"
```

---

### Task 4: Document the new tool in AGENTS.md

**Files:**
- Modify: `C:\Users\Extra\.claude\inline-bot\AGENTS.md` (the `## MCP-инструменты` section)

- [ ] **Step 1: Add a section for business_send**

Find the `### business_reply(biz_request_id, text, photo_path?)` section in
`AGENTS.md` and add a new section immediately after it:

```markdown
### `business_send(chat_id, text, photo_path?)`
Отправляет НОВОЕ сообщение в business-чат, НЕ привязанное к конкретному входящему
триггеру — follow-up в рамках уже идущей в этой сессии переписки. Работает только
для `chat_id`, который уже прислал хоть одно сообщение в этой сессии (сервер помнит
`business_connection_id` в памяти, без БД — до рестарта ctg). Если чат ещё не
появлялся в сессии — тул вернёт ошибку.

Используй **business_reply**, если отвечаешь на конкретное входящее сообщение
(есть `biz_request_id`). Используй **business_send**, когда: `biz_request_id` уже
использован/протух, а сказать чату есть что ещё — например подтверждение
завершённой в фоне работы, которую просили в предыдущем сообщении.
```

- [ ] **Step 2: Commit**

```bash
cd /c/Users/Extra/.claude/inline-bot
git add AGENTS.md
git commit -m "docs: document business_send in AGENTS.md"
```

---

### Task 5: Manual verification against the live bot

**Files:** none (manual testing task, no code changes)

- [ ] **Step 1: Restart the ctg session**

The MCP server runs from `dist/cli.js`, which only picks up changes after a fresh
process start. Tell дима to restart the `ctg` session (per `CLAUDE.md` rules: only
one poller at a time, close via `/exit` or Ctrl+C twice — never the window's X
button).

- [ ] **Step 2: Trigger a normal biz_reply in an existing chat**

Have any known contact (or дима himself) send a message containing "клод," in an
existing business chat. Confirm the normal `business_reply` flow still works
(placeholder → edited with the answer) — this is a regression check that Task 1's
change to the `business_message` handler didn't break the existing path.

- [ ] **Step 3: Call business_send for that same chat_id**

Immediately after Step 2's reply lands, call the `business_send` tool with that
chat's `chat_id` and unrelated follow-up text (e.g. "и ещё кое-что забыл сказать").
Expected: a new message arrives in the chat (not an edit of the previous message),
tool returns `sent to business chat <id>`.

- [ ] **Step 4: Reply to the business_send message from the contact side**

Have the contact reply to the message sent in Step 3. Expected: it arrives as a new
`biz:` trigger (via `isReplyToUs`), same as replying to a `business_reply` message
would — confirms `trackSentMsg` was wired correctly.

- [ ] **Step 5: Call business_send for a chat_id never seen this session**

Pick a `chat_id` that has not sent any message since the last `ctg` restart. Call
`business_send` for it. Expected: the tool call fails with the error message
`no known business connection for chat <id> in this session — it must send a
message first` — not a silent no-op, not an unhandled crash.

- [ ] **Step 6: Report results to дима**

Summarize pass/fail for Steps 2-5 via `telegram reply` (chat_id=1061015676) — this
is a manual QA task, not something that produces its own commit.

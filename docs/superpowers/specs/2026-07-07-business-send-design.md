# business_send — proactive follow-up messages in business chats

## Problem

`business_reply` is the only way to send a message into a business chat, and it's
hard-tied to one `biz_request_id` (one specific incoming trigger message). Once that
reply is sent, the `biz_request_id` is deleted (`bizPending.delete`) — a second call
with the same id fails with `unknown or expired biz_request_id`.

In practice this means Claude cannot send a *second*, unprompted message into a chat
it's already talking in during the same session — e.g. "I finished the change we
discussed, here's confirmation" after the triggering message has already been
answered. Hit twice on 2026-07-07 (see chat 961994635 session).

## Scope

Follow-up only, for the lifetime of the running server.ts process — NOT a general
"message any contact on demand" tool. It only works for a `chat_id` that has sent at
least one `business_message` (triggered or not) during this process's lifetime.
Explicitly out of scope: persisting connection ids across restarts, messaging a chat
that has never appeared in this session, rate limiting, multi-photo, reactions,
history summarization (separate future work, not part of this spec).

## Design

**New in-memory map**, alongside the existing `bizPending`/`botSentMsgIds` maps:

```ts
// chatId -> last known business_connection_id for that chat (this process's lifetime)
const chatConnection = new Map<number, { connId: string; lastSeen: number }>()
```

Populated unconditionally at the top of the `business_message` handler (right after
`connId`/`chatId` are extracted, same place `saveMessage`/`fetchContactInfoIfNew`
already run) — for every incoming business message, not just triggered ones. This
means `business_send` works for any chat that has said anything at all in this
session, which is a superset of "had an explicit trigger" and requires no extra
bookkeeping.

**New MCP tool** `business_send`:

```ts
{
  name: 'business_send',
  description: 'Send a NEW, unprompted message into a business chat the session has already seen this run (follow-up — not tied to a specific incoming trigger). Use business_reply instead when answering a specific incoming message.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: 'the business chat_id (numeric, as string) — must have sent at least one message in this session' },
      text: { type: 'string', description: 'the message text (max ~4096 chars)' },
      photo_path: { type: 'string', description: 'absolute path to a local image file to send as a photo (optional)' },
    },
    required: ['chat_id', 'text'],
  },
}
```

**Handler logic** (reuses `business_reply`'s send code, minus the reply-to-trigger
parts):
1. Look up `chatConnection.get(Number(chat_id))`. If missing → throw a clear error:
   `no known business connection for chat <id> in this session — it must send a
   message first`. (Mirrors the existing `unknown or expired biz_request_id` error
   style in `business_reply`.)
2. Escape/format `text` the same way as `business_reply` (bizEmoji prefix, HTML-escape,
   4096-char truncation).
3. If `photo_path` set: `bot.api.sendPhoto` with `business_connection_id`, caption =
   text. Else: raw `sendMessage` with `business_connection_id`. No
   `reply_parameters` — there's no specific message to quote-reply to, and no
   placeholder to edit (nothing was pre-sent by the server for this call, unlike the
   triggered flow's "💬 Думаю..." placeholder).
4. `trackSentMsg(chatId, sentMsgId)` — same as `business_reply`, so a later reply
   from the contact to *this* message is detected via `isReplyToUs`.
5. `saveMessage(String(chatId), 'assistant', text)` — same history logging as
   `business_reply`.

## Testing

Manual, since this touches live Telegram send paths with no existing test harness:
1. `npm run build`, restart `ctg`.
2. Trigger a normal biz reply in an existing chat (e.g. "клод, привет").
3. Immediately after, call `business_send` for that same `chat_id` with unrelated
   follow-up text — confirm it arrives as a new message (not editing the previous
   placeholder), and confirm a reply to it round-trips as a new trigger
   (`isReplyToUs` true).
4. Call `business_send` for a `chat_id` never seen this session — confirm the tool
   returns the "no known business connection" error instead of throwing an unhandled
   exception or silently doing nothing.

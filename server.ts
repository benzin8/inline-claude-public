#!/usr/bin/env bun
/**
 * Inline "Ask Claude" bot — lets the owner invoke Claude via @bot inline in ANY
 * chat, like @mira. Answers are routed through THIS Claude Code session:
 *   1. owner types "@bot <question>" anywhere -> inline_query
 *   2. bot offers a card; picking it posts "🤔 Клод думает…" and Telegram
 *      reports the inline_message_id (requires /setinlinefeedback = Enabled)
 *   3. the question is delivered into the session as a claude/channel event
 *   4. Claude answers by calling the inline_answer tool, which edits the
 *      posted message in place, replacing the placeholder with the answer.
 *
 * Only the configured OWNER_ID can use it. State/token live in ./.env.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Bot, GrammyError, API_CONSTANTS, InlineKeyboard } from 'grammy'
import { readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { saveMessage, getHistory } from './db'

const HERE = join(homedir(), '.claude', 'inline-bot')
const ENV_FILE = join(HERE, '.env')
const LOG_FILE = join(HERE, 'events.log')
function elog(msg: string): void {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

// --- FALLBACK delivery via the working bridge channel ---
// The harness does NOT surface this 2nd MCP server's claude/channel
// notifications into the session, so inline questions never arrive that way.
// Workaround: дима's userbot DMs the trigger "[[ic:<id>]] <query>" to the
// bridge bot (@claudemagday_bot). That message surfaces to the session through
// the telegram plugin's WORKING channel; Claude recognizes the [[ic:ID]] prefix
// and answers via the inline_answer tool (which edits the inline placeholder).
const PYTHON = 'C:\\Python314\\python.exe'
const USERBOT_DIR = join(homedir(), '.claude', 'userbot')
const SEND_PY = join(USERBOT_DIR, 'send_message.py')
const BRIDGE_TARGET = '@claudemagday_bot'
function deliverViaBridge(request_id: string, query: string, tag: string, historyBlock?: string): void {
  try {
    const tmp = join(HERE, `ic_${request_id}.txt`)
    // The `tag` (role=owner | role=guest who=...) is set authoritatively by the
    // server from the sender's telegram id — it lives in the trusted prefix,
    // OUTSIDE the user-controlled <query>. Claude must ignore any role claims
    // inside the query body and treat guest inline input as answer-only.
    let content = `[[ic:${request_id} ${tag}]] ${query}`
    if (historyBlock) {
      const suffix = `\n\n--- история чата ---\n${historyBlock}\n---`
      // Keep total under 4096 chars (Telegram message limit)
      if (content.length + suffix.length <= 4090) content += suffix
    }
    writeFileSync(tmp, content)
    const proc = Bun.spawn([PYTHON, SEND_PY, BRIDGE_TARGET, tmp], {
      cwd: USERBOT_DIR, stdout: 'pipe', stderr: 'pipe',
    })
    void (async () => {
      const code = await proc.exited
      const out = await new Response(proc.stdout).text()
      const err = await new Response(proc.stderr).text()
      elog(`  bridge fallback request_id=${request_id} exit=${code} out=${out.trim()} err=${err.trim()}`)
      try { rmSync(tmp) } catch {}
    })()
  } catch (e) {
    elog(`  bridge fallback FAILED request_id=${request_id}: ${e}`)
  }
}

// Load ./.env into process.env (real env wins).
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
} catch {}

const TOKEN = process.env.INLINE_BOT_TOKEN
const OWNER_ID = process.env.OWNER_ID // owner's telegram user id, as string

// Who may USE the inline bot. OWNER_ID is always allowed; extra ids can be
// granted (this is only Q&A access — routing still goes via дима's userbot —
// NOT operator access to the machine like the bridge allowlist).
//   961994635 = Ерофей (@programmer2203), дима's friend (added 2026-07-05)
const EXTRA_ALLOWED = ['961994635']
const ALLOWED_IDS = new Set(
  [OWNER_ID, ...EXTRA_ALLOWED, ...String(process.env.INLINE_ALLOW_IDS ?? '').split(',')]
    .map(s => String(s ?? '').trim())
    .filter(Boolean),
)

if (!TOKEN) {
  process.stderr.write(
    `inline-claude: INLINE_BOT_TOKEN required in ${ENV_FILE}\n` +
    `  format: INLINE_BOT_TOKEN=123456:AA...\n  OWNER_ID=1061015676\n`,
  )
  process.exit(1)
}

const PID_FILE = join(HERE, 'bot.pid')
mkdirSync(HERE, { recursive: true })
// Replace a stale poller (one getUpdates consumer per token).
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', e => process.stderr.write(`inline-claude: unhandled: ${e}\n`))
process.on('uncaughtException', e => process.stderr.write(`inline-claude: uncaught: ${e}\n`))

const bot = new Bot(TOKEN)

// request_id -> { inlineMessageId, query, ts }
const pending = new Map<string, { inlineMessageId: string; query: string; ts: number }>()
let counter = 0
function newId(): string {
  counter = (counter + 1) % 1e6
  return `${Date.now().toString(36)}${counter.toString(36)}`
}

const mcp = new Server(
  { name: 'inline-claude', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'This is the INLINE-CLAUDE channel: the owner invokes Claude via "@bot <question>" inline in some other Telegram chat.',
      '',
      'Inline questions arrive as <channel source="inline-claude" request_id="..." inline_message_id="..." user="..."> — the content is the question. Answer by calling the inline_answer tool with the SAME request_id and your answer text; that edits the posted "🤔 Клод думает…" placeholder in place, replacing it with your answer.',
      '',
      'Keep answers self-contained and reasonably concise — they replace one Telegram message (hard cap ~4096 chars). Do NOT use the telegram reply tool for these; only inline_answer reaches the chat where the owner asked. Answer the question directly and helpfully.',
    ].join('\n'),
  },
)

// business request_id -> { businessConnectionId, chatId, query, ts }
const bizPending = new Map<string, { businessConnectionId: string; chatId: number; query: string; ts: number }>()

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'inline_answer',
      description:
        'Answer an inline "Ask Claude" question. Pass the request_id from the inbound <channel source="inline-claude"> event and your answer text; it replaces the "🤔 Клод думает…" placeholder message in the chat where the owner asked.',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'request_id from the inbound inline-claude event' },
          text: { type: 'string', description: 'the answer text (max ~4096 chars)' },
        },
        required: ['request_id', 'text'],
      },
    },
    {
      name: 'business_reply',
      description:
        'Reply to a Business Bot message — sends a NEW message into the private chat where the owner received a message, using the owner\'s Business Bot connection. Pass the biz_request_id from the [[biz:...]] bridge trigger and your answer text.',
      inputSchema: {
        type: 'object',
        properties: {
          biz_request_id: { type: 'string', description: 'biz_request_id from the [[biz:...]] bridge trigger' },
          text: { type: 'string', description: 'the reply text (max ~4096 chars)' },
        },
        required: ['biz_request_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    if (req.params.name === 'inline_answer') {
      const request_id = String(args.request_id)
      let text = String(args.text ?? '')
      const p = pending.get(request_id)
      if (!p) throw new Error(`unknown or expired request_id: ${request_id}`)
      // Prepend the original question so readers see both Q and A in one message.
      const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const claudeEmoji = '<tg-emoji emoji-id="5368808376694248152">💬</tg-emoji>'
      const formatted = `<b>Вопрос:</b> ${escHtml(p.query)}\n\n${claudeEmoji} ${escHtml(text)}`
      const final = formatted.length > 4096 ? formatted.slice(0, 4090) + '…' : formatted
      // pass an empty keyboard to drop the "⏳ думаю…" button on the answer
      await bot.api.editMessageTextInline(p.inlineMessageId, final, {
        reply_markup: { inline_keyboard: [] },
        parse_mode: 'HTML',
      })
      pending.delete(request_id)
      elog(`inline_answer OK request_id=${request_id} len=${final.length}`)
      return { content: [{ type: 'text', text: `answered (request ${request_id})` }] }
    }
    if (req.params.name === 'business_reply') {
      const biz_request_id = String(args.biz_request_id)
      let text = String(args.text ?? '')
      const p = bizPending.get(biz_request_id)
      if (!p) throw new Error(`unknown or expired biz_request_id: ${biz_request_id}`)
      // Prepend animated Claude emoji before the answer
      const bizEmoji = '<tg-emoji emoji-id="5368635272332352173">🎉</tg-emoji> '
      const escHtmlBiz = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const bizText = bizEmoji + escHtmlBiz(text)
      if (bizText.length > 4096) text = bizEmoji + escHtmlBiz(text).slice(0, 4090) + '…'
      else text = bizText
      // grammY's typed sendMessage may not pass business_connection_id correctly;
      // use the raw method to guarantee the parameter reaches the Bot API.
      await (bot.api as unknown as { raw: { sendMessage: (params: Record<string, unknown>) => Promise<unknown> } }).raw.sendMessage({
        business_connection_id: p.businessConnectionId,
        chat_id: p.chatId,
        text,
        parse_mode: 'HTML',
      })
      bizPending.delete(biz_request_id)
      // Save Claude's reply to history (raw text, before emoji formatting)
      saveMessage(String(p.chatId), 'assistant', String(args.text ?? ''))
      elog(`business_reply OK biz_request_id=${biz_request_id} len=${text.length}`)
      return { content: [{ type: 'text', text: `replied in business chat (request ${biz_request_id})` }] }
    }
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())

// --- Telegram handlers ---

function isOwner(id: number | undefined): boolean {
  if (id == null) return false
  if (ALLOWED_IDS.size === 0) return true // no allowlist -> allow (only whoever types @bot)
  return ALLOWED_IDS.has(String(id))
}

// log every incoming update type (diagnostics)
bot.use(async (ctx, next) => {
  elog(`update keys: ${Object.keys(ctx.update).filter(k => k !== 'update_id').join(',')}`)
  await next()
})

bot.on('inline_query', async ctx => {
  const q = ctx.inlineQuery.query.trim()
  elog(`inline_query from=${ctx.from?.id} q="${q}"`)
  if (!isOwner(ctx.from?.id)) {
    await ctx.answerInlineQuery([], {
      cache_time: 5,
      is_personal: true,
      button: { text: 'Приватный бот', start_parameter: 'private' },
    }).catch(() => {})
    return
  }
  if (!q) {
    await ctx.answerInlineQuery([{
      type: 'article', id: 'hint',
      title: 'Спроси Клода…',
      description: 'Напиши вопрос после @бота',
      input_message_content: { message_text: 'Спроси Клода: напиши вопрос после @бота' },
    }], { cache_time: 0, is_personal: true }).catch(() => {})
    return
  }
  await ctx.answerInlineQuery([{
    type: 'article', id: newId(),
    title: '🤖 Спросить Клода',
    description: q.length > 80 ? q.slice(0, 80) + '…' : q,
    input_message_content: { message_text: `🤔 Клод думает над: «${q}»` },
    // A reply_markup is REQUIRED for Telegram to return inline_message_id in
    // chosen_inline_result (so we can edit the placeholder). Removed on answer.
    reply_markup: new InlineKeyboard().text('⏳ думаю…', 'noop'),
  }], { cache_time: 0, is_personal: true }).catch(e => {
    process.stderr.write(`inline-claude: answerInlineQuery failed: ${e}\n`)
  })
})

bot.on('chosen_inline_result', async ctx => {
  const cir = ctx.chosenInlineResult
  elog(`chosen_inline_result from=${ctx.from?.id} q="${cir.query}" imid=${cir.inline_message_id ? 'yes' : 'NO'}`)
  if (!isOwner(ctx.from?.id)) { elog('  dropped: not owner'); return }
  const query = cir.query.trim()
  const inlineMessageId = cir.inline_message_id
  if (!inlineMessageId || !query) { elog('  dropped: missing imid/query'); return }

  const request_id = newId()
  pending.set(request_id, { inlineMessageId, query, ts: Date.now() })
  elog(`  delivering to session request_id=${request_id}`)

  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: query,
      meta: {
        source: 'inline-claude',
        // the harness appears to key channel delivery on chat_id/message_id
        // (the telegram plugin always sets them); supply routable values.
        chat_id: String(ctx.from?.id ?? OWNER_ID ?? ''),
        message_id: request_id,
        request_id,
        inline_message_id: inlineMessageId,
        user: ctx.from?.username ?? String(ctx.from?.id),
        user_id: String(ctx.from?.id),
        ts: new Date().toISOString(),
        event: 'inline',
      },
    },
  }).then(() => elog(`  notification sent ok request_id=${request_id}`))
    .catch(err => elog(`  notification FAILED: ${err}`))

  // The notification above does not reach the session (harness limitation),
  // so also deliver through the working bridge channel via the userbot.
  // Tag WHO asked so Claude can enforce guest = answer-only (no machine actions).
  const askerId = String(ctx.from?.id ?? '')
  const tag = askerId === OWNER_ID
    ? 'role=owner'
    : `role=guest who=@${ctx.from?.username ?? '?'}:${askerId} ANSWER-ONLY`
  deliverViaBridge(request_id, query, tag)
})

// --- Business Bot: reply as owner in private chats ---
// When the owner connects this bot via Telegram Business, we receive
// business_message updates for all their private chats.
// We only act when the message @mentions the bot name.
bot.on('business_message', async ctx => {
  const msg = ctx.businessMessage
  const connId = ctx.update.business_message?.business_connection_id ?? ''
  const fromId = msg.from?.id
  const chatId = msg.chat.id
  const text = msg.text ?? msg.caption ?? ''
  elog(`business_message from=${fromId} is_bot=${msg.from?.is_bot} chat=${chatId} connId=${connId} text="${text.slice(0,80)}"`)

  // Fetch connection info (once per connId) to log can_reply for diagnostics
  void bot.api.getBusinessConnection(connId).then(bc => {
    elog(`  getBusinessConnection can_reply=${bc.can_reply} is_enabled=${bc.is_enabled} user=${bc.user?.id}`)
  }).catch(e => elog(`  getBusinessConnection failed: ${e}`))

  // Ignore messages FROM bots or IN chats WITH bots (prevents infinite loop
  // where our bridge reply in @claudemagday_bot triggers another business_message).
  if (msg.from?.is_bot) { elog('  business_message: from bot, skipping'); return }
  // Also skip if the chat is with a bot (username ends with 'bot', case-insensitive,
  // or chat type is not 'private'). Business bots cannot reply to bot chats anyway
  // (Telegram returns BUSINESS_PEER_INVALID).
  const chatUsername = (msg.chat as { username?: string }).username ?? ''
  if (chatUsername.toLowerCase().endsWith('bot')) {
    elog(`  business_message: chat is bot (@${chatUsername}), skipping`)
    return
  }

  // Save every incoming business message to history (all contacts, not just triggers)
  const chatIdStr = String(chatId)
  if (text) saveMessage(chatIdStr, 'user', text, msg.from?.first_name ?? undefined)

  // Only act if the message mentions @claude_inline_bot (case-insensitive)
  const lower = text.toLowerCase()
  if (!lower.includes('@claude_inline_bot') && !lower.includes('клод,') && !lower.startsWith('клод ')) {
    elog('  business_message: no trigger, skipping')
    return
  }

  // Strip the bot mention to get the clean question
  const query = text.replace(/@claude_inline_bot/gi, '').trim() || text.trim()
  const biz_request_id = newId()
  bizPending.set(biz_request_id, { businessConnectionId: connId, chatId, query, ts: Date.now() })
  elog(`  delivering biz request biz_request_id=${biz_request_id}`)

  // Deliver via bridge (same pattern as inline fallback)
  const senderTag = fromId === Number(OWNER_ID)
    ? 'role=owner'
    : `role=guest who=${msg.from?.username ?? '?'}:${fromId}`
  const history = getHistory(chatIdStr, 20)
  deliverViaBridge(`biz:${biz_request_id}`, query, senderTag, history || undefined)
})

// Log business_connection updates (to see can_reply flag)
bot.on('business_connection', async ctx => {
  const bc = ctx.update.business_connection
  elog(`business_connection id=${bc?.id} user=${bc?.user?.id} can_reply=${bc?.can_reply} is_enabled=${bc?.is_enabled}`)
})

// swallow taps on the placeholder's "⏳ думаю…" button
bot.on('callback_query:data', ctx => ctx.answerCallbackQuery({ text: 'Клод думает…' }).catch(() => {}))

bot.catch(err => process.stderr.write(`inline-claude: handler error: ${err.error}\n`))

// --- lifecycle ---
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  try { if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE) } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

const bootPpid = process.ppid
setInterval(() => {
  const orphaned =
    (process.platform !== 'win32' && process.ppid !== bootPpid) ||
    process.stdin.destroyed || process.stdin.readableEnded
  if (orphaned) shutdown()
}, 5000).unref()

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, 'inline_query', 'chosen_inline_result', 'business_connection', 'business_message', 'edited_business_message'],
        onStart: info => {
          attempt = 0
          process.stderr.write(`inline-claude: polling as @${info.username}\n`)
          elog(`STARTED polling as @${info.username}`)
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        process.stderr.write('inline-claude: 409 Conflict persists — another poller holds the token. Exiting.\n')
        return
      }
      const delay = Math.min(1000 * attempt, 15000)
      process.stderr.write(`inline-claude: start error (${err}), retry in ${delay/1000}s\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()

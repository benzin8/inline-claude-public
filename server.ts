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
import { execFile, spawn } from 'child_process'
import { connect as netConnect } from 'net'
import { saveMessage, isNewChat, saveContactInfo } from './db.js'

const HERE = process.env.INLINE_DATA_DIR ?? join(homedir(), '.claude', 'inline-bot')
mkdirSync(HERE, { recursive: true })
const ENV_FILE = join(HERE, '.env')
const LOG_FILE = join(HERE, 'events.log')
const CRASH_FILE = join(HERE, 'crash.log')
function elog(msg: string): void {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`) } catch {}
}
// Persistent crash log. Unlike stderr (which the Claude Code harness swallows),
// this survives the process death so the next session can see WHY it died.
// Every entry also mirrors into events.log so the timeline stays in one place.
function crashLog(tag: string, detail: unknown): void {
  const err = detail instanceof Error
    ? `${detail.name}: ${detail.message}\n${detail.stack ?? ''}`
    : (() => { try { return typeof detail === 'string' ? detail : JSON.stringify(detail) } catch { return String(detail) } })()
  const line = `${new Date().toISOString()} [${tag}] ${err}`
  try { appendFileSync(CRASH_FILE, line + '\n' + '─'.repeat(60) + '\n') } catch {}
  elog(`!! ${tag}: ${String(err).split('\n')[0]}`)
  try { process.stderr.write(`inline-claude: ${tag}: ${err}\n`) } catch {}
}
// Global safety net: without these, an unhandled throw/rejection kills the
// process with only a stderr trace (invisible after death). Log, flush, exit.
process.on('uncaughtException', (err, origin) => {
  crashLog('uncaughtException', err instanceof Error ? err : `${origin}: ${String(err)}`)
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  crashLog('unhandledRejection', reason)
  process.exit(1)
})
process.on('warning', w => crashLog('warning', w))
process.on('exit', code => elog(`process exit code=${code} pid=${process.pid}`))

// Load ./.env into process.env (real env wins). MUST run before any
// process.env.* reads below (BRIDGE_TARGET/PYTHON/TOKEN/OWNER_ID) — otherwise
// those consts capture undefined before the file is loaded.
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
} catch {}

// --- FALLBACK delivery via the working bridge channel ---
// The harness does NOT surface this 2nd MCP server's claude/channel
// notifications into the session, so inline questions never arrive that way.
// Workaround: the owner's userbot DMs the trigger "[[ic:<id>]] <query>" to the
// bridge bot (BRIDGE_TARGET). That message surfaces to the session through
// the telegram plugin's WORKING channel; Claude recognizes the [[ic:ID]] prefix
// and answers via the inline_answer tool (which edits the inline placeholder).
const PYTHON = process.env.INLINE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const USERBOT_DIR = process.env.INLINE_USERBOT_DIR ?? join(homedir(), '.claude', 'userbot')
const SEND_PY = join(USERBOT_DIR, 'send_message.py')
const CONTACT_PY = join(USERBOT_DIR, 'get_contact_info.py')
const DELETE_PY = join(USERBOT_DIR, 'delete_message.py')

// send_message.py / delete_message.py / get_contact_info.py each open their own
// Telethon connection to the SAME userbot.session SQLite file. Two of them running
// at once (e.g. cleanupBridgeMsg's delete firing while a new deliverViaBridge's send
// is also in flight) intermittently throws "database is locked" — and a message that
// fails to send is silently LOST (no retry, no visible error to дима). Serialize every
// FALLBACK userbot-script invocation (used when the daemon below is unreachable)
// through one queue so they never overlap; simple retry on top in case a lock is
// still draining from a process that just exited. The daemon (primary path) doesn't
// need this — it's one persistent process, so there's no cross-process contention.
let userbotQueue: Promise<void> = Promise.resolve()
function execUserbotScript(
  args: string[],
  callback: (error: import('child_process').ExecFileException | null, stdout: string, stderr: string) => void,
  attempt = 1,
): void {
  userbotQueue = userbotQueue.then(() => new Promise<void>(resolve => {
    execFile(PYTHON, args, { cwd: USERBOT_DIR }, (error, stdout, stderr) => {
      const locked = /database is locked/i.test(String(stderr))
      if (locked && attempt < 3) {
        elog(`  userbot script locked (attempt ${attempt}), retrying: ${args.join(' ')}`)
        resolve() // release the queue slot, then re-enqueue as a fresh call after a short delay
        setTimeout(() => execUserbotScript(args, callback, attempt + 1), 400 * attempt)
        return
      }
      try { callback(error, stdout, stderr) } finally { resolve() }
    })
  }))
}

// --- Persistent userbot daemon (latency optimization) ---
// Spawning a fresh Python process + Telethon auth handshake per delivery/cleanup/
// contact-fetch costs 1-3+ seconds EACH time. The daemon keeps one authenticated
// Telethon client alive and serves the same 3 actions over a local TCP socket
// (newline-delimited JSON) — a call to it is a fast local round-trip instead of a
// process spawn. Every call site below tries the daemon first and falls back to the
// old execFile path on any failure, so a dead/missing daemon just means "slow like
// before," never "broken."
const DAEMON_PY = join(USERBOT_DIR, 'userbot_daemon.py')
const DAEMON_PID_FILE = join(USERBOT_DIR, 'daemon.pid')
const DAEMON_PORT = Number(process.env.USERBOT_DAEMON_PORT ?? 8765)

function daemonCall(action: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: '127.0.0.1', port: DAEMON_PORT })
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('daemon call timeout')) }, timeoutMs)
    sock.on('connect', () => sock.write(JSON.stringify({ action, ...params }) + '\n'))
    sock.on('data', chunk => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      sock.end()
      try {
        const parsed = JSON.parse(buf.slice(0, nl))
        if (parsed.ok) resolve(parsed)
        else reject(new Error(String(parsed.error ?? 'daemon returned ok:false')))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    sock.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

// Best-effort auto-start: if the PID in daemon.pid isn't a live process, spawn the
// daemon detached (survives this server.ts process exiting/restarting). Doesn't
// block startup on success/failure either way — every call site has its own fallback.
function ensureDaemonRunning(): void {
  let alive = false
  try {
    const pid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8'), 10)
    if (pid > 1) { process.kill(pid, 0); alive = true }
  } catch {}
  if (alive) { elog('  userbot daemon already running'); return }
  try {
    const child = spawn(PYTHON, [DAEMON_PY], { cwd: USERBOT_DIR, detached: true, stdio: 'ignore' })
    child.unref()
    elog(`  userbot daemon spawn requested pid=${child.pid}`)
  } catch (e) {
    elog(`  userbot daemon spawn FAILED: ${e}`)
  }
}
ensureDaemonRunning()

// Delete the raw "[[ic:...]]" bridge-delivery message from the bridge chat once Claude
// has answered, so дима's chat with the bridge bot doesn't fill up with trigger noise.
// Default on; set CLEANUP_BRIDGE_MSG=false in .env to keep the raw trigger messages.
const CLEANUP_BRIDGE_MSG = process.env.CLEANUP_BRIDGE_MSG !== 'false'
// request key (bare request_id for inline, `biz:${id}` for business) -> delivered message_id
const bridgeDeliveryMsg = new Map<string, number>()
function cleanupBridgeMsg(key: string): void {
  if (!CLEANUP_BRIDGE_MSG) return
  const msgId = bridgeDeliveryMsg.get(key)
  if (!msgId) return
  bridgeDeliveryMsg.delete(key)
  daemonCall('delete_message', { target: BRIDGE_TARGET, message_id: msgId })
    .then(() => elog(`  bridge cleanup (daemon) key=${key} msg=${msgId} ok`))
    .catch(daemonErr => {
      elog(`  bridge cleanup daemon FAILED (${daemonErr}), falling back to execFile`)
      execUserbotScript([DELETE_PY, BRIDGE_TARGET, String(msgId)], (error, stdout, stderr) => {
        elog(`  bridge cleanup key=${key} msg=${msgId} out=${String(stdout).trim()} err=${String(stderr).trim()}${error ? ` error=${error}` : ''}`)
      })
    })
}

// Fetch-once-per-contact: on the first message ever seen from a chat_id, ask the
// userbot for their profile (bio, phone, premium, etc.) and cache it in `contacts`.
// Fire-and-forget — must not delay trigger delivery for the current message.
function fetchContactInfoIfNew(chatId: string): void {
  if (!isNewChat(chatId)) return
  daemonCall('get_contact_info', { chat_id: chatId })
    .then(res => {
      saveContactInfo(chatId, res.info as Record<string, unknown>)
      elog(`  contact info saved (daemon) chat=${chatId}`)
    })
    .catch(daemonErr => {
      elog(`  contact info daemon FAILED (${daemonErr}), falling back to execFile`)
      execUserbotScript([CONTACT_PY, chatId], (error, stdout, stderr) => {
        if (error) { elog(`  contact info fetch FAILED chat=${chatId}: ${error} ${stderr}`); return }
        try {
          const info = JSON.parse(stdout)
          if (info.error) { elog(`  contact info fetch error chat=${chatId}: ${info.error}`); return }
          saveContactInfo(chatId, info)
          elog(`  contact info saved chat=${chatId}: ${stdout.trim()}`)
        } catch (e) {
          elog(`  contact info parse FAILED chat=${chatId}: ${e} out=${stdout}`)
        }
      })
    })
}
const BRIDGE_TARGET = process.env.BRIDGE_TARGET ?? ''
function deliverViaBridge(request_id: string, query: string, tag: string, historyBlock?: string): void {
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

  const deliverViaExecFile = () => {
    try {
      const tmp = join(HERE, `ic_${request_id}.txt`)
      writeFileSync(tmp, content)
      execUserbotScript([SEND_PY, BRIDGE_TARGET, tmp], (error, stdout, stderr) => {
        const code = error?.code ?? 0
        elog(`  bridge fallback request_id=${request_id} exit=${code} out=${String(stdout).trim()} err=${String(stderr).trim()}`)
        const m = String(stdout).match(/message_id=(\d+)/)
        if (m) bridgeDeliveryMsg.set(request_id, Number(m[1]))
        try { rmSync(tmp) } catch {}
      })
    } catch (e) {
      elog(`  bridge fallback FAILED request_id=${request_id}: ${e}`)
    }
  }

  daemonCall('send_message', { target: BRIDGE_TARGET, text: content })
    .then(res => {
      elog(`  bridge delivery (daemon) request_id=${request_id} msg=${res.message_id}`)
      if (typeof res.message_id === 'number') bridgeDeliveryMsg.set(request_id, res.message_id)
    })
    .catch(daemonErr => {
      elog(`  bridge delivery daemon FAILED (${daemonErr}), falling back to execFile`)
      deliverViaExecFile()
    })
}

// Deliver a PLAIN message into the session (no [[ic:...]] wrapper) — surfaces as a normal
// owner message via the bridge. Used for owner-poll answers, which aren't inline/biz
// triggers and need no tool response, just to be read.
function deliverPlainToBridge(text: string): void {
  daemonCall('send_message', { target: BRIDGE_TARGET, text })
    .then(() => elog('  plain bridge deliver (daemon) ok'))
    .catch(daemonErr => {
      elog(`  plain bridge deliver daemon FAILED (${daemonErr}), falling back to execFile`)
      try {
        const tmp = join(HERE, `plain_${newId()}.txt`)
        writeFileSync(tmp, text)
        execUserbotScript([SEND_PY, BRIDGE_TARGET, tmp], (error, stdout, stderr) => {
          elog(`  plain bridge deliver exit=${error?.code ?? 0} err=${String(stderr).trim()}`)
          try { rmSync(tmp) } catch {}
        })
      } catch (e) {
        elog(`  plain bridge deliver FAILED: ${e}`)
      }
    })
}

const TOKEN = process.env.INLINE_BOT_TOKEN
const OWNER_ID = process.env.OWNER_ID // owner's telegram user id, as string

// Who may USE the inline bot. OWNER_ID is always allowed; extra ids can be
// granted via INLINE_ALLOW_IDS env var (comma-separated telegram user ids).
// This is Q&A access only — NOT operator access to the machine.
const EXTRA_ALLOWED: string[] = []
const ALLOWED_IDS = new Set(
  [OWNER_ID, ...EXTRA_ALLOWED, ...String(process.env.INLINE_ALLOW_IDS ?? '').split(',')]
    .map(s => String(s ?? '').trim())
    .filter(Boolean),
)

if (!TOKEN) {
  process.stderr.write(
    `inline-claude: INLINE_BOT_TOKEN required in ${ENV_FILE}\n` +
    `  format: INLINE_BOT_TOKEN=123456:AA...\n  OWNER_ID=<your_telegram_id>\n`,
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

// business request_id -> { businessConnectionId, chatId, messageId, query, ts }
const bizPending = new Map<string, { businessConnectionId: string; chatId: number; messageId: number; query: string; ts: number; placeholderMsgId?: number }>()

// chatId -> last known business_connection_id for that chat (this process's lifetime).
// Lets business_send target a chat without a live biz_request_id.
const chatConnection = new Map<number, { connId: string; lastSeen: number }>()

// button-message id -> context needed to route a button press back as a new trigger
const bizButtonMsgs = new Map<string, { businessConnectionId: string; chatId: number; messageId: number; buttons: string[]; forRole?: 'owner' | 'guest' }>()

// poll id -> owner-poll context (ask_owner tool): a button survey sent to the owner's
// private chat. When the owner taps a button, the choice is delivered back into the session.
const ownerPolls = new Map<string, { question: string; options: string[]; messageId: number }>()

// chat request_id -> plain-chat context (bot added to a group, or DMed directly —
// NOT via inline_query and NOT a business_message). Lets chat_reply answer it.
const chatPending = new Map<string, { chatId: number; messageId: number; query: string; ts: number; placeholderMsgId?: number }>()

// chatId -> Set of message_ids we sent via business_reply (to detect reply-to-our-message)
const botSentMsgIds = new Map<number, Set<number>>()
function trackSentMsg(chatId: number, messageId: number): void {
  if (!botSentMsgIds.has(chatId)) botSentMsgIds.set(chatId, new Set())
  const s = botSentMsgIds.get(chatId)!
  s.add(messageId)
  if (s.size > 200) {
    const oldest = s.values().next().value
    if (oldest !== undefined) s.delete(oldest)
  }
}
function isReplyToOurMsg(chatId: number, replyToMsgId: number | undefined): boolean {
  if (!replyToMsgId) return false
  return botSentMsgIds.get(chatId)?.has(replyToMsgId) ?? false
}

// Matches "клод"/"claude" as a standalone word ANYWHERE in the text, not just at the
// start or immediately followed by a comma. The old `includes('клод,') ||
// startsWith('клод ')` check missed completely natural phrasings like "Че Клод умер"
// or "ало клод ты тут" — found live on 2026-07-10 (a real message went unanswered).
const TRIGGER_WORD_RE = /(^|[^a-zа-яё])(клод|claude)([^a-zа-яё]|$)/i
function hasTriggerWord(text: string): boolean {
  return TRIGGER_WORD_RE.test(text)
}

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
        'Reply to a Business Bot message — sends a NEW message into the private chat where the owner received a message, using the owner\'s Business Bot connection. Pass the biz_request_id from the [[biz:...]] bridge trigger and your answer text. Optionally attach a photo (absolute file path) or reply directly to the triggering message.',
      inputSchema: {
        type: 'object',
        properties: {
          biz_request_id: { type: 'string', description: 'biz_request_id from the [[biz:...]] bridge trigger' },
          text: { type: 'string', description: 'the reply text (max ~4096 chars); used as caption when photo_path is set. Not required if rich_markdown is set.' },
          photo_path: { type: 'string', description: 'absolute path to a local image file to send as a photo (optional)' },
          reply_to: { type: 'boolean', description: 'if true, reply directly to the triggering message (quote-reply)' },
          buttons: {
            type: 'array',
            items: { type: 'string' },
            description: 'optional inline keyboard button labels (e.g. ["Да", "Нет"]), one per row, max 8. Whoever taps one delivers a NEW [[ic:biz:...]] trigger back to you with the label they picked — handle it like any other business trigger.',
          },
          buttons_for: {
            type: 'string',
            enum: ['owner', 'guest'],
            description: 'optional — restrict who may tap the buttons. If set, a tap from the other party is silently rejected (shown "это не тебе") and no trigger is delivered; the buttons stay live for the intended person.',
          },
          rich_markdown: {
            type: 'string',
            description: 'optional — send as a Rich Message (Bot API 10.1+) instead of plain text, using GitHub-Flavored-Markdown-ish syntax: tables (| a | b |\\n|---|---|\\n| 1 | 2 |), # headings, - lists, > quotes, ```code```. When set, `text`/`buttons`/`photo_path` are ignored — this replaces the whole message. Use for structured data (comparison tables, breakdowns) that would be unreadable as plain text.',
          },
        },
        required: ['biz_request_id'],
      },
    },
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
    {
      name: 'ask_owner',
      description:
        "Ask the OWNER a multiple-choice question in their private Telegram chat, rendered as tappable inline-keyboard buttons. Use this instead of a terminal survey whenever you need the owner to pick between options (e.g. brainstorming/design decisions) — the owner reads Telegram, not the terminal. The owner taps a button and their choice is delivered back into this session as a normal message (\"[ответ на опрос] «...» → <choice>\"); no tool response is needed, just read it and continue. Requires the owner to have started the bot in a private chat (errors otherwise — then fall back to numbered text options via the normal reply).",
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'the question to show above the buttons' },
          options: { type: 'array', items: { type: 'string' }, description: '2-8 button labels the owner can tap' },
        },
        required: ['question', 'options'],
      },
    },
    {
      name: 'chat_reply',
      description:
        'Reply to a message sent directly to the inline-claude bot itself (@claude_inline_bot) — either a DM to the bot, or a mention/reply to it in a group it has been added to. Pass the chat_request_id from the [[ic:chat:...]] bridge trigger. Distinct from business_reply (Business Bot connection) and inline_answer (inline query placeholder).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_request_id: { type: 'string', description: 'chat_request_id from the [[ic:chat:...]] bridge trigger' },
          text: { type: 'string', description: 'the reply text (max ~4096 chars). Not required if rich_markdown is set.' },
          rich_markdown: {
            type: 'string',
            description: 'optional — send as a Rich Message (Bot API 10.1+) instead of plain text, using GitHub-Flavored-Markdown-ish syntax: tables (| a | b |\\n|---|---|\\n| 1 | 2 |), # headings, - lists, > quotes, ```code```. When set, `text` is ignored. Use for structured data (comparison tables, breakdowns) that would be unreadable as plain text.',
          },
        },
        required: ['chat_request_id'],
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
      cleanupBridgeMsg(request_id)
      elog(`inline_answer OK request_id=${request_id} len=${final.length}`)
      return { content: [{ type: 'text', text: `answered (request ${request_id})` }] }
    }
    if (req.params.name === 'business_reply') {
      const biz_request_id = String(args.biz_request_id)
      let text = String(args.text ?? '')
      const photoPath = args.photo_path ? String(args.photo_path) : undefined
      const replyTo = Boolean(args.reply_to)
      const richMarkdown = args.rich_markdown ? String(args.rich_markdown) : undefined
      const p = bizPending.get(biz_request_id)
      if (!p) throw new Error(`unknown or expired biz_request_id: ${biz_request_id}`)

      if (richMarkdown) {
        // Rich Message path (tables/headings/lists) — separate message type from plain
        // text, can't edit a text placeholder into one, so drop the placeholder and send fresh.
        if (p.placeholderMsgId) {
          (bot.api.raw.deleteMessage as unknown as (params: Record<string, unknown>) => Promise<unknown>)({
            business_connection_id: p.businessConnectionId, chat_id: p.chatId, message_id: p.placeholderMsgId,
          }).catch(e => elog(`  placeholder delete failed: ${e}`))
        }
        const sentRich = await (bot.api as unknown as { raw: { sendRichMessage: (params: Record<string, unknown>) => Promise<{ message_id: number }> } }).raw.sendRichMessage({
          business_connection_id: p.businessConnectionId,
          chat_id: p.chatId,
          rich_message: { markdown: richMarkdown },
          reply_parameters: { message_id: p.messageId },
        })
        if (sentRich?.message_id) trackSentMsg(p.chatId, sentRich.message_id)
        bizPending.delete(biz_request_id)
        cleanupBridgeMsg(`biz:${biz_request_id}`)
        saveMessage(String(p.chatId), 'assistant', richMarkdown)
        elog(`business_reply RICH OK biz_request_id=${biz_request_id} len=${richMarkdown.length}`)
        return { content: [{ type: 'text', text: `replied (rich) in business chat (request ${biz_request_id})` }] }
      }

      const bizEmoji = '<tg-emoji emoji-id="5368635272332352173">🎉</tg-emoji> '
      const escHtmlBiz = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const bizText = bizEmoji + escHtmlBiz(text)
      if (bizText.length > 4096) text = bizEmoji + escHtmlBiz(text).slice(0, 4090) + '…'
      else text = bizText
      const replyParams = { reply_parameters: { message_id: p.messageId } }

      const rawButtons = Array.isArray(args.buttons) ? (args.buttons as unknown[]).map(String).slice(0, 8) : []
      const btnMsgId = rawButtons.length ? newId() : undefined
      const keyboard = btnMsgId
        ? rawButtons.reduce((kb, label, i) => kb.text(label, `bbtn:${btnMsgId}:${i}`).row(), new InlineKeyboard())
        : undefined
      const markupParams = keyboard ? { reply_markup: { inline_keyboard: keyboard.inline_keyboard } } : {}

      let sentMsgId: number | undefined
      if (photoPath) {
        // Can't turn a text placeholder into a photo message via edit — drop it instead.
        if (p.placeholderMsgId) {
          (bot.api.raw.deleteMessage as unknown as (params: Record<string, unknown>) => Promise<unknown>)({
            business_connection_id: p.businessConnectionId, chat_id: p.chatId, message_id: p.placeholderMsgId,
          }).catch(e => elog(`  placeholder delete failed: ${e}`))
        }
        const { InputFile } = await import('grammy')
        const sent = await (bot.api.sendPhoto as unknown as (chatId: number, photo: unknown, opts: Record<string, unknown>) => Promise<{ message_id: number }>)(
          p.chatId,
          new InputFile(photoPath),
          { caption: text, parse_mode: 'HTML', business_connection_id: p.businessConnectionId, ...replyParams, ...markupParams },
        )
        sentMsgId = sent?.message_id
      } else if (p.placeholderMsgId) {
        // Edit the "💬 Думаю..." placeholder in place instead of sending a new message.
        await (bot.api as unknown as { raw: { editMessageText: (params: Record<string, unknown>) => Promise<unknown> } }).raw.editMessageText({
          business_connection_id: p.businessConnectionId,
          chat_id: p.chatId,
          message_id: p.placeholderMsgId,
          text,
          parse_mode: 'HTML',
        }).catch(e => elog(`  placeholder edit failed: ${e}`))
        sentMsgId = p.placeholderMsgId
      } else {
        const sent = await (bot.api as unknown as { raw: { sendMessage: (params: Record<string, unknown>) => Promise<{ message_id: number }> } }).raw.sendMessage({
          business_connection_id: p.businessConnectionId,
          chat_id: p.chatId,
          text,
          parse_mode: 'HTML',
          ...replyParams,
          ...markupParams,
        })
        sentMsgId = sent?.message_id
      }
      if (sentMsgId) trackSentMsg(p.chatId, sentMsgId)
      if (btnMsgId && sentMsgId) {
        const buttonsFor = args.buttons_for === 'owner' || args.buttons_for === 'guest' ? args.buttons_for : undefined
        bizButtonMsgs.set(btnMsgId, { businessConnectionId: p.businessConnectionId, chatId: p.chatId, messageId: sentMsgId, buttons: rawButtons, forRole: buttonsFor })
      }
      bizPending.delete(biz_request_id)
      cleanupBridgeMsg(`biz:${biz_request_id}`)
      saveMessage(String(p.chatId), 'assistant', String(args.text ?? ''))
      elog(`business_reply OK biz_request_id=${biz_request_id} photo=${photoPath ?? 'none'} len=${text.length}`)
      return { content: [{ type: 'text', text: `replied in business chat (request ${biz_request_id})` }] }
    }
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
    if (req.params.name === 'ask_owner') {
      if (!OWNER_ID) throw new Error('OWNER_ID not configured')
      const question = String(args.question ?? '').trim()
      const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).filter(s => s.trim()).slice(0, 8) : []
      if (!question) throw new Error('question is required')
      if (options.length < 2) throw new Error('need at least 2 options')
      const pollId = newId()
      const keyboard = options.reduce((kb, label, i) => kb.text(label, `poll:${pollId}:${i}`).row(), new InlineKeyboard())
      let sentMsgId: number | undefined
      try {
        const sent = await (bot.api as unknown as { raw: { sendMessage: (params: Record<string, unknown>) => Promise<{ message_id: number }> } }).raw.sendMessage({
          chat_id: Number(OWNER_ID),
          text: question,
          reply_markup: { inline_keyboard: keyboard.inline_keyboard },
        })
        sentMsgId = sent?.message_id
      } catch (e) {
        throw new Error(`can't DM the owner (has the owner opened a private chat with the bot and pressed Start?): ${e instanceof Error ? e.message : e}`)
      }
      ownerPolls.set(pollId, { question, options, messageId: sentMsgId ?? 0 })
      elog(`ask_owner sent pollId=${pollId} opts=${options.length} msg=${sentMsgId}`)
      return { content: [{ type: 'text', text: `asked owner (poll ${pollId}) — awaiting their tap, the choice will arrive as a normal message` }] }
    }
    if (req.params.name === 'chat_reply') {
      const chat_request_id = String(args.chat_request_id)
      let text = String(args.text ?? '')
      const richMarkdown = args.rich_markdown ? String(args.rich_markdown) : undefined
      const p = chatPending.get(chat_request_id)
      if (!p) throw new Error(`unknown or expired chat_request_id: ${chat_request_id}`)

      if (richMarkdown) {
        if (p.placeholderMsgId) {
          await bot.api.deleteMessage(p.chatId, p.placeholderMsgId).catch(e => elog(`  chat placeholder delete failed: ${e}`))
        }
        const sentRich = await (bot.api as unknown as { raw: { sendRichMessage: (params: Record<string, unknown>) => Promise<{ message_id: number }> } }).raw.sendRichMessage({
          chat_id: p.chatId,
          rich_message: { markdown: richMarkdown },
          reply_parameters: { message_id: p.messageId },
        })
        if (sentRich?.message_id) trackSentMsg(p.chatId, sentRich.message_id)
        chatPending.delete(chat_request_id)
        cleanupBridgeMsg(`chat:${chat_request_id}`)
        elog(`chat_reply RICH OK chat_request_id=${chat_request_id} len=${richMarkdown.length}`)
        return { content: [{ type: 'text', text: `replied (rich) in chat (request ${chat_request_id})` }] }
      }

      if (text.length > 4096) text = text.slice(0, 4090) + '…'
      let sentMsgId: number | undefined
      if (p.placeholderMsgId) {
        await bot.api.editMessageText(p.chatId, p.placeholderMsgId, text).catch(e => elog(`  chat placeholder edit failed: ${e}`))
        sentMsgId = p.placeholderMsgId
      } else {
        const sent = await bot.api.sendMessage(p.chatId, text, { reply_parameters: { message_id: p.messageId } })
        sentMsgId = sent.message_id
      }
      if (sentMsgId) trackSentMsg(p.chatId, sentMsgId)
      chatPending.delete(chat_request_id)
      cleanupBridgeMsg(`chat:${chat_request_id}`)
      elog(`chat_reply OK chat_request_id=${chat_request_id} len=${text.length}`)
      return { content: [{ type: 'text', text: `replied in chat (request ${chat_request_id})` }] }
    }
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

const mcpTransport = new StdioServerTransport()
// Diagnostics: log when the MCP stdio link to Claude closes or errors. If we see
// this line, the harness (client) tore down the connection — NOT a bot crash.
// If the process vanishes WITHOUT this line and without a crash.log entry, it was
// force-killed externally (e.g. Windows TerminateProcess from the harness).
mcpTransport.onclose = () => elog('MCP transport CLOSED (client disconnected)')
mcpTransport.onerror = err => crashLog('MCP transport error', err)
mcp.onclose = () => elog('MCP server CLOSED')
mcp.onerror = err => crashLog('MCP server error', err)
await mcp.connect(mcpTransport)
elog(`MCP connected pid=${process.pid} node=${process.version}`)

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
    const b = bc as unknown as { can_reply?: boolean; rights?: unknown; is_enabled?: boolean; user?: { id?: number } }
    elog(`  getBusinessConnection can_reply=${b.can_reply ?? JSON.stringify(b.rights)} is_enabled=${b.is_enabled} user=${b.user?.id}`)
  }).catch(e => elog(`  getBusinessConnection failed: ${e}`))

  // Ignore messages FROM bots or IN chats WITH bots (prevents infinite loop
  // where our bridge reply in the bridge bot triggers another business_message).
  if (msg.from?.is_bot) { elog('  business_message: from bot, skipping'); return }
  // Also skip if the chat is with a bot (username ends with 'bot', case-insensitive,
  // or chat type is not 'private'). Business bots cannot reply to bot chats anyway
  // (Telegram returns BUSINESS_PEER_INVALID).
  const chatUsername = (msg.chat as { username?: string }).username ?? ''
  if (chatUsername.toLowerCase().endsWith('bot')) {
    elog(`  business_message: chat is bot (@${chatUsername}), skipping`)
    return
  }

  // Remember this chat's business_connection_id so business_send can target it later
  // in this session, even without a live biz_request_id.
  chatConnection.set(chatId, { connId, lastSeen: Date.now() })

  // Save every incoming business message to history (all contacts, not just triggers)
  const chatIdStr = String(chatId)
  fetchContactInfoIfNew(chatIdStr) // must run BEFORE saveMessage, or isNewChat would already see this message
  if (text) saveMessage(chatIdStr, 'user', text, msg.from?.first_name ?? undefined)

  // Trigger if: message mentions the bot/клод, OR is a reply to one of our messages.
  // Video notes (кружки) can't carry a caption in Telegram — to trigger on one, reply
  // to the video note message with a separate text mentioning Клод (replyMsg below picks
  // up the video_note from the message being replied to).
  const lower = text.toLowerCase()
  const replyToMsgId = (msg as unknown as { reply_to_message?: { message_id?: number } }).reply_to_message?.message_id
  const isReplyToUs = isReplyToOurMsg(chatId, replyToMsgId)
  if (!lower.includes('@claude_inline_bot') && !hasTriggerWord(text) && !isReplyToUs) {
    elog('  business_message: no trigger, skipping')
    return
  }

  // Strip the bot mention to get the clean question
  const query = text.replace(/@claude_inline_bot/gi, '').trim() || text.trim()
  const biz_request_id = newId()
  bizPending.set(biz_request_id, { businessConnectionId: connId, chatId, messageId: msg.message_id, query, ts: Date.now() })
  elog(`  delivering biz request biz_request_id=${biz_request_id}`)

  // Instant deterministic "thinking" placeholder — sent by the server, not Claude,
  // so the human sees we noticed their message right away while the actual answer
  // (bridge -> Claude turn -> business_reply) is still in flight. business_reply
  // edits this message in place instead of sending a separate one, when possible.
  void (bot.api as unknown as { raw: { sendMessage: (params: Record<string, unknown>) => Promise<{ message_id: number }> } }).raw.sendMessage({
    business_connection_id: connId,
    chat_id: chatId,
    text: '<tg-emoji emoji-id="5368808376694248152">💬</tg-emoji> Думаю...',
    parse_mode: 'HTML',
    reply_parameters: { message_id: msg.message_id },
  }).then(sent => {
    const p = bizPending.get(biz_request_id)
    if (p && sent?.message_id) { p.placeholderMsgId = sent.message_id; trackSentMsg(chatId, sent.message_id) }
  }).catch(e => elog(`  placeholder send failed: ${e}`))

  // Also check reply_to_message — owner can reply to a voice/photo with "Клод, расшифруй"
  type AnyMsg = { photo?: Array<{ file_id: string }>; voice?: { file_id: string }; video_note?: { file_id: string }; video?: { file_id: string }; sticker?: { file_id: string; emoji?: string; set_name?: string; is_animated?: boolean; is_video?: boolean }; text?: string; caption?: string }
  const replyMsg = (msg as unknown as { reply_to_message?: AnyMsg }).reply_to_message
  const msgCast = msg as unknown as AnyMsg
  // Plain-text reply target (no photo/voice/video_note of its own) — surface the quoted
  // text so Claude can answer "что это такое"/"поясни" about a PREVIOUS text message.
  const replyText = replyMsg && !replyMsg.photo?.length && !replyMsg.voice && !replyMsg.video_note && !replyMsg.sticker
    ? (replyMsg.text ?? replyMsg.caption ?? '').trim()
    : ''

  // Download photo if present in the trigger message or in a replied-to message
  let photoPath: string | undefined
  const photo = msgCast.photo?.at(-1) ?? replyMsg?.photo?.at(-1)
  if (photo) {
    try {
      mkdirSync(join(HERE, 'tmp'), { recursive: true })
      const fileInfo = await bot.api.getFile(photo.file_id)
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
      const resp = await fetch(url)
      const buf = await resp.arrayBuffer()
      photoPath = join(HERE, 'tmp', `biz_photo_${biz_request_id}.jpg`)
      writeFileSync(photoPath, Buffer.from(buf))
      elog(`  photo saved: ${photoPath}`)
    } catch (e) {
      elog(`  photo download failed: ${e}`)
    }
  }

  // Download voice message if present in the trigger message or in a replied-to message
  let voicePath: string | undefined
  const voice = msgCast.voice ?? replyMsg?.voice
  if (voice) {
    try {
      mkdirSync(join(HERE, 'tmp'), { recursive: true })
      const fileInfo = await bot.api.getFile(voice.file_id)
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
      const resp = await fetch(url)
      const buf = await resp.arrayBuffer()
      voicePath = join(HERE, 'tmp', `biz_voice_${biz_request_id}.oga`)
      writeFileSync(voicePath, Buffer.from(buf))
      elog(`  voice saved: ${voicePath}`)
    } catch (e) {
      elog(`  voice download failed: ${e}`)
    }
  }

  // Download video note (кружок) if present in the trigger message or in a replied-to message
  let videoNotePath: string | undefined
  const videoNote = msgCast.video_note ?? replyMsg?.video_note
  if (videoNote) {
    try {
      mkdirSync(join(HERE, 'tmp'), { recursive: true })
      const fileInfo = await bot.api.getFile(videoNote.file_id)
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
      const resp = await fetch(url)
      const buf = await resp.arrayBuffer()
      videoNotePath = join(HERE, 'tmp', `biz_videonote_${biz_request_id}.mp4`)
      writeFileSync(videoNotePath, Buffer.from(buf))
      elog(`  video note saved: ${videoNotePath}`)
    } catch (e) {
      elog(`  video note download failed: ${e}`)
    }
  }

  // Download a regular (non-round) video if present in the trigger message or a
  // replied-to message — same idea as кружок, just not cropped to a circle. Bot API
  // getFile caps out at 20MB; larger videos will fail here and just skip silently.
  let videoPath: string | undefined
  const video = msgCast.video ?? replyMsg?.video
  if (video) {
    try {
      mkdirSync(join(HERE, 'tmp'), { recursive: true })
      const fileInfo = await bot.api.getFile(video.file_id)
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
      const resp = await fetch(url)
      const buf = await resp.arrayBuffer()
      videoPath = join(HERE, 'tmp', `biz_video_${biz_request_id}.mp4`)
      writeFileSync(videoPath, Buffer.from(buf))
      elog(`  video saved: ${videoPath}`)
    } catch (e) {
      elog(`  video download failed: ${e}`)
    }
  }

  // Download sticker if present in the trigger message or in a replied-to message.
  // Static (webp) stickers are downloaded so Claude can Read them like a photo.
  // Video stickers (.webm) are downloaded too — ffmpeg can grab a still frame from
  // them same as a video note. True animated (.tgs, Lottie/gzipped-JSON vector)
  // stickers can't be rendered to a raster frame without a Lottie decoder — those
  // still fall back to emoji/set_name metadata only.
  let stickerPath: string | undefined
  let stickerVideoPath: string | undefined
  let stickerInfo: string | undefined
  const sticker = msgCast.sticker ?? replyMsg?.sticker
  if (sticker) {
    if (sticker.is_animated) {
      stickerInfo = `animated (Lottie) sticker${sticker.emoji ? `, emoji=${sticker.emoji}` : ''}${sticker.set_name ? `, set=${sticker.set_name}` : ''} (no still frame available)`
      elog(`  sticker is animated (tgs), skipping download: ${stickerInfo}`)
    } else if (sticker.is_video) {
      try {
        mkdirSync(join(HERE, 'tmp'), { recursive: true })
        const fileInfo = await bot.api.getFile(sticker.file_id)
        const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
        const resp = await fetch(url)
        const buf = await resp.arrayBuffer()
        stickerVideoPath = join(HERE, 'tmp', `biz_sticker_${biz_request_id}.webm`)
        writeFileSync(stickerVideoPath, Buffer.from(buf))
        elog(`  video sticker saved: ${stickerVideoPath}`)
      } catch (e) {
        elog(`  video sticker download failed: ${e}`)
      }
    } else {
      try {
        mkdirSync(join(HERE, 'tmp'), { recursive: true })
        const fileInfo = await bot.api.getFile(sticker.file_id)
        const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
        const resp = await fetch(url)
        const buf = await resp.arrayBuffer()
        stickerPath = join(HERE, 'tmp', `biz_sticker_${biz_request_id}.webp`)
        writeFileSync(stickerPath, Buffer.from(buf))
        elog(`  sticker saved: ${stickerPath}`)
      } catch (e) {
        elog(`  sticker download failed: ${e}`)
      }
    }
  }

  // Deliver via bridge (same pattern as inline fallback)
  const senderTag = fromId === Number(OWNER_ID)
    ? `role=owner biz_chat=${chatId}`
    : `role=guest who=${msg.from?.username ?? '?'}:${fromId} biz_chat=${chatId}`
  let queryFinal = query
  if (replyText) queryFinal += ` [REPLY_TO:"${replyText.length > 300 ? replyText.slice(0, 300) + '…' : replyText}"]`
  if (photoPath) queryFinal += ` [PHOTO:${photoPath}]`
  if (voicePath) queryFinal += ` [VOICE:${voicePath}]`
  if (videoNotePath) queryFinal += ` [VIDEO_NOTE:${videoNotePath}]`
  if (videoPath) queryFinal += ` [VIDEO:${videoPath}]`
  if (stickerPath) queryFinal += ` [STICKER:${stickerPath}]`
  if (stickerVideoPath) queryFinal += ` [STICKER_VIDEO:${stickerVideoPath}]`
  if (stickerInfo) queryFinal += ` [STICKER_INFO:${stickerInfo}]`
  deliverViaBridge(`biz:${biz_request_id}`, queryFinal, senderTag)
})

// Direct messages to the inline-claude bot itself — either a private DM (not via
// inline_query) or a message in a group the bot has been added to. Distinct from
// business_message (Business Bot connection) and inline_query (the @bot-mention
// picker flow). In groups, Telegram's default bot privacy mode already limits what
// we see to messages that @mention us or reply to our own message — no extra
// filtering needed for that case. In private chats, every message is a DM to us,
// so no mention is required.
// Shared by both the /ask command and plain-text triggers below.
function deliverChatTrigger(chatId: number, msgId: number, fromUser: { id: number; username?: string }, query: string, chatType: string): void {
  const chat_request_id = newId()
  chatPending.set(chat_request_id, { chatId, messageId: msgId, query, ts: Date.now() })
  elog(`chat message chat=${chatId} type=${chatType} from=${fromUser.id} chat_request_id=${chat_request_id}`)

  void bot.api.sendMessage(chatId, '💬 Думаю...', { reply_parameters: { message_id: msgId } })
    .then(sent => {
      const p = chatPending.get(chat_request_id)
      if (p) { p.placeholderMsgId = sent.message_id; trackSentMsg(chatId, sent.message_id) }
    })
    .catch(e => elog(`  chat placeholder send failed: ${e}`))

  const senderTag = String(fromUser.id) === OWNER_ID
    ? `role=owner chat_id=${chatId} chat_type=${chatType}`
    : `role=guest who=${fromUser.username ?? '?'}:${fromUser.id} chat_id=${chatId} chat_type=${chatType} ANSWER-ONLY`
  deliverViaBridge(`chat:${chat_request_id}`, query, senderTag)
}

// Guaranteed to work in ANY group regardless of the bot's privacy-mode setting —
// Telegram always delivers slash commands to bots even with privacy mode ON.
// Typing "@claude_inline_bot ..." does NOT work as a plain-text mention in groups:
// Telegram's client intercepts "@<bot_with_inline_support>" and opens the inline-query
// picker instead of letting you type it as message text — there is no client-side way
// around that, so /ask is the reliable trigger, not an @mention.
bot.command('ask', async ctx => {
  const fromUser = ctx.from
  if (!fromUser || fromUser.is_bot) return
  const query = ctx.match?.trim() || '(пустой вопрос)'
  deliverChatTrigger(ctx.chat.id, ctx.message!.message_id, fromUser, query, ctx.chat.type)
})

// Generic downloader shared by all chat-path attachment types below (photo/voice/
// video/video_note/sticker). Mirrors the business_message download blocks further
// up but with a fresh generated filename instead of biz_request_id, since the chat
// path doesn't have a request id allocated until after gating passes.
async function downloadTgFile(fileId: string, prefix: string, ext: string): Promise<string | undefined> {
  try {
    mkdirSync(join(HERE, 'tmp'), { recursive: true })
    const fileInfo = await bot.api.getFile(fileId)
    const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`
    const resp = await fetch(url)
    const buf = await resp.arrayBuffer()
    const path = join(HERE, 'tmp', `${prefix}_${newId()}.${ext}`)
    writeFileSync(path, Buffer.from(buf))
    elog(`  ${prefix} saved: ${path}`)
    return path
  } catch (e) {
    elog(`  ${prefix} download failed: ${e}`)
    return undefined
  }
}

type ChatAttachment =
  | { kind: 'photo'; fileId: string }
  | { kind: 'voice'; fileId: string }
  | { kind: 'video'; fileId: string }
  | { kind: 'video_note'; fileId: string }
  | { kind: 'sticker'; fileId: string; isAnimated?: boolean; isVideo?: boolean; emoji?: string; setName?: string }

// One handler for the whole 'message' update, inspecting fields directly, instead of
// separate bot.on('message:photo')/('message:caption') registrations — grammY runs
// EVERY matching bot.on() for a given update (each calls next() after its handler),
// so a photo-with-caption would double-fire if handled by two overlapping filters.
// A single dispatcher avoids that entirely.
async function maybeHandleChatMessage(
  chat: { id: number; type: string },
  fromUser: { id: number; username?: string; is_bot?: boolean } | undefined,
  msgId: number,
  replyToMsgId: number | undefined,
  text: string,
  attachment?: ChatAttachment,
): Promise<void> {
  if (!fromUser || fromUser.is_bot) return
  if (text.startsWith('/')) return // commands are handled separately

  const chatId = chat.id
  const isReplyToUs = isReplyToOurMsg(chatId, replyToMsgId)

  if (chat.type === 'group' || chat.type === 'supergroup') {
    // NOTE: with the bot's default privacy mode (group privacy ON), Telegram only
    // delivers group messages to us that are commands, replies to our own message, or
    // @mention us — a plain "клод, ..." with no mention/reply never reaches this
    // handler at all (filtered server-side). Disable privacy mode via @BotFather
    // (/mybots → bot → Bot Settings → Group Privacy → Turn off) to receive every
    // group message and let the trigger-word check below work like in business chats.
    // Video notes/stickers can't carry a caption at all — reply-to-us is the only way
    // to trigger on those in a group, same limitation as business chat кружки.
    if (!hasTriggerWord(text) && !isReplyToUs) return
  }
  // Private chat: any message is addressed to us, no mention/trigger word needed.

  let marker = ''
  if (attachment) {
    if (attachment.kind === 'photo') {
      const p = await downloadTgFile(attachment.fileId, 'chat_photo', 'jpg')
      if (p) marker = ` [PHOTO:${p}]`
    } else if (attachment.kind === 'voice') {
      const p = await downloadTgFile(attachment.fileId, 'chat_voice', 'oga')
      if (p) marker = ` [VOICE:${p}]`
    } else if (attachment.kind === 'video') {
      const p = await downloadTgFile(attachment.fileId, 'chat_video', 'mp4')
      if (p) marker = ` [VIDEO:${p}]`
    } else if (attachment.kind === 'video_note') {
      const p = await downloadTgFile(attachment.fileId, 'chat_videonote', 'mp4')
      if (p) marker = ` [VIDEO_NOTE:${p}]`
    } else if (attachment.kind === 'sticker') {
      if (attachment.isAnimated) {
        marker = ` [STICKER_INFO:animated sticker${attachment.emoji ? `, emoji=${attachment.emoji}` : ''}${attachment.setName ? `, set=${attachment.setName}` : ''} (no still frame available)]`
      } else if (attachment.isVideo) {
        const p = await downloadTgFile(attachment.fileId, 'chat_sticker', 'webm')
        if (p) marker = ` [STICKER_VIDEO:${p}]`
      } else {
        const p = await downloadTgFile(attachment.fileId, 'chat_sticker', 'webp')
        if (p) marker = ` [STICKER:${p}]`
      }
    }
  }

  deliverChatTrigger(chatId, msgId, fromUser, text.trim() + marker, chat.type)
}

// Shared by the trigger message itself AND its reply target (same Message shape) —
// e.g. someone sends a photo, then a SEPARATE later message replies to it with
// "клод, что это" (no attachment of its own, but referring to the one above).
type MsgLike = {
  photo?: Array<{ file_id: string }>
  voice?: { file_id: string }
  video?: { file_id: string }
  video_note?: { file_id: string }
  sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean; emoji?: string; set_name?: string }
}
function extractAttachment(m: MsgLike | undefined): ChatAttachment | undefined {
  if (!m) return undefined
  if (m.photo?.length) return { kind: 'photo', fileId: m.photo[m.photo.length - 1].file_id }
  if (m.voice) return { kind: 'voice', fileId: m.voice.file_id }
  if (m.video) return { kind: 'video', fileId: m.video.file_id }
  if (m.video_note) return { kind: 'video_note', fileId: m.video_note.file_id }
  if (m.sticker) return { kind: 'sticker', fileId: m.sticker.file_id, isAnimated: m.sticker.is_animated, isVideo: m.sticker.is_video, emoji: m.sticker.emoji, setName: m.sticker.set_name }
  return undefined
}

bot.on('message', async ctx => {
  const m = ctx.message
  const text = m.text ?? m.caption ?? ''
  const replyToMsgId = m.reply_to_message?.message_id

  // The message's OWN attachment wins; if it has none, fall back to whatever the
  // message it's replying to was carrying — e.g. "клод, что это" replied onto an
  // earlier bare photo.
  const attachment = extractAttachment(m) ?? extractAttachment(m.reply_to_message)

  // Nothing to trigger on (no text/caption and no recognized attachment) — skip.
  if (!text && !attachment) return

  await maybeHandleChatMessage(ctx.chat, ctx.from, m.message_id, replyToMsgId, text, attachment)
})

// Log business_connection updates (to see can_reply flag)
// Guard: only the owner may add this bot to a group. Anyone else's group is a much
// wider trigger surface than a 1:1 business contact (any member can then invoke the
// bot as a guest) — дима explicitly wants this locked down. If someone other than
// OWNER_ID adds/re-adds the bot to a group/supergroup, leave immediately.
bot.on('my_chat_member', async ctx => {
  const upd = ctx.myChatMember
  const chat = upd.chat
  if (chat.type !== 'group' && chat.type !== 'supergroup') return
  const newStatus = upd.new_chat_member.status
  const becameMember = newStatus === 'member' || newStatus === 'administrator'
  if (!becameMember) return
  const actorId = String(upd.from.id)
  if (actorId === OWNER_ID) {
    elog(`my_chat_member: owner added bot to chat=${chat.id} ("${chat.title}") — staying`)
    return
  }
  elog(`my_chat_member: non-owner (${actorId}) added bot to chat=${chat.id} ("${chat.title}") — leaving`)
  try {
    await bot.api.sendMessage(chat.id, 'Этого бота может добавлять только его владелец. Покидаю чат.')
  } catch { /* best-effort — leave regardless */ }
  await bot.api.leaveChat(chat.id).catch(e => elog(`  leaveChat failed: ${e}`))
})

bot.on('business_connection', async ctx => {
  const bc = ctx.update.business_connection as unknown as { id?: string; user?: { id?: number }; can_reply?: boolean; rights?: unknown; is_enabled?: boolean }
  elog(`business_connection id=${bc?.id} user=${bc?.user?.id} can_reply=${bc?.can_reply ?? JSON.stringify(bc?.rights)} is_enabled=${bc?.is_enabled}`)
})

// swallow taps on the placeholder's "⏳ думаю…" button
// swallow taps on the placeholder's "⏳ думаю…" button, route real button presses
// (from business_reply's `buttons` option) as a new [[ic:biz:...]] trigger.
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data ?? ''

  // Owner poll answer (from the ask_owner tool). Only the owner may answer; the choice
  // is delivered back into the session as a plain message.
  const pm = data.match(/^poll:(.+):(\d+)$/)
  if (pm) {
    const [, pollId, pIdx] = pm
    const poll = ownerPolls.get(pollId)
    if (!poll) { await ctx.answerCallbackQuery({ text: 'Опрос устарел' }).catch(() => {}); return }
    if (ctx.from?.id !== Number(OWNER_ID)) { await ctx.answerCallbackQuery({ text: 'Это не тебе', show_alert: true }).catch(() => {}); return }
    const choice = poll.options[Number(pIdx)] ?? '?'
    await ctx.answerCallbackQuery({ text: `Выбрано: ${choice}` }).catch(() => {})
    await ctx.editMessageText(`${poll.question}\n\n✅ ${choice}`, { reply_markup: { inline_keyboard: [] } }).catch(e => elog(`  poll edit failed: ${e}`))
    ownerPolls.delete(pollId)
    elog(`  poll answered pollId=${pollId} idx=${pIdx} choice="${choice}"`)
    deliverPlainToBridge(`[ответ на опрос] «${poll.question}» → ${choice}`)
    return
  }

  const m = data.match(/^bbtn:(.+):(\d+)$/)
  if (!m) { await ctx.answerCallbackQuery({ text: 'Клод думает…' }).catch(() => {}); return }

  const [, btnMsgId, idxStr] = m
  const btn = bizButtonMsgs.get(btnMsgId)
  if (!btn) { await ctx.answerCallbackQuery({ text: 'Кнопка устарела' }).catch(() => {}); return }

  const pressedByOwner = ctx.from?.id === Number(OWNER_ID)
  if (btn.forRole && ((btn.forRole === 'owner') !== pressedByOwner)) {
    await ctx.answerCallbackQuery({ text: 'Это не тебе', show_alert: true }).catch(() => {})
    elog(`  bbtn REJECTED btnMsgId=${btnMsgId} forRole=${btn.forRole} pressedBy=${ctx.from?.id}`)
    return
  }

  const label = btn.buttons[Number(idxStr)] ?? '?'
  await ctx.answerCallbackQuery({ text: `Выбрано: ${label}` }).catch(() => {})

  // Remove the keyboard so it can't be pressed twice.
  bot.api.raw.editMessageReplyMarkup({
    business_connection_id: btn.businessConnectionId,
    chat_id: btn.chatId,
    message_id: btn.messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(e => elog(`  bbtn editMessageReplyMarkup failed: ${e}`))
  bizButtonMsgs.delete(btnMsgId)

  const fromId = ctx.from?.id
  const biz_request_id = newId()
  bizPending.set(biz_request_id, {
    businessConnectionId: btn.businessConnectionId,
    chatId: btn.chatId,
    messageId: btn.messageId,
    query: `Нажата кнопка: "${label}"`,
    ts: Date.now(),
  })
  const senderTag = fromId === Number(OWNER_ID)
    ? `role=owner biz_chat=${btn.chatId}`
    : `role=guest who=${ctx.from?.username ?? '?'}:${fromId} biz_chat=${btn.chatId}`
  elog(`  bbtn pressed btnMsgId=${btnMsgId} idx=${idxStr} label="${label}" by=${fromId} -> biz_request_id=${biz_request_id}`)
  deliverViaBridge(`biz:${biz_request_id}`, `Нажата кнопка: "${label}"`, senderTag)
})

bot.catch(err => crashLog('bot.catch handler error', err.error))

// --- lifecycle ---
let shuttingDown = false
function shutdown(reason = 'unknown'): void {
  if (shuttingDown) return
  shuttingDown = true
  elog(`SHUTDOWN reason=${reason} pid=${process.pid}`)
  try { if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE) } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.stdin.on('end', () => shutdown('stdin-end'))
process.stdin.on('close', () => shutdown('stdin-close'))
process.stdin.on('error', e => shutdown(`stdin-error:${e}`))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => shutdown('SIGHUP'))

const bootPpid = process.ppid
setInterval(() => {
  let reason = ''
  if (process.platform !== 'win32' && process.ppid !== bootPpid) reason = `reparented ppid ${bootPpid}->${process.ppid}`
  else if (process.stdin.destroyed) reason = 'stdin-destroyed'
  else if (process.stdin.readableEnded) reason = 'stdin-readableEnded'
  if (reason) shutdown(`orphan-check:${reason}`)
}, 5000).unref()

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, 'inline_query', 'chosen_inline_result', 'business_connection', 'business_message', 'edited_business_message', 'my_chat_member'],
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
        crashLog('poller 409 fatal', 'another poller holds the token — exiting')
        return
      }
      const delay = Math.min(1000 * attempt, 15000)
      crashLog(`poller start error (retry ${attempt} in ${delay/1000}s)`, err)
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()

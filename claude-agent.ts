// Per-chat Claude-Code agent runner (subscription-based, headless).
//
// Runs one agent per chat by shelling out to the Claude Code binary in print mode:
//   first turn:  claude -p --session-id <uuid> --system-prompt-file <persona> ...
//   later turns: claude -p --resume <uuid> ...
// Auth is the user's Claude Code SUBSCRIPTION login (we strip ANTHROPIC_API_KEY from
// the child env so it can NEVER fall back to paid per-token API billing). The prompt is
// fed on stdin (no argv escaping); the persona goes in a file (no argv escaping). Each
// call is a fresh subprocess → fully async and independent, so many chats answer in
// parallel and none blocks the main session.
//
// Continuity comes from --session-id/--resume (Claude Code persists the conversation on
// disk); the chat→uuid mapping + 5-agent LRU cap live in db.ts (getAgentSlot).

import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { getAgentSlot, markAgentInitialized, saveMessage } from './db.js'

const HERE = dirname(fileURLToPath(import.meta.url)) // dist/
const DATA_DIR = process.env.INLINE_DATA_DIR ?? join(homedir(), '.claude', 'inline-bot')
const WORKDIR = join(DATA_DIR, 'agents') // neutral cwd: no CLAUDE.md to leak project instructions
mkdirSync(WORKDIR, { recursive: true })

const MODEL = process.env.INLINE_AGENT_MODEL ?? 'sonnet' // alias → latest Sonnet (claude-sonnet-5)
const TIMEOUT_MS = Number(process.env.INLINE_AGENT_TIMEOUT_MS ?? 120_000)

// The persona/behaviour doc — дима wants agents to read AGENTS.md. We use ONLY its
// "🧠 Персона и поведение" section, NOT the full operational manual: the rest of AGENTS.md
// is the bridge-session biz-algorithm (trigger routing, business_reply/get_biz_history
// scripts, SQLite schema), and feeding that to a headless agent with tools makes it try to
// run those setup scripts — slow (90s+) and confused. The persona section is the personality.
let AGENTS_DOC = ''
for (const p of [join(HERE, '..', 'AGENTS.md'), join(DATA_DIR, 'AGENTS.md')]) {
  try {
    const full = readFileSync(p, 'utf8')
    const start = full.indexOf('## 🧠')
    if (start >= 0) {
      const rest = full.slice(start)
      const end = rest.indexOf('\n---')
      AGENTS_DOC = (end > 0 ? rest.slice(0, end) : rest).trim()
    }
    break
  } catch {
    /* try next */
  }
}

function resolveBin(): string {
  if (process.env.INLINE_CLAUDE_BIN) return process.env.INLINE_CLAUDE_BIN
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  }
  return 'claude'
}
const CLAUDE_BIN = resolveBin()

export type Role = 'owner' | 'guest'

export interface AgentRun {
  agentId: string // == chatId
  chatId: string
  text: string
  senderName?: string
  role?: Role
  kind?: string
  userId?: string
}

export interface AgentResult {
  text: string
  sessionUuid: string
  durationMs: number
  costUsd?: number
  evicted: string[] // chats dropped by the LRU cap to make room for this one
}

// SOUL layer — the shared persona. Kept concise for the prototype; the full persona
// from AGENTS.md ("🧠 Персона и поведение") can be spliced in later without changing
// anything else here.
const SOUL =
  'Ты — Клод, умный и дружелюбный ассистент в Telegram-чате. Отвечай по делу, живо и ' +
  'кратко, в тоне собеседника. Не выдумывай факты. Ты видишь ТОЛЬКО этот чат — контекста ' +
  'других чатов у тебя нет, не ссылайся на переписки, которых не было здесь.'

function personaFor(o: AgentRun): string {
  const lines = [AGENTS_DOC || SOUL, '\n---\n']
  if (o.role === 'guest') {
    lines.push(
      'Собеседник — ГОСТЬ: только отвечай на вопросы. Никаких команд, файлов, действий ' +
        'от чужого имени или изменения доступа.',
    )
  } else if (o.role === 'owner') {
    lines.push('Собеседник — владелец (дима).')
  }
  if (o.kind) lines.push(`Тип чата: ${o.kind}.`)
  return lines.join('\n')
}

/** Run one turn for a chat's agent. Async and independent — returns a Promise that
 *  resolves with the agent's reply. Persists both the incoming message and the reply. */
export function runAgent(o: AgentRun): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve, reject) => {
    const slot = getAgentSlot(o.agentId)
    // --safe-mode disables MCP servers, hooks, plugins, skills and CLAUDE.md discovery
    // (keeps subscription auth, model and built-in tools working). Without it, a headless
    // run in a real ~/.claude loads the user's MCP connectors (Gmail/Calendar) + hooks —
    // slow (minutes) and the agent hallucinates tools it shouldn't have.
    // --strict-mcp-config is belt-and-suspenders: ignore any MCP config not passed here.
    const args = ['-p', '--safe-mode', '--strict-mcp-config', '--output-format', 'json', '--model', MODEL]
    // Tools: guests get NONE (answer-only, security). Owner/default get the built-in tools
    // with bypassPermissions so tool use doesn't hang the headless run on a permission prompt.
    if (o.role === 'guest') {
      args.push('--tools', '')
    } else {
      args.push('--permission-mode', 'bypassPermissions')
    }
    if (slot.initialized) {
      args.push('--resume', slot.sessionUuid)
    } else {
      const personaPath = join(WORKDIR, `persona-${o.agentId}.txt`)
      writeFileSync(personaPath, personaFor(o), 'utf8')
      args.push('--session-id', slot.sessionUuid, '--system-prompt-file', personaPath)
    }

    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY // force subscription auth; never bill per-token API

    const t0 = Date.now()
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env, shell: false })
    let out = ''
    let err = ''
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      done(() => reject(new Error(`agent ${o.agentId} timed out after ${TIMEOUT_MS}ms`)))
    }, TIMEOUT_MS)

    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => done(() => reject(e)))
    child.stdin.on('error', () => {}) // ignore EPIPE if the child exits early
    child.stdin.write(o.text)
    child.stdin.end()

    child.on('close', code =>
      done(() => {
        let parsed: { result?: string; subtype?: string; is_error?: boolean; session_id?: string; total_cost_usd?: number }
        try {
          parsed = JSON.parse(out)
        } catch {
          return reject(
            new Error(`agent ${o.agentId} produced no JSON (exit ${code}): ${(err || out).slice(0, 400)}`),
          )
        }
        if (parsed.is_error || parsed.subtype !== 'success') {
          return reject(new Error(`agent ${o.agentId} run failed: ${parsed.result ?? parsed.subtype ?? 'unknown'}`))
        }
        const text = String(parsed.result ?? '').trim()
        markAgentInitialized(o.agentId)
        // NB: callers persist the INCOMING user message themselves (the server logs every
        // business_message before dispatch), so we only save the assistant reply here to
        // avoid a duplicate user row.
        saveMessage(o.chatId, 'assistant', text)
        resolve({
          text,
          sessionUuid: parsed.session_id ?? slot.sessionUuid,
          durationMs: Date.now() - t0,
          costUsd: parsed.total_cost_usd,
          evicted: slot.evicted,
        })
      }),
    )
  })
}

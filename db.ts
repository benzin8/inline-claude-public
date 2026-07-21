import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'

const DATA_DIR = process.env.INLINE_DATA_DIR ?? join(homedir(), '.claude', 'inline-bot')
mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = join(DATA_DIR, 'chat_history.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT,
  user_id TEXT,
  role TEXT NOT NULL,
  sender_name TEXT,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat ON chat_history (chat_id, ts)`)

// --- Migration (idempotent): per-agent columns for the multi-agent model.
// Each chat is served by its own agent, so agent_id == chat_id by default; user_id
// is the sender's telegram id (differs from chat_id in groups/biz). Fresh installs
// get the columns from CREATE TABLE above; pre-existing DBs are patched here.
{
  const cols = db.prepare(`PRAGMA table_info(chat_history)`).all() as Array<{ name: string }>
  const hasCol = (n: string) => cols.some(c => c.name === n)
  if (!hasCol('agent_id')) db.exec(`ALTER TABLE chat_history ADD COLUMN agent_id TEXT`)
  if (!hasCol('user_id')) db.exec(`ALTER TABLE chat_history ADD COLUMN user_id TEXT`)
  // Backfill legacy rows: agent_id = chat_id (by the agent-per-chat design).
  db.exec(`UPDATE chat_history SET agent_id = chat_id WHERE agent_id IS NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent ON chat_history (agent_id, ts)`)
}

// Cross-agent access grants. By default an agent may read ONLY its own chat's rows;
// a row here explicitly allows grantee_agent to access target_agent's data under a
// scope. Grants are owner-gated: granted_by must be the owner — nothing is granted
// automatically, keeping biz/guest chats isolated unless дима approves.
db.exec(`CREATE TABLE IF NOT EXISTS access_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grantee_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  UNIQUE(grantee_agent, target_agent, scope)
)`)

db.exec(`CREATE TABLE IF NOT EXISTS contacts (
  chat_id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  phone TEXT,
  about TEXT,
  is_contact INTEGER,
  premium INTEGER,
  common_chats_count INTEGER,
  fetched_at INTEGER NOT NULL
)`)

const insertStmt = db.prepare(
  `INSERT INTO chat_history (chat_id, agent_id, user_id, role, sender_name, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
)
const historyStmt = db.prepare(
  `SELECT role, sender_name, text FROM chat_history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?`,
)
const agentMsgsStmt = db.prepare(
  `SELECT role, sender_name, text FROM chat_history WHERE agent_id = ? ORDER BY ts DESC LIMIT ?`,
)
const countStmt = db.prepare(`SELECT COUNT(*) as n FROM chat_history WHERE chat_id = ?`)
const contactUpsertStmt = db.prepare(`INSERT INTO contacts
  (chat_id, first_name, last_name, username, phone, about, is_contact, premium, common_chats_count, fetched_at)
  VALUES (@chat_id, @first_name, @last_name, @username, @phone, @about, @is_contact, @premium, @common_chats_count, @fetched_at)
  ON CONFLICT(chat_id) DO UPDATE SET
    first_name=excluded.first_name, last_name=excluded.last_name, username=excluded.username,
    phone=excluded.phone, about=excluded.about, is_contact=excluded.is_contact,
    premium=excluded.premium, common_chats_count=excluded.common_chats_count, fetched_at=excluded.fetched_at`)
const contactStmt = db.prepare(`SELECT * FROM contacts WHERE chat_id = ?`)

// --- Per-chat Claude-Code agent sessions (subscription-based headless agents) --
// Maps agent_id (== chat_id) to a stable Claude Code session UUID we control via
// `claude -p --session-id <uuid>` (first turn) / `--resume <uuid>` (later turns).
// Capped at INLINE_MAX_AGENTS (default 5) with LRU eviction — дима only needs a
// handful of long-lived agents, and each draws from the subscription's headless pool.
db.exec(`CREATE TABLE IF NOT EXISTS claude_agents (
  agent_id TEXT PRIMARY KEY,
  session_uuid TEXT NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
)`)
const MAX_AGENTS = Number(process.env.INLINE_MAX_AGENTS ?? 10)
const agentGetStmt = db.prepare(`SELECT session_uuid, initialized FROM claude_agents WHERE agent_id = ?`)
const agentCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM claude_agents`)
const agentLruStmt = db.prepare(`SELECT agent_id FROM claude_agents ORDER BY last_used ASC LIMIT ?`)
const agentDelStmt = db.prepare(`DELETE FROM claude_agents WHERE agent_id = ?`)
const agentInsStmt = db.prepare(
  `INSERT INTO claude_agents (agent_id, session_uuid, initialized, created_at, last_used) VALUES (?, ?, 0, ?, ?)`,
)
const agentTouchStmt = db.prepare(`UPDATE claude_agents SET last_used = ? WHERE agent_id = ?`)
const agentInitStmt = db.prepare(`UPDATE claude_agents SET initialized = 1 WHERE agent_id = ?`)
const agentListStmt = db.prepare(
  `SELECT agent_id, session_uuid, initialized, last_used FROM claude_agents ORDER BY last_used DESC`,
)

export interface AgentSlot {
  agentId: string
  sessionUuid: string
  initialized: boolean
  evicted: string[] // agent_ids dropped by LRU to make room (empty unless a new agent was created)
}

/** Get (or create, with LRU eviction) the Claude-Code session slot for a chat.
 *  Touches last_used so the freshest chats survive eviction. */
export function getAgentSlot(agentId: string): AgentSlot {
  const now = Date.now()
  const row = agentGetStmt.get(agentId) as { session_uuid: string; initialized: number } | undefined
  if (row) {
    agentTouchStmt.run(now, agentId)
    return { agentId, sessionUuid: row.session_uuid, initialized: !!row.initialized, evicted: [] }
  }
  const evicted: string[] = []
  const count = (agentCountStmt.get() as { n: number }).n
  if (count >= MAX_AGENTS) {
    const victims = agentLruStmt.all(count - MAX_AGENTS + 1) as Array<{ agent_id: string }>
    for (const v of victims) {
      agentDelStmt.run(v.agent_id)
      evicted.push(v.agent_id)
    }
  }
  const uuid = randomUUID()
  agentInsStmt.run(agentId, uuid, now, now)
  return { agentId, sessionUuid: uuid, initialized: false, evicted }
}

export function markAgentInitialized(agentId: string): void {
  agentInitStmt.run(agentId)
}

// Persisted record of message ids WE (bot/agent) sent per chat, so a reply to one of our
// messages still triggers a response after a server restart (the in-memory set is wiped on
// restart). Keeps reply-to-agent triggering reliable for agent-handled chats.
db.exec(`CREATE TABLE IF NOT EXISTS bot_messages (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
)`)
const botMsgInsStmt = db.prepare(`INSERT OR IGNORE INTO bot_messages (chat_id, message_id, ts) VALUES (?, ?, ?)`)
const botMsgHasStmt = db.prepare(`SELECT 1 FROM bot_messages WHERE chat_id = ? AND message_id = ? LIMIT 1`)

export function trackBotMessage(chatId: string, messageId: number): void {
  botMsgInsStmt.run(chatId, messageId, Date.now())
}

export function isBotMessage(chatId: string, messageId: number): boolean {
  return botMsgHasStmt.get(chatId, messageId) !== undefined
}

export function listAgents(): Array<{ agentId: string; sessionUuid: string; initialized: boolean; lastUsed: number }> {
  return (agentListStmt.all() as Array<{ agent_id: string; session_uuid: string; initialized: number; last_used: number }>).map(
    r => ({ agentId: r.agent_id, sessionUuid: r.session_uuid, initialized: !!r.initialized, lastUsed: r.last_used }),
  )
}

export function saveMessage(
  chatId: string,
  role: 'user' | 'assistant',
  text: string,
  senderName?: string,
  userId?: string,
): void {
  // agent_id == chat_id: each chat is served by its own per-chat agent.
  insertStmt.run(chatId, chatId, userId ?? null, role, senderName ?? null, text, Date.now())
}

/** True if we've never logged a message for this chat before (i.e. this is their first contact). */
export function isNewChat(chatId: string): boolean {
  const row = countStmt.get(chatId) as { n: number }
  return row.n === 0
}

export interface ContactInfo {
  first_name?: string | null
  last_name?: string | null
  username?: string | null
  phone?: string | null
  about?: string | null
  is_contact?: boolean
  premium?: boolean
  common_chats_count?: number | null
}

export function saveContactInfo(chatId: string, info: ContactInfo): void {
  contactUpsertStmt.run({
    chat_id: chatId,
    first_name: info.first_name ?? null,
    last_name: info.last_name ?? null,
    username: info.username ?? null,
    phone: info.phone ?? null,
    about: info.about ?? null,
    is_contact: info.is_contact ? 1 : 0,
    premium: info.premium ? 1 : 0,
    common_chats_count: info.common_chats_count ?? null,
    fetched_at: Date.now(),
  })
}

export function getContactInfo(chatId: string): (ContactInfo & { fetched_at: number }) | undefined {
  return contactStmt.get(chatId) as (ContactInfo & { fetched_at: number }) | undefined
}

export function getHistory(chatId: string, limit = 20): string {
  const rows = historyStmt.all(chatId, limit) as Array<{ role: string; sender_name: string | null; text: string }>
  if (rows.length === 0) return ''
  return rows
    .reverse()
    .map(r => {
      const who = r.role === 'assistant' ? 'Клод' : (r.sender_name || 'Собеседник')
      const truncated = r.text.length > 200 ? r.text.slice(0, 197) + '…' : r.text
      return `[${who}]: ${truncated}`
    })
    .join('\n')
}

/** One turn of an agent's own conversation, oldest-first, for building an API request.
 *  Scoped to a SINGLE agent_id — this is the isolation boundary: an agent reads only
 *  its own chat's rows. Cross-agent reads must go through hasAccess() + a separate call. */
export interface AgentMessage {
  role: 'user' | 'assistant'
  senderName: string | null
  text: string
}

export function getAgentMessages(agentId: string, limit = 40): AgentMessage[] {
  const rows = agentMsgsStmt.all(agentId, limit) as Array<{
    role: string
    sender_name: string | null
    text: string
  }>
  return rows
    .reverse()
    .map(r => ({
      role: r.role === 'assistant' ? 'assistant' : ('user' as 'user' | 'assistant'),
      senderName: r.sender_name,
      text: r.text,
    }))
}

// --- Cross-agent access grants (owner-gated) ---------------------------------
const grantInsertStmt = db.prepare(`INSERT INTO access_grants
  (grantee_agent, target_agent, scope, granted_by, granted_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(grantee_agent, target_agent, scope) DO UPDATE SET
    granted_by=excluded.granted_by, granted_at=excluded.granted_at`)
const grantCheckStmt = db.prepare(
  `SELECT 1 FROM access_grants WHERE grantee_agent = ? AND target_agent = ? AND scope = ? LIMIT 1`,
)
const grantRevokeStmt = db.prepare(
  `DELETE FROM access_grants WHERE grantee_agent = ? AND target_agent = ? AND scope = ?`,
)

/** Allow granteeAgent to access targetAgent's data under `scope`. Owner-gated: the
 *  caller must pass the owner's id as grantedBy (enforcement lives in the caller). */
export function grantAccess(granteeAgent: string, targetAgent: string, grantedBy: string, scope = 'read'): void {
  grantInsertStmt.run(granteeAgent, targetAgent, scope, grantedBy, Date.now())
}

export function revokeAccess(granteeAgent: string, targetAgent: string, scope = 'read'): void {
  grantRevokeStmt.run(granteeAgent, targetAgent, scope)
}

/** True if granteeAgent may access targetAgent under `scope`. An agent always has
 *  access to its own data (grantee == target). */
export function hasAccess(granteeAgent: string, targetAgent: string, scope = 'read'): boolean {
  if (granteeAgent === targetAgent) return true
  return grantCheckStmt.get(granteeAgent, targetAgent, scope) !== undefined
}

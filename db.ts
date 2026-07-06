import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

const DATA_DIR = process.env.INLINE_DATA_DIR ?? join(homedir(), '.claude', 'inline-bot')
mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = join(DATA_DIR, 'chat_history.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sender_name TEXT,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat ON chat_history (chat_id, ts)`)

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
  `INSERT INTO chat_history (chat_id, role, sender_name, text, ts) VALUES (?, ?, ?, ?, ?)`,
)
const historyStmt = db.prepare(
  `SELECT role, sender_name, text FROM chat_history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?`,
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

export function saveMessage(chatId: string, role: 'user' | 'assistant', text: string, senderName?: string): void {
  insertStmt.run(chatId, role, senderName ?? null, text, Date.now())
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

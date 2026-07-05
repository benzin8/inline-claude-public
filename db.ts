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

const insertStmt = db.prepare(
  `INSERT INTO chat_history (chat_id, role, sender_name, text, ts) VALUES (?, ?, ?, ?, ?)`,
)
const historyStmt = db.prepare(
  `SELECT role, sender_name, text FROM chat_history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?`,
)

export function saveMessage(chatId: string, role: 'user' | 'assistant', text: string, senderName?: string): void {
  insertStmt.run(chatId, role, senderName ?? null, text, Date.now())
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

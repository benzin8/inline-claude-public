"""Read business chat history from SQLite for a given chat_id.
Usage: python get_biz_history.py <chat_id> [limit=20]
"""
import sys, os, sqlite3, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

DB_PATH = os.path.join(os.path.expanduser('~'), '.claude', 'inline-bot', 'chat_history.db')

chat_id = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20

if not os.path.exists(DB_PATH):
    print('(нет истории)')
    sys.exit(0)

conn = sqlite3.connect(DB_PATH)
rows = conn.execute(
    'SELECT role, sender_name, text FROM chat_history WHERE chat_id=? ORDER BY ts DESC LIMIT ?',
    (chat_id, limit)
).fetchall()
conn.close()

if not rows:
    print('(нет истории)')
    sys.exit(0)

for role, sender_name, text in reversed(rows):
    who = 'Клод' if role == 'assistant' else (sender_name or 'Собеседник')
    truncated = text[:200] + '…' if len(text) > 200 else text
    print(f'[{who}]: {truncated}')

import asyncio, sys, os, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from telethon import TelegramClient

HERE = os.path.dirname(os.path.abspath(__file__))
# Load .env
for line in open(os.path.join(HERE, '.env')):
    m = line.strip()
    if '=' in m and not m.startswith('#'):
        k, v = m.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())

API_ID = int(os.environ['API_ID'])
API_HASH = os.environ['API_HASH']
SESSION = os.path.join(HERE, 'userbot')

async def main():
    peer_arg = sys.argv[1]
    peer = int(peer_arg) if peer_arg.lstrip('-').isdigit() else peer_arg
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        messages = []
        async for msg in client.iter_messages(peer, limit=limit):
            sender = 'Ты' if msg.out else (getattr(msg.sender, 'first_name', '') or str(msg.sender_id))
            text = msg.text or '[медиа]'
            messages.append(f"{sender}: {text}")
        for m in reversed(messages):
            print(m)

asyncio.run(main())

import asyncio, sys, os, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
for line in open(os.path.join(HERE, '.env')):
    m = line.strip()
    if '=' in m and not m.startswith('#'):
        k, v = m.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())

from telethon import TelegramClient

API_ID = int(os.environ['API_ID'])
API_HASH = os.environ['API_HASH']
SESSION = os.path.join(HERE, 'userbot')

async def main():
    peer_arg = sys.argv[1]
    peer = int(peer_arg) if peer_arg.lstrip('-').isdigit() else peer_arg
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    out_dir = sys.argv[3] if len(sys.argv) > 3 else HERE

    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        async for msg in client.iter_messages(peer, limit=limit):
            if msg.photo:
                path = os.path.join(out_dir, f"photo_{msg.id}.jpg")
                await client.download_media(msg, file=path)
                print(f"PHOTO msg_id={msg.id} caption={repr(msg.text or '')} saved={path}")
                break  # just the latest photo

asyncio.run(main())

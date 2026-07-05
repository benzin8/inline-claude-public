# -*- coding: utf-8 -*-
"""Send a message to a target as the authorized account (дима).
Usage: python send_message.py "<target>" <message_file_utf8>
Run ONLY when дима explicitly asks to send something. Prints the resolved
recipient (name/@username/id) before sending so the target can be verified.
"""
import asyncio, os, sys
from pathlib import Path
from dotenv import load_dotenv
from telethon import TelegramClient

HERE = Path(__file__).parent
load_dotenv(HERE / ".env")
API_ID = int(os.environ["API_ID"]); API_HASH = os.environ["API_HASH"]
SESSION = str(HERE / "userbot.session")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

target = sys.argv[1]
text = Path(sys.argv[2]).read_text(encoding="utf-8").strip()

async def resolve(client, target):
    # Guard: never resolve an empty/blank target — an empty substring would
    # match the FIRST dialog and spam a random chat.
    if not target or not target.strip():
        return None
    try:
        return await client.get_entity(target)
    except Exception:
        pass
    # Substring fallback only for reasonably specific targets (avoid 1-2 char
    # strings matching unrelated dialogs).
    t = target.strip().lower()
    if len(t) < 3:
        return None
    async for d in client.iter_dialogs():
        if t in (d.name or "").lower():
            return d.entity
    return None

async def main():
    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print("ERROR: session not authorized"); return
    ent = await resolve(client, target)
    if ent is None:
        print(f"ERROR: target '{target}' not found"); await client.disconnect(); return
    name = getattr(ent, 'first_name', None) or getattr(ent, 'title', None) or str(ent.id)
    uname = getattr(ent, 'username', None)
    print(f"RECIPIENT: {name} (@{uname}) id={ent.id}")
    sent = await client.send_message(ent, text)
    print(f"SENT ok, message_id={sent.id}")
    await client.disconnect()

asyncio.run(main())

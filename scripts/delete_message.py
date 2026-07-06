# -*- coding: utf-8 -*-
"""Delete a message sent earlier by the userbot (cleanup for bridge trigger messages).
Usage: python delete_message.py <target> <message_id>
"""
import asyncio
import os
import sys
from pathlib import Path

HERE = Path(__file__).parent
for line in (HERE / ".env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

from telethon import TelegramClient

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
SESSION = str(HERE / "userbot")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

target = sys.argv[1]
message_id = int(sys.argv[2])


async def main():
    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print("ERROR: session not authorized")
        return
    try:
        entity = await client.get_entity(target)
        await client.delete_messages(entity, [message_id])
        print(f"DELETED message_id={message_id}")
    except Exception as e:
        print(f"ERROR: {e}")
    finally:
        await client.disconnect()


asyncio.run(main())

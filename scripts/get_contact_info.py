# -*- coding: utf-8 -*-
"""Fetch profile info about a Telegram user via the userbot session and print it as JSON.
Usage: python get_contact_info.py <chat_id>

Meant to be run once per new counterpart (see db.ts `hasHistory` / server.ts business_message
handler) so their profile gets cached in the `contacts` table instead of being re-fetched
on every message.
"""
import asyncio
import json
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
from telethon.tl.functions.users import GetFullUserRequest

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
SESSION = str(HERE / "userbot")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


async def main():
    chat_id = int(sys.argv[1])
    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print(json.dumps({"error": "session not authorized"}))
        return
    try:
        entity = await client.get_entity(chat_id)
        full = await client(GetFullUserRequest(entity))
        info = {
            "first_name": getattr(entity, "first_name", None),
            "last_name": getattr(entity, "last_name", None),
            "username": getattr(entity, "username", None),
            "phone": getattr(entity, "phone", None),
            "about": getattr(full.full_user, "about", None),
            "is_contact": bool(getattr(entity, "contact", False)),
            "premium": bool(getattr(entity, "premium", False)),
            "common_chats_count": getattr(full.full_user, "common_chats_count", None),
        }
        print(json.dumps(info, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
    finally:
        await client.disconnect()


asyncio.run(main())

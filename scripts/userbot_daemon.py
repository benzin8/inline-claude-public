# -*- coding: utf-8 -*-
"""Persistent Telethon daemon — keeps ONE authenticated userbot connection alive
and serves send_message/get_contact_info/delete_message over a local TCP socket,
so server.ts doesn't have to pay Python-startup + Telethon-auth-handshake cost
(1-3+ seconds) on every single trigger delivery/cleanup/contact-fetch.

Protocol: newline-delimited JSON. One request per line, one JSON response per line,
then the connection is closed. Requests:
  {"action": "send_message", "target": "...", "text": "..."}
  {"action": "get_contact_info", "chat_id": "..."}
  {"action": "delete_message", "target": "...", "message_id": "..."}
  {"action": "ping"}

Usage: python userbot_daemon.py
Logs to daemon.log in this directory. Writes its own PID to daemon.pid so
server.ts (or a human) can check whether it's already running before spawning
another instance.
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
PORT = int(os.environ.get("USERBOT_DAEMON_PORT", "8765"))
PID_FILE = HERE / "daemon.pid"
LOG_FILE = HERE / "daemon.log"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def log(msg: str) -> None:
    import datetime
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


client = TelegramClient(SESSION, API_ID, API_HASH)


async def do_send_message(req):
    ent = await client.get_entity(req["target"])
    sent = await client.send_message(ent, req["text"])
    return {"ok": True, "message_id": sent.id}


async def do_get_contact_info(req):
    entity = await client.get_entity(int(req["chat_id"]))
    full = await client(GetFullUserRequest(entity))
    return {
        "ok": True,
        "info": {
            "first_name": getattr(entity, "first_name", None),
            "last_name": getattr(entity, "last_name", None),
            "username": getattr(entity, "username", None),
            "phone": getattr(entity, "phone", None),
            "about": getattr(full.full_user, "about", None),
            "is_contact": bool(getattr(entity, "contact", False)),
            "premium": bool(getattr(entity, "premium", False)),
            "common_chats_count": getattr(full.full_user, "common_chats_count", None),
        },
    }


async def do_delete_message(req):
    ent = await client.get_entity(req["target"])
    await client.delete_messages(ent, [int(req["message_id"])])
    return {"ok": True}


ACTIONS = {
    "send_message": do_send_message,
    "get_contact_info": do_get_contact_info,
    "delete_message": do_delete_message,
    "ping": lambda req: asyncio.sleep(0, result={"ok": True, "pong": True}),
}


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    try:
        raw = await asyncio.wait_for(reader.readline(), timeout=10)
        if not raw:
            return
        req = json.loads(raw.decode("utf-8"))
        action = req.get("action")
        handler = ACTIONS.get(action)
        if not handler:
            result = {"ok": False, "error": f"unknown action: {action}"}
        else:
            try:
                result = await handler(req)
            except Exception as e:
                result = {"ok": False, "error": str(e)}
        log(f"{peer} action={action} ok={result.get('ok')}")
        writer.write((json.dumps(result) + "\n").encode("utf-8"))
        await writer.drain()
    except Exception as e:
        log(f"{peer} handler crashed: {e}")
    finally:
        writer.close()


async def main():
    log("connecting Telethon client...")
    await client.start()
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    log(f"connected, pid={os.getpid()}")
    server = await asyncio.start_server(handle_client, "127.0.0.1", PORT)
    log(f"listening on 127.0.0.1:{PORT}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

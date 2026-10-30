import asyncio
from collections import deque
import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from redis.asyncio import Redis

from app import database


BASE_DIR = Path(__file__).resolve().parent.parent
PUBLIC_DIR = BASE_DIR / "public"
USERNAME_RE = re.compile(r"[^\x00-\x1f]{1,20}")
MAX_MESSAGE_LENGTH = 500
MENTION_RE = re.compile(r'(?<![\w@])@"([^"\r\n]{1,20})"|(?<![\w@])@([^\s@,.:;!?()]+)')
ROOM_NAME_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?")
PRESENCE_TTL_SECONDS = 45
MESSAGE_RATE_LIMIT = 5
MESSAGE_RATE_WINDOW_SECONDS = 10
REFRESH_USERNAME_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""
RELEASE_USERNAME_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""
CLAIM_ROOM_SLOT_SCRIPT = """
if redis.call('GET', KEYS[3]) == 'closing' then return -2 end
if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return -1
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[6]) then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
return 1
"""
RELEASE_ROOM_SLOT_SCRIPT = """
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
if ARGV[4] == '1' and redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SET', KEYS[3], 'closing', 'EX', 300)
  return 1
end
return 0
"""
redis_client: Redis | None = None
logger = logging.getLogger(__name__)


def get_redis() -> Redis:
    global redis_client
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        raise RuntimeError("REDIS_URL is not configured")
    if redis_client is None:
        redis_client = Redis.from_url(redis_url, decode_responses=True)
    return redis_client


async def online_users(redis: Redis, room: str) -> list[str]:
    key = f"chat:presence:{{{room}}}"
    await redis.zremrangebyscore(key, "-inf", time.time() - PRESENCE_TTL_SECONDS)
    members = await redis.zrange(key, 0, -1)
    return sorted((member.split(":", 1)[1] for member in members if ":" in member), key=str.casefold)


async def publish(redis: Redis, room: str, event: dict) -> None:
    await redis.publish(f"chat:events:{room}", json.dumps(event))


app = FastAPI(title="The Hive Realtime Chat")
app.mount("/static", StaticFiles(directory=PUBLIC_DIR / "static"), name="static")


class RoomCreate(BaseModel):
    name: str
    capacity: int


@app.get("/")
async def index():
    return FileResponse(PUBLIC_DIR / "index.html")


@app.get("/rooms")
async def rooms():
    try:
        return {"rooms": await database.get_rooms()}
    except Exception as error:
        raise HTTPException(status_code=503, detail="Chat storage is unavailable") from error


@app.get("/rooms/catalog")
async def room_catalog():
    try:
        return {"rooms": await database.get_room_catalog()}
    except Exception as error:
        raise HTTPException(status_code=503, detail="Chat storage is unavailable") from error


@app.post("/rooms", status_code=201)
async def create_room(payload: RoomCreate):
    room_name = payload.name.strip().lower()
    room_name = re.sub(r"[\s_]+", "-", room_name)
    room_name = re.sub(r"-+", "-", room_name)
    if len(room_name) > 40 or not ROOM_NAME_RE.fullmatch(room_name):
        raise HTTPException(status_code=400,
                            detail="Room names must use 1–40 letters, numbers, and hyphens")
    if isinstance(payload.capacity, bool) or not 1 <= payload.capacity <= 100:
        raise HTTPException(status_code=400, detail="Room capacity must be between 1 and 100")
    try:
        return {"room": await database.create_room(room_name, payload.capacity)}
    except Exception as error:
        response = getattr(error, "response", None)
        if response is not None and response.status_code == 409:
            raise HTTPException(status_code=409, detail="A room with that name already exists") from error
        raise HTTPException(status_code=503, detail="Could not create the room") from error


@app.get("/health")
async def health():
    return {"status": "ok", "storageConfigured": bool(os.getenv("SUPABASE_URL") and
            (os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY"))),
            "redisConfigured": bool(os.getenv("REDIS_URL"))}


@app.websocket("/ws")
async def websocket_chat(socket: WebSocket):
    await socket.accept()
    redis = None
    pubsub = None
    listener = None
    room = username = member = name_key = presence_key = room_state_key = None
    is_personal = False
    slot_claimed = False
    connection_id = uuid.uuid4().hex
    send_lock = asyncio.Lock()
    message_timestamps = deque()

    async def send(payload: dict):
        async with send_lock:
            await socket.send_json(payload)

    try:
        try:
            first = json.loads(await socket.receive_text())
        except (json.JSONDecodeError, WebSocketDisconnect):
            await send({"type": "error", "message": "Invalid join request"})
            return
        if not isinstance(first, dict) or first.get("type") != "join_room":
            await send({"type": "error", "message": "Join a room first"})
            return

        raw_username = first.get("username")
        requested_room = first.get("room")
        username = raw_username.strip() if isinstance(raw_username, str) else ""
        if not USERNAME_RE.fullmatch(username):
            await send({"type": "error", "message": "Username must be 1–20 characters"})
            return
        if not isinstance(requested_room, str) or not ROOM_NAME_RE.fullmatch(requested_room):
            await send({"type": "error", "message": "Unknown room"})
            return
        room = requested_room
        try:
            room_settings = await database.get_room_settings(room)
        except Exception:
            await send({"type": "error", "message": "Could not load room capacity"})
            return
        if room_settings is None:
            await send({"type": "error", "message": "Unknown room"})
            return
        room_capacity = room_settings["capacity"]
        is_personal = room_settings["is_personal"]
        try:
            redis = get_redis()
            pubsub = redis.pubsub()
            await pubsub.subscribe(f"chat:events:{room}")
            presence_key = f"chat:presence:{{{room}}}"
            room_state_key = f"chat:room-state:{{{room}}}"
            username_digest = hashlib.sha256(username.casefold().encode("utf-8")).hexdigest()
            name_key = f"chat:username:{{{room}}}:{username_digest}"
            now = time.time()
            member = f"{connection_id}:{username}"
            claimed = await redis.eval(
                CLAIM_ROOM_SLOT_SCRIPT, 3, name_key, presence_key, room_state_key,
                connection_id, PRESENCE_TTL_SECONDS, member, now,
                now - PRESENCE_TTL_SECONDS, room_capacity,
            )
            if claimed == -2:
                await send({"type": "error", "message": "This room has ended"})
                return
            if claimed == -1:
                await send({"type": "error", "message": "Username already used in this room"})
                return
            if not claimed:
                await send({"type": "error", "message": "This room is full"})
                return
            slot_claimed = True
        except Exception:
            logger.exception("Redis chat initialization failed")
            await send({"type": "error", "message": "Realtime service is unavailable"})
            return

        try:
            history = await database.get_history(room)
        except Exception:
            logger.exception("Supabase message history request failed")
            await send({"type": "error", "message": "Chat history is unavailable"})
            return

        await send({"type": "history", "room": room, "messages": history})

        async def relay_room_events():
            async for event in pubsub.listen():
                if event.get("type") != "message":
                    continue
                try:
                    payload = json.loads(event["data"])
                    if payload.get("sender_id") != connection_id:
                        await send(payload)
                except (json.JSONDecodeError, RuntimeError, WebSocketDisconnect):
                    return

        listener = asyncio.create_task(relay_room_events())
        await send({"type": "presence_update", "room": room,
                    "users": await online_users(redis, room)})
        await publish(redis, room, {"type": "presence_update", "room": room,
                                     "users": await online_users(redis, room),
                                     "sender_id": connection_id})
        while True:
            try:
                raw = await asyncio.wait_for(socket.receive_text(), timeout=20)
            except asyncio.TimeoutError:
                await redis.zadd(presence_key, {member: time.time()})
                await redis.expire(presence_key, PRESENCE_TTL_SECONDS * 2)
                await redis.eval(REFRESH_USERNAME_SCRIPT, 1, name_key,
                                 connection_id, PRESENCE_TTL_SECONDS)
                await send({"type": "ping"})
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                await send({"type": "error", "message": "Invalid JSON"})
                continue
            if not isinstance(event, dict):
                await send({"type": "error", "message": "Invalid message"})
                continue
            await redis.zadd(presence_key, {member: time.time()})
            await redis.expire(presence_key, PRESENCE_TTL_SECONDS * 2)
            await redis.eval(REFRESH_USERNAME_SCRIPT, 1, name_key,
                             connection_id, PRESENCE_TTL_SECONDS)
            if event.get("type") == "pong":
                continue
            if event.get("type") == "send_message":
                client_message_id = event.get("client_message_id")

                async def report_message_error(message: str):
                    payload = {"type": "error", "message": message}
                    if isinstance(client_message_id, str):
                        payload["client_message_id"] = client_message_id
                    await send(payload)

                text = event.get("text")
                if not isinstance(text, str) or not text.strip():
                    await report_message_error("Message cannot be empty")
                    continue
                if len(text.strip()) > MAX_MESSAGE_LENGTH:
                    await report_message_error("Message cannot exceed 500 characters")
                    continue
                text = text.strip()
                raw_reply_to_id = event.get("reply_to_id")
                if raw_reply_to_id is not None and (
                    isinstance(raw_reply_to_id, bool)
                    or not isinstance(raw_reply_to_id, int)
                    or raw_reply_to_id < 1
                ):
                    await report_message_error("Invalid reply target")
                    continue
                tags = list(dict.fromkeys(
                    match.group(1) or match.group(2)
                    for match in MENTION_RE.finditer(text)
                ))
                active_names = {name.casefold(): name for name in await online_users(redis, room)}
                missing_tag = next((tag for tag in tags if tag.casefold() not in active_names), None)
                if missing_tag:
                    await report_message_error(f"User @{missing_tag} isn't in the room")
                    continue
                mentions = list(dict.fromkeys(active_names[tag.casefold()] for tag in tags))
                reply_to = None
                if raw_reply_to_id is not None:
                    try:
                        reply_to = await database.get_message(room, raw_reply_to_id)
                    except Exception:
                        await report_message_error("Could not load the message you replied to")
                        continue
                    if reply_to is None:
                        await report_message_error("That message isn't in this room")
                        continue
                now = time.monotonic()
                while message_timestamps and now - message_timestamps[0] >= MESSAGE_RATE_WINDOW_SECONDS:
                    message_timestamps.popleft()
                if len(message_timestamps) >= MESSAGE_RATE_LIMIT:
                    await report_message_error("Slow down and try again in a few seconds")
                    continue
                message_timestamps.append(now)
                try:
                    message = await database.add_message(room, username, text,
                                                         reply_to_id=raw_reply_to_id)
                    if reply_to:
                        message["reply_to"] = {
                            "id": reply_to["id"],
                            "username": reply_to["username"],
                            "text": reply_to["text"],
                        }
                    outgoing = {"type": "message", **message, "mentions": mentions}
                    if isinstance(client_message_id, str):
                        outgoing["client_message_id"] = client_message_id
                    await publish(redis, room, {**outgoing, "sender_id": connection_id})
                    await send(outgoing)
                except Exception:
                    await report_message_error("Message could not be saved")
            elif event.get("type") == "typing":
                is_typing = event.get("is_typing")
                if isinstance(is_typing, bool):
                    await publish(redis, room, {"type": "typing", "username": username,
                                                "is_typing": is_typing, "sender_id": connection_id})
            else:
                await send({"type": "error", "message": "Unknown message type"})
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await send({"type": "error", "message": "Chat connection failed"})
        except Exception:
            pass
    finally:
        if listener:
            listener.cancel()
            try:
                await listener
            except asyncio.CancelledError:
                pass
        if pubsub:
            await pubsub.aclose()
        if redis and room and member and slot_claimed:
            should_delete = await redis.eval(
                RELEASE_ROOM_SLOT_SCRIPT, 3, presence_key, name_key, room_state_key,
                member, connection_id, time.time() - PRESENCE_TTL_SECONDS,
                "1" if is_personal else "0",
            )
            if should_delete:
                try:
                    await database.delete_personal_room(room)
                    await redis.delete(room_state_key)
                except Exception:
                    logger.exception("Could not delete empty personal room")
            await publish(redis, room, {"type": "typing", "username": username,
                                        "is_typing": False, "sender_id": connection_id})
            await publish(redis, room, {"type": "presence_update", "room": room,
                                        "users": await online_users(redis, room)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))

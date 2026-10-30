import asyncio
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app import database
from app import main
from app.main import app


class FakePubSub:
    def __init__(self, redis):
        self.redis = redis
        self.queue = asyncio.Queue()
        self.channels = set()

    async def subscribe(self, channel):
        self.channels.add(channel)
        self.redis.subscribers.setdefault(channel, set()).add(self)

    async def listen(self):
        while True:
            event = await self.queue.get()
            if event is None:
                return
            yield event

    async def aclose(self):
        for channel in self.channels:
            self.redis.subscribers.get(channel, set()).discard(self)
        self.queue.put_nowait(None)


class FakeRedis:
    def __init__(self):
        self.sorted_sets = {}
        self.subscribers = {}
        self.locks = {}
        self.values = {}

    def pubsub(self):
        return FakePubSub(self)

    async def publish(self, channel, data):
        for subscriber in list(self.subscribers.get(channel, set())):
            subscriber.queue.put_nowait({"type": "message", "data": data})

    async def zremrangebyscore(self, key, minimum, maximum):
        entries = self.sorted_sets.setdefault(key, {})
        cutoff = float(maximum)
        for member, score in list(entries.items()):
            if score <= cutoff:
                del entries[member]

    async def zrange(self, key, start, end):
        entries = self.sorted_sets.setdefault(key, {})
        members = [member for member, _ in sorted(entries.items(), key=lambda row: row[1])]
        return members[start:] if end == -1 else members[start:end + 1]

    async def zadd(self, key, entries):
        self.sorted_sets.setdefault(key, {}).update(entries)

    async def expire(self, key, seconds):
        return True

    async def zrem(self, key, member):
        self.sorted_sets.setdefault(key, {}).pop(member, None)

    async def delete(self, key):
        self.values.pop(key, None)

    async def eval(self, script, numkeys, *args):
        keys = args[:numkeys]
        values = args[numkeys:]
        key = keys[0]
        if "'ZREM'" in script and "'ZCARD'" in script:
            presence_key, name_key, state_key = keys
            member, connection_id, cutoff, is_personal = values
            self.sorted_sets.setdefault(presence_key, {}).pop(member, None)
            if self.locks.get(name_key) == connection_id:
                self.locks.pop(name_key, None)
            entries = self.sorted_sets.setdefault(presence_key, {})
            for old_member, score in list(entries.items()):
                if score <= float(cutoff):
                    del entries[old_member]
            if is_personal == "1" and not entries:
                self.values[state_key] = "closing"
                return 1
            return 0
        if "'ZCARD'" in script:
            name_key, presence_key, state_key = keys
            connection_id, _, member, now, cutoff, capacity = values
            if self.values.get(state_key) == "closing":
                return -2
            if name_key in self.locks:
                return -1
            self.locks[name_key] = connection_id
            entries = self.sorted_sets.setdefault(presence_key, {})
            for old_member, score in list(entries.items()):
                if score <= float(cutoff):
                    del entries[old_member]
            if len(entries) >= int(capacity):
                del self.locks[name_key]
                return 0
            entries[member] = float(now)
            return 1
        if "'NX'" in script:
            if key in self.locks:
                return 0
            self.locks[key] = values[0]
            return 1
        if "'EXPIRE'" in script:
            return int(self.locks.get(key) == values[0])
        if "'DEL'" in script:
            if self.locks.get(key) == values[0]:
                del self.locks[key]
                return 1
            return 0


def configure_test_services(monkeypatch):
    redis = FakeRedis()
    messages = []

    async def get_rooms():
        return ["general", "football", "music"]

    async def get_room_settings(room):
        if room not in {"general", "football", "music"}:
            return None
        return {"capacity": 100, "is_personal": False}

    async def get_room_catalog():
        return [{"name": room, "capacity": 100, "is_personal": False}
                for room in await get_rooms()]

    async def get_history(room, limit=50):
        return [message for message in messages if message["room"] == room][-limit:]

    async def get_message(room, message_id):
        return next((message for message in messages
                     if message["room"] == room and message["id"] == message_id), None)

    async def add_message(room, username, text, reply_to_id=None):
        message = {"id": len(messages) + 1, "room": room, "username": username,
                   "text": text, "reply_to_id": reply_to_id,
                   "created_at": datetime.now(timezone.utc).isoformat()}
        messages.append(message)
        return message

    monkeypatch.setattr(main, "get_redis", lambda: redis)
    monkeypatch.setattr(database, "get_rooms", get_rooms)
    monkeypatch.setattr(database, "get_room_settings", get_room_settings)
    monkeypatch.setattr(database, "get_room_catalog", get_room_catalog)
    monkeypatch.setattr(database, "get_history", get_history)
    monkeypatch.setattr(database, "get_message", get_message)
    monkeypatch.setattr(database, "add_message", add_message)


def test_two_clients_exchange_message_and_load_history(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ada, client.websocket_connect("/ws") as lin:
            ada.send_json({"type": "join_room", "username": "Ada", "room": "general"})
            assert ada.receive_json()["type"] == "history"
            assert ada.receive_json()["type"] == "presence_update"
            lin.send_json({"type": "join_room", "username": "Lin", "room": "general"})
            assert lin.receive_json()["type"] == "history"
            assert lin.receive_json()["users"] == ["Ada", "Lin"]
            assert ada.receive_json()["users"] == ["Ada", "Lin"]
            ada.send_json({"type": "send_message", "text": "Hello, room!"})
            sent_event = ada.receive_json()
            event = lin.receive_json()
            assert sent_event["type"] == "message"
            assert (sent_event["username"], sent_event["text"]) == ("Ada", "Hello, room!")
            assert event["type"] == "message"
            assert (event["username"], event["text"]) == ("Ada", "Hello, room!")

        with client.websocket_connect("/ws") as newcomer:
            newcomer.send_json({"type": "join_room", "username": "Sam", "room": "general"})
            history = newcomer.receive_json()
            assert history["messages"][-1]["text"] == "Hello, room!"


def test_empty_message_gets_error_without_broadcast(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as sender, client.websocket_connect("/ws") as listener:
            sender.send_json({"type": "join_room", "username": "Ada", "room": "general"})
            sender.receive_json()
            sender.receive_json()
            listener.send_json({"type": "join_room", "username": "Lin", "room": "general"})
            listener.receive_json()
            listener.receive_json()
            sender.receive_json()
            sender.send_json({"type": "send_message", "text": "  "})
            assert sender.receive_json() == {"type": "error", "message": "Message cannot be empty"}
            listener.send_json({"type": "send_message", "text": "still connected"})
            assert sender.receive_json()["text"] == "still connected"


def test_room_and_join_validation(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        assert client.get("/rooms").json()["rooms"] == ["general", "football", "music"]
        with client.websocket_connect("/ws") as socket:
            socket.send_json({"type": "join_room", "username": "Ada", "room": "missing"})
            assert socket.receive_json()["message"] == "Unknown room"


def test_duplicate_username_is_rejected_atomically(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ada, client.websocket_connect("/ws") as duplicate:
            ada.send_json({"type": "join_room", "username": "Ada", "room": "general"})
            assert ada.receive_json()["type"] == "history"
            assert ada.receive_json()["type"] == "presence_update"
            duplicate.send_json({"type": "join_room", "username": "ada", "room": "general"})
            assert duplicate.receive_json() == {
                "type": "error", "message": "Username already used in this room"
            }


def test_message_rate_limit(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as socket:
            socket.send_json({"type": "join_room", "username": "Ada", "room": "general"})
            assert socket.receive_json()["type"] == "history"
            assert socket.receive_json()["type"] == "presence_update"
            for number in range(main.MESSAGE_RATE_LIMIT):
                socket.send_json({"type": "send_message", "text": f"message {number}"})
                assert socket.receive_json()["type"] == "message"
            socket.send_json({"type": "send_message", "text": "one too many"})
            assert socket.receive_json() == {
                "type": "error", "message": "Slow down and try again in a few seconds"
            }


def test_reply_to_any_visible_room_message(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ada, client.websocket_connect("/ws") as lin:
            ada.send_json({"type": "join_room", "username": "Ada", "room": "general"})
            ada.receive_json()
            ada.receive_json()
            lin.send_json({"type": "join_room", "username": "Lin", "room": "general"})
            lin.receive_json()
            lin.receive_json()
            ada.receive_json()

            ada.send_json({"type": "send_message", "text": "The first message"})
            original = ada.receive_json()
            lin.receive_json()
            lin.send_json({"type": "send_message", "text": "I agree", "reply_to_id": original["id"]})
            reply = lin.receive_json()
            assert reply["reply_to_id"] == original["id"]
            assert reply["reply_to"] == {
                "id": original["id"], "username": "Ada", "text": "The first message"
            }
            assert ada.receive_json()["reply_to_id"] == original["id"]


def test_mentions_require_user_to_be_in_room(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ada:
            ada.send_json({"type": "join_room", "username": "Ada", "room": "general"})
            ada.receive_json()
            ada.receive_json()
            with client.websocket_connect("/ws") as lin:
                lin.send_json({"type": "join_room", "username": "Lin", "room": "general"})
                lin.receive_json()
                lin.receive_json()
                ada.receive_json()
                ada.send_json({"type": "send_message", "text": 'Hey @"Lin"'})
                mentioned = ada.receive_json()
                assert mentioned["mentions"] == ["Lin"]
                assert lin.receive_json()["mentions"] == ["Lin"]

            ada.send_json({"type": "send_message", "text": "Are you there @Lin?"})
            response = ada.receive_json()
            while response["type"] != "error":
                response = ada.receive_json()
            assert response == {"type": "error", "message": "User @Lin isn't in the room"}


def test_reply_to_missing_or_other_room_message_is_rejected(monkeypatch):
    configure_test_services(monkeypatch)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as socket:
            socket.send_json({"type": "join_room", "username": "Ada", "room": "general"})
            socket.receive_json()
            socket.receive_json()
            socket.send_json({"type": "send_message", "text": "Reply to this", "reply_to_id": 999})
            assert socket.receive_json() == {
                "type": "error", "message": "That message isn't in this room"
            }

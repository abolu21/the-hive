# The Hive — Vercel WebSocket Chat

A room chat served by FastAPI on Vercel. Browsers use a real WebSocket at `/ws` for messages, presence, and typing. Supabase Postgres stores message history; Redis shares presence and events across Vercel Function instances. Vercel supports WebSockets with ASGI frameworks including FastAPI; Fluid Compute must be enabled.

## Services to connect

### Supabase message storage

1. Create a Supabase project.
2. Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor. It creates the built-in rooms and messages table, and adds room capacity fields. Rerun it to apply schema updates safely.
3. Copy the project URL and a secret API key (`sb_secret_...`) from **Project Settings → API Keys**.

The secret key is used only by the FastAPI backend and bypasses RLS. Do not expose it to the browser or commit it to source control. The legacy service-role key is also accepted.

### Redis room state

Create a Redis database and configure its TLS connection URL as `REDIS_URL`. The Vercel Marketplace Redis integration or an Upstash Redis database can provide this. Use a Redis connection URL (`rediss://...` where TLS is required), not the HTTP REST URL. Redis pub/sub carries room events between Vercel instances; sorted sets track active users and expire stale presence.

## Deploy to Vercel

1. Import this repository with the project root set to the repository root. Vercel detects the FastAPI app exported from [`index.py`](index.py).
2. Add these Vercel environment variables for Production and Preview:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | Your Supabase project URL |
   | `SUPABASE_SECRET_KEY` | Your Supabase secret key (`sb_secret_...`) |
   | `REDIS_URL` | Your Redis TLS connection URL |

3. Enable Fluid Compute in the Vercel project settings. WebSocket support requires it.
4. Redeploy after setting the variables.

The app uses a root `index.py` entrypoint, Python 3.12, and `uvicorn[standard]` for ASGI WebSocket support. Connections can close when a Function reaches its maximum duration, so the browser reconnects and reloads recent history automatically.

## Run locally

Requires Python 3.12, the Vercel CLI, Redis, and a Supabase project with the SQL schema installed.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env.local
```

Set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `REDIS_URL` in `.env.local`, then start Vercel's local runtime:

```bash
vercel dev
```

Open the local URL printed by Vercel. Use two browser windows to test realtime behavior.

## Components and data flow

- **WebSocket server:** FastAPI validates `join_room`, `send_message`, and `typing` events at `/ws`.
- **Persistence:** messages are inserted into Supabase Postgres before they are broadcast; new joiners receive the latest 50.
- **Presence and fanout:** Redis holds expiring room membership and publishes events across Vercel instances.
- **Rooms:** the directory includes AI, Politics, and Personal Development. People can stay connected to several rooms and switch between them. Personal rooms are unlisted, joinable by exact name, and enforce a 1–100 simultaneous-user limit. The room and its messages are deleted after its last member leaves.
- **Abuse protection:** each connection is limited to five messages per ten seconds; room usernames are claimed atomically in Redis.
- **Replies and mentions:** messages can reply to any loaded message in the room; `@name` and `@"name with spaces"` tags are accepted only while that user is present. Clicking a room member inserts their tag.
- **UI:** the browser reconnects after disconnects, reloads history, and renders messages as text. The room dialog joins or creates a room while keeping other joined rooms connected.
- **Operations:** `/health` and `/rooms` are HTTP endpoints; tests cover multi-client delivery and invalid messages.

```text
Browser ── WebSocket /ws ── Vercel FastAPI Function
                                   ├── Supabase Postgres (history)
                                   └── Redis (presence + cross-instance pub/sub)
```

## WebSocket protocol

The first message must be `{"type":"join_room","username":"Ada","room":"general"}`. After joining, clients send `send_message` with `text` and optional `reply_to_id`, `typing` with boolean `is_typing`, and `pong` for server heartbeats.

Server events are `history` (`room`, `messages`), `message` (`id`, `room`, `username`, `text`, `created_at`, optional `reply_to_id` and `reply_to`, plus `mentions`), `presence_update` (`room`, `users`), `typing` (`username`, `is_typing`), `ping`, and `error` (`message`).

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Chat UI |
| GET | `/rooms` | Room names |
| GET | `/rooms/catalog` | Room names, capacities, and room type |
| POST | `/rooms` | Create an unlisted personal room (`name`, `capacity`) |
| GET | `/health` | Health check |
| WS | `/ws` | Realtime chat connection |

## Tests

```bash
pytest -v
```

Tests use isolated in-memory Redis and mocked persistence to verify two-client message delivery, history loading, room validation, and rejection of empty messages.

## Demo script

1. Open the app in two browser windows and join `general` as Ada and Lin.
2. Show both names in the room list and type in one window to show the other user's typing indicator.
3. Send a message and show it arrive in both windows without refreshing.
4. Rejoin with a third name to show saved history; close a window to show presence cleanup.
5. Explain the split: WebSockets run through Vercel FastAPI; Redis coordinates function instances; Supabase stores durable messages.

## MVP limits

This MVP has no accounts or authorization; users choose room names and anyone can post. Add authentication and moderation/reporting controls before opening it to untrusted traffic. Redis membership is temporary and expires if a connection disappears without cleanup.

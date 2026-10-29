import os

import httpx


def _settings() -> tuple[str, str, bool]:
    base_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    secret_key = os.getenv("SUPABASE_SECRET_KEY", "")
    legacy_service_key = False
    if not secret_key:
        secret_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        legacy_service_key = bool(secret_key)
    if not base_url or not secret_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY are required")
    return base_url, secret_key, legacy_service_key


def _headers(secret_key: str, legacy_service_key: bool) -> dict[str, str]:
    headers = {"apikey": secret_key}
    if legacy_service_key:
        headers["Authorization"] = f"Bearer {secret_key}"
    return headers


async def get_rooms() -> list[str]:
    base_url, secret_key, legacy_service_key = _settings()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            f"{base_url}/rest/v1/rooms",
            params={"select": "name", "order": "name.asc"},
            headers=_headers(secret_key, legacy_service_key),
        )
    response.raise_for_status()
    return [row["name"] for row in response.json()]


async def get_history(room: str, limit: int = 50) -> list[dict]:
    base_url, secret_key, legacy_service_key = _settings()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            f"{base_url}/rest/v1/messages",
            params={"select": "id,room,username,text,created_at,reply_to_id", "room": f"eq.{room}",
                    "order": "id.desc", "limit": limit},
            headers=_headers(secret_key, legacy_service_key),
        )
    response.raise_for_status()
    return list(reversed(response.json()))


async def get_message(room: str, message_id: int) -> dict | None:
    base_url, secret_key, legacy_service_key = _settings()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            f"{base_url}/rest/v1/messages",
            params={"select": "id,room,username,text,created_at", "room": f"eq.{room}",
                    "id": f"eq.{message_id}", "limit": 1},
            headers=_headers(secret_key, legacy_service_key),
        )
    response.raise_for_status()
    rows = response.json()
    return rows[0] if rows else None


async def add_message(room: str, username: str, text: str,
                      reply_to_id: int | None = None) -> dict:
    base_url, secret_key, legacy_service_key = _settings()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"{base_url}/rest/v1/messages",
            params={"select": "id,room,username,text,created_at,reply_to_id"},
            headers={**_headers(secret_key, legacy_service_key), "Prefer": "return=representation"},
            json={"room": room, "username": username, "text": text,
                  "reply_to_id": reply_to_id},
        )
    response.raise_for_status()
    rows = response.json()
    if not rows:
        raise RuntimeError("Message insert returned no row")
    return rows[0]

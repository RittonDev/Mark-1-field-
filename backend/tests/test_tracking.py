"""Rastreamento dos técnicos: jornada, posições, mapa ao vivo e histórico."""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


def ping(at: datetime, lat: float = -23.56, lng: float = -46.65, **extra: object) -> dict:
    return {"recorded_at": at.isoformat(), "latitude": lat, "longitude": lng, **extra}


async def start_shift(client: AsyncClient, headers: dict) -> dict:
    assert (await client.post(f"{API}/tracking/consent", headers=headers)).status_code == 204
    r = await client.post(f"{API}/tracking/shift/start", json={}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def test_shift_requires_consent_and_bounds_pings(client: AsyncClient, world: World) -> None:
    h = world.tech.headers
    r = await client.post(f"{API}/tracking/shift/start", json={}, headers=h)
    assert r.status_code == 409  # sem aceite do termo, a jornada não começa
    before_shift = datetime.now(UTC) - timedelta(minutes=30)

    shift = await start_shift(client, h)
    me = (await client.get(f"{API}/auth/me", headers=h)).json()
    assert me["location_consent_at"] is not None
    assert (await client.get(f"{API}/tracking/shift", headers=h)).json()["shift"]["id"] == shift[
        "id"
    ]

    now = datetime.now(UTC)
    batch = [
        ping(before_shift),  # antes da jornada: descartado (privacidade)
        ping(now - timedelta(seconds=30), battery_pct=80),
        ping(now, speed_mps=12.5),
        ping(now + timedelta(hours=1)),  # no futuro: descartado
    ]
    r = await client.post(f"{API}/tracking/pings", json={"pings": batch}, headers=h)
    assert r.json() == {"accepted": 2, "discarded": 2}

    # Reenvio do lote (o app perdeu a resposta): nada duplica.
    r = await client.post(f"{API}/tracking/pings", json={"pings": [ping(now)]}, headers=h)
    assert r.json() == {"accepted": 0, "discarded": 1}

    # Só o técnico envia posição.
    r = await client.post(
        f"{API}/tracking/pings", json={"pings": [ping(now)]}, headers=world.analyst.headers
    )
    assert r.status_code == 403

    r = await client.post(f"{API}/tracking/shift/end", json={}, headers=h)
    assert r.json()["ended_at"] is not None
    assert (await client.get(f"{API}/tracking/shift", headers=h)).json()["shift"] is None


async def test_live_map_states_and_history(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    th, an = world.tech.headers, world.analyst.headers
    tech_id = str(world.tech.user.id)
    await start_shift(client, th)
    await client.post(
        f"{API}/tracking/pings",
        json={"pings": [ping(datetime.now(UTC), battery_pct=64, is_mock=True)]},
        headers=th,
    )

    def find(rows: list, user_id: str) -> dict:
        return next(r for r in rows if r["id"] == user_id)

    live = (await client.get(f"{API}/tracking/live", headers=an)).json()
    me = find(live, tech_id)
    assert (me["state"], me["on_shift"]) == ("available", True)
    assert me["last_position"]["battery_pct"] == 64
    assert me["last_position"]["is_mock"] is True  # GPS falso fica visível ao gestor
    assert find(live, str(world.tech_other.user.id))["state"] == "offline"

    t = await create(client, world, title="Visita", assignee_id=tech_id)
    t = await transition(client, th, t, "en_route", latitude=-23.57, longitude=-46.66)
    live = (await client.get(f"{API}/tracking/live", headers=an)).json()
    assert find(live, tech_id)["state"] == "en_route"
    assert find(live, tech_id)["current_ticket"]["code"] == t["code"]
    t = await transition(client, th, t, "in_progress")
    assert (
        find((await client.get(f"{API}/tracking/live", headers=an)).json(), tech_id)["state"]
        == "in_progress"
    )

    # Sem posição recente durante a jornada: "sem sinal".
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE location_pings SET recorded_at = recorded_at - interval '10 minutes' "
                "WHERE user_id = :u"
            ),
            {"u": uuid.UUID(tech_id)},
        )
    assert (
        find((await client.get(f"{API}/tracking/live", headers=an)).json(), tech_id)["state"]
        == "no_signal"
    )

    # O técnico não vê o mapa de ninguém.
    assert (await client.get(f"{API}/tracking/live", headers=th)).status_code == 403

    hist = (
        await client.get(f"{API}/tracking/history", params={"user_id": tech_id}, headers=an)
    ).json()
    assert len(hist["points"]) == 1
    assert [e["to_status"] for e in hist["status_events"]] == ["en_route", "in_progress"]
    assert hist["status_events"][0]["latitude"] == -23.57


async def test_forced_password_change(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE users SET must_change_password = true WHERE id = :u"),
            {"u": world.tech.user.id},
        )
    h = world.tech.headers
    assert (await client.get(f"{API}/auth/me", headers=h)).json()["must_change_password"] is True
    r = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": "errada", "new_password": "nova-senha-123"},
        headers=h,
    )
    assert r.status_code == 422
    r = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": "senha-teste-123", "new_password": "nova-senha-123"},
        headers=h,
    )
    assert r.status_code == 204
    r = await client.post(
        f"{API}/auth/login",
        json={"email": "tecnico@teste.com.br", "password": "nova-senha-123", "channel": "mobile"},
    )
    assert r.status_code == 200
    assert r.json()["user"]["must_change_password"] is False

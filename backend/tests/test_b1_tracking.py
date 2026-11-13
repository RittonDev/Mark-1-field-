"""Jornada e posição do técnico: limite da jornada, uma jornada aberta por vez, retirada do aceite
do termo e a posição de agora só com a jornada aberta (mapa, distâncias e sugestões; LGPD)."""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.models import TechnicianShift
from tests.conftest import World, requires_db
from tests.test_api import create, transition
from tests.test_b1_tickets import _sql, _store
from tests.test_tracking import ping, start_shift

pytestmark = requires_db

API = settings.API_PREFIX


def _row(rows: list[dict], user_id: object) -> dict:
    return next(r for r in rows if r["id"] == str(user_id))


async def _open_shifts(engine: AsyncEngine, user_id: uuid.UUID) -> int:
    async with engine.connect() as conn:
        count = await conn.scalar(
            text(
                "SELECT count(*) FROM technician_shifts WHERE user_id = :u AND ended_at IS NULL"
            ),
            {"u": user_id},
        )
    return int(count or 0)


async def test_forgotten_shift_closes_itself(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    th, an = world.tech.headers, world.analyst.headers
    tech = world.tech.user.id
    forgotten = await start_shift(client, th)
    # Ficou aberta desde ontem (15 h): passou do limite da jornada.
    await _sql(
        engine,
        "UPDATE technician_shifts SET started_at = now() - interval '15 hours' WHERE user_id = :u",
        u=tech,
    )
    # A posição de agora não é mais da jornada: não é gravada nem aparece no mapa.
    r = await client.post(
        f"{API}/tracking/pings", json={"pings": [ping(datetime.now(UTC))]}, headers=th
    )
    assert r.json() == {"accepted": 0, "discarded": 1}
    me = _row((await client.get(f"{API}/tracking/live", headers=an)).json(), tech)
    assert (me["state"], me["on_shift"], me["last_position"]) == ("offline", False, None)

    # O app confere a jornada: foi encerrada no limite, e uma nova pode começar.
    assert (await client.get(f"{API}/tracking/shift", headers=th)).json() == {"shift": None}
    async with engine.connect() as conn:
        length = await conn.scalar(
            text("SELECT ended_at - started_at FROM technician_shifts WHERE id = :i"),
            {"i": uuid.UUID(forgotten["id"])},
        )
    assert length == timedelta(hours=14)
    fresh = await start_shift(client, th)
    assert fresh["id"] != forgotten["id"]


async def test_only_one_shift_stays_open(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    th = world.tech.headers
    tech = world.tech.user.id
    first = await start_shift(client, th)
    again = (await client.post(f"{API}/tracking/shift/start", json={}, headers=th)).json()
    assert again["id"] == first["id"]  # toque duplo ou reenvio: a mesma jornada

    # Sobra de dois "iniciar" ao mesmo tempo: a consulta deixa uma só aberta.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(TechnicianShift(user_id=tech, started_at=datetime.now(UTC) - timedelta(minutes=1)))
        await db.commit()
    assert await _open_shifts(engine, tech) == 2
    current = (await client.get(f"{API}/tracking/shift", headers=th)).json()["shift"]
    assert current["id"] == first["id"]
    assert await _open_shifts(engine, tech) == 1

    ended = (await client.post(f"{API}/tracking/shift/end", json={}, headers=th)).json()
    assert ended["id"] == first["id"] and ended["ended_at"] is not None
    assert await _open_shifts(engine, tech) == 0


async def test_technician_withdraws_the_tracking_consent(
    client: AsyncClient, world: World
) -> None:
    th = world.tech.headers
    await start_shift(client, th)
    office = await client.delete(f"{API}/tracking/consent", headers=world.analyst.headers)
    assert office.status_code == 403
    assert (await client.delete(f"{API}/tracking/consent", headers=th)).status_code == 204

    # A jornada acaba na hora e a próxima só começa com um novo aceite.
    assert (await client.get(f"{API}/tracking/shift", headers=th)).json() == {"shift": None}
    assert (await client.get(f"{API}/auth/me", headers=th)).json()["location_consent_at"] is None
    r = await client.post(f"{API}/tracking/shift/start", json={}, headers=th)
    assert r.status_code == 409 and "termo" in r.json()["detail"]
    # Sem jornada aberta, retirar de novo também responde sem erro.
    assert (await client.delete(f"{API}/tracking/consent", headers=th)).status_code == 204


async def test_live_map_shows_only_the_current_shift(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    th, an = world.tech.headers, world.analyst.headers
    tech = world.tech.user.id
    await start_shift(client, th)
    await client.post(
        f"{API}/tracking/pings", json={"pings": [ping(datetime.now(UTC))]}, headers=th
    )
    await client.post(f"{API}/tracking/shift/end", json={}, headers=th)
    # Aquela jornada foi ontem à noite (o último ponto, em casa).
    await _sql(
        engine,
        "UPDATE technician_shifts SET started_at = started_at - interval '10 hours', "
        "ended_at = ended_at - interval '10 hours' WHERE user_id = :u",
        u=tech,
    )
    await _sql(
        engine,
        "UPDATE location_pings SET recorded_at = recorded_at - interval '10 hours' "
        "WHERE user_id = :u",
        u=tech,
    )

    # Jornada nova, ainda sem ponto: disponível (não "sem sinal") e sem a posição de ontem.
    await start_shift(client, th)
    me = _row((await client.get(f"{API}/tracking/live", headers=an)).json(), tech)
    assert (me["on_shift"], me["state"], me["last_position"]) == (True, "available", None)


async def test_helper_in_the_field_shows_on_the_live_map(client: AsyncClient, world: World) -> None:
    th, an = world.tech.headers, world.analyst.headers
    helper = world.tech_other
    t = await create(
        client, world, assignee_id=str(world.tech.user.id), helper_ids=[str(helper.user.id)]
    )
    await start_shift(client, helper.headers)
    await client.post(
        f"{API}/tracking/pings", json={"pings": [ping(datetime.now(UTC))]}, headers=helper.headers
    )
    t = await transition(client, th, t, "en_route")
    me = _row((await client.get(f"{API}/tracking/live", headers=an)).json(), helper.user.id)
    assert (me["state"], me["current_ticket"]["code"]) == ("en_route", t["code"])


async def test_position_counts_for_distances_only_during_the_shift(
    client: AsyncClient, world: World
) -> None:
    th, an = world.tech.headers, world.analyst.headers
    store = await _store(
        client,
        world,
        name="Loja Paulista",
        city="São Paulo",
        state="SP",
        latitude=-23.5614,
        longitude=-46.6559,
    )
    await start_shift(client, th)
    near = ping(datetime.now(UTC), lat=-23.5505, lng=-46.6333)
    await client.post(f"{API}/tracking/pings", json={"pings": [near]}, headers=th)

    async def views() -> tuple[dict, dict]:
        where = {"location_id": store}
        dist = (await client.get(f"{API}/tracking/distances", params=where, headers=an)).json()
        hint = (await client.get(f"{API}/technicians/suggest", params=where, headers=an)).json()
        return _row(dist["technicians"], world.tech.user.id), _row(hint, world.tech.user.id)

    row, suggestion = await views()
    assert row["live"] is not None and row["live_to_place"] is not None
    assert suggestion["on_shift"] is True
    assert any(r.startswith("Em jornada agora a") for r in suggestion["reasons"])

    # Encerrou a jornada: a posição de agora some do mapa e das sugestões.
    await client.post(f"{API}/tracking/shift/end", json={}, headers=th)
    row, suggestion = await views()
    assert (row["live"], row["live_at"], row["live_to_place"], row["live_to_home"]) == (
        None,
        None,
        None,
        None,
    )
    assert suggestion["on_shift"] is False
    assert not any(r.startswith("Em jornada") for r in suggestion["reasons"])

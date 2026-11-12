"""Mapa ao vivo com a loja escolhida: distância de onde o técnico está agora e da casa dele até a
loja, e de onde ele está até a casa."""

import uuid
from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.models import User
from app.services.map_distances import travel_minutes
from tests.conftest import World, requires_db

API = settings.API_PREFIX


async def _store(client: AsyncClient, world: World, name: str, **coords: float) -> dict:
    r = await client.post(
        f"{API}/customers/{world.customer_id}/locations",
        json={"name": name, "city": "São Paulo", "state": "SP", **coords},
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


@requires_db
async def test_distances_from_now_and_from_home(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    store = await _store(client, world, "Loja Paulista", latitude=-23.5614, longitude=-46.6559)

    # Técnico 1: em jornada no centro de SP (~2,6 km da loja) e com a casa cadastrada (~7 km).
    assert (await client.post(f"{API}/tracking/consent", headers=th)).status_code == 204
    await client.post(f"{API}/tracking/shift/start", json={}, headers=th)
    ping = {"recorded_at": datetime.now(UTC).isoformat(), "latitude": -23.5505, "longitude": -46.6333}
    await client.post(f"{API}/tracking/pings", json={"pings": [ping]}, headers=th)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        tech = await db.get(User, uuid.UUID(str(world.tech.user.id)))
        other = await db.get(User, uuid.UUID(str(world.tech_other.user.id)))
        assert tech is not None and other is not None
        tech.home_latitude, tech.home_longitude = -23.6000, -46.7000
        tech.home_city, tech.home_state, tech.address_line = "São Paulo", "SP", "Rua das Flores, 10"
        # Técnico 2: sem casa no cadastro, só a base (Campinas, onde mais atende).
        other.base_city, other.base_state = "Campinas", "SP"
        other.base_latitude, other.base_longitude = -22.9056, -47.0608
        await db.commit()

    r = await client.get(f"{API}/tracking/distances", params={"location_id": store["id"]}, headers=an)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["place"]["approximate"] is False
    first, second = data["technicians"][0], data["technicians"][1]

    # Mais perto primeiro: quem está a 2,6 km agora vem antes de quem tem a base em Campinas.
    assert first["id"] == str(world.tech.user.id)
    assert 2 < first["live_to_place"]["km"] < 3.5
    assert 6 < first["home_to_place"]["km"] < 9
    assert first["live_to_home"]["km"] > 0
    assert first["home"]["kind"] == "home" and first["home"]["label"].startswith("Casa · Rua das Flores")
    assert first["live_to_place"]["road_km"] > first["live_to_place"]["km"]
    assert first["live_at"] is not None

    assert second["id"] == str(world.tech_other.user.id)
    assert second["live"] is None and second["live_to_place"] is None
    assert second["home"]["kind"] == "base_city" and second["home"]["approximate"] is True
    assert 70 < second["home_to_place"]["km"] < 100
    assert second["home_to_place"]["approximate"] is True

    # Sem loja: posição e casa de cada um, sem as distâncias até a loja.
    data = (await client.get(f"{API}/tracking/distances", headers=an)).json()
    assert data["place"] is None
    row = next(t for t in data["technicians"] if t["id"] == str(world.tech.user.id))
    assert row["live"] is not None and row["home"] is not None and row["live_to_home"] is not None
    assert row["live_to_place"] is None

    # Loja sem coordenada: mede pelo centro das lojas da cidade (aproximado).
    loose = await _store(client, world, "Loja sem mapa")
    data = (
        await client.get(f"{API}/tracking/distances", params={"location_id": loose["id"]}, headers=an)
    ).json()
    assert data["place"]["approximate"] is True

    # Só a gestão vê o mapa (e a casa dos técnicos).
    r = await client.get(f"{API}/tracking/distances", headers=th)
    assert r.status_code == 403


def test_travel_minutes() -> None:
    assert travel_minutes(10) == 24  # cidade: 25 km/h
    assert travel_minutes(50) == 60  # estrada: 50 km/h
    assert travel_minutes(0.1) == 1

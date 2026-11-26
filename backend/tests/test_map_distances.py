"""Mapa ao vivo com a loja escolhida: distância de onde o técnico está agora e da casa dele até a
loja, e de onde ele está até a casa."""

import uuid
from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import OperationalStatus, UserRole
from app.models import User
from app.services.map_distances import street_text, travel_minutes
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
    ping = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "latitude": -23.5505,
        "longitude": -46.6333,
    }
    await client.post(f"{API}/tracking/pings", json={"pings": [ping]}, headers=th)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        tech = await db.get(User, uuid.UUID(str(world.tech.user.id)))
        other = await db.get(User, uuid.UUID(str(world.tech_other.user.id)))
        assert tech is not None and other is not None
        tech.home_latitude, tech.home_longitude = -23.6000, -46.7000
        tech.home_city, tech.home_state = "São Paulo", "SP"
        # Endereço em partes (Cadastro V2): o rótulo junta rua, número e complemento.
        tech.address_line, tech.address_number = "Rua das Flores", "10"
        tech.address_complement, tech.address_district = "Casa 2", "Bairro Exemplo"
        # Técnico 2: sem casa no cadastro, só a base (Campinas, onde mais atende).
        other.base_city, other.base_state = "Campinas", "SP"
        other.base_latitude, other.base_longitude = -22.9056, -47.0608
        await db.commit()

    r = await client.get(
        f"{API}/tracking/distances", params={"location_id": store["id"]}, headers=an
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["place"]["approximate"] is False
    first, second = data["technicians"][0], data["technicians"][1]

    # Mais perto primeiro: quem está a 2,6 km agora vem antes de quem tem a base em Campinas.
    assert first["id"] == str(world.tech.user.id)
    assert 2 < first["live_to_place"]["km"] < 3.5
    assert 6 < first["home_to_place"]["km"] < 9
    assert first["live_to_home"]["km"] > 0
    assert first["home"]["kind"] == "home"
    label = first["home"]["label"]
    assert label == "Casa · Rua das Flores, 10 - Casa 2, Bairro Exemplo, São Paulo-SP"
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
        await client.get(
            f"{API}/tracking/distances", params={"location_id": loose["id"]}, headers=an
        )
    ).json()
    assert data["place"]["approximate"] is True

    # Só a gestão vê o mapa (e a casa dos técnicos).
    r = await client.get(f"{API}/tracking/distances", headers=th)
    assert r.status_code == 403


@requires_db
async def test_map_shows_the_operational_status(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Medir técnicos (distâncias) e o mapa ao vivo: Inativo e Bloqueado sem o acesso cortado
    continuam no mapa, com a situação e o motivo para o selo (não recebem OS); o Ativo vem sem
    motivo, mesmo o reativado."""
    an = world.analyst.headers
    store = await _store(client, world, "Loja Paulista", latitude=-23.5614, longitude=-46.6559)
    tech_id = uuid.UUID(str(world.tech.user.id))
    other_id = uuid.UUID(str(world.tech_other.user.id))
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        gama = User(
            name="Tecnico Gama",
            email="tecnico.gama@exemplo.com",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=True,
            operational_status=OperationalStatus.INACTIVE,
            operational_reason="Férias coletivas",
        )
        db.add(gama)
        blocked = await db.get(User, other_id)
        reactivated = await db.get(User, tech_id)
        assert blocked is not None and reactivated is not None
        blocked.operational_status = OperationalStatus.BLOCKED
        blocked.operational_reason = "Documentação vencida"
        reactivated.operational_reason = "Voltou das férias"  # Ativo de novo
        await db.commit()
    expected = {
        str(tech_id): ("active", None),
        str(other_id): ("blocked", "Documentação vencida"),
        str(gama.id): ("inactive", "Férias coletivas"),
    }

    def badges(rows: list[dict]) -> dict[str, tuple[str, str | None]]:
        return {
            row["id"]: (row["operational_status"], row["operational_reason"])
            for row in rows
            if row["id"] in expected
        }

    r = await client.get(
        f"{API}/tracking/distances", params={"location_id": store["id"]}, headers=an
    )
    assert r.status_code == 200, r.text
    assert badges(r.json()["technicians"]) == expected
    r = await client.get(f"{API}/tracking/live", headers=an)
    assert r.status_code == 200, r.text
    assert badges(r.json()) == expected


def test_street_text_joins_the_parts() -> None:
    assert street_text("Rua Exemplo", "123", "Apto 4") == "Rua Exemplo, 123 - Apto 4"
    assert street_text("Rua Exemplo", "S/N", None) == "Rua Exemplo, S/N"
    assert street_text("Rua Exemplo", None, " Fundos ") == "Rua Exemplo - Fundos"
    # A linha inteira de antes da separação (sem número à parte) fica como está.
    assert street_text("Rua Exemplo, 123 - Apto 4", None, None) == "Rua Exemplo, 123 - Apto 4"
    assert street_text(None, "", None) == ""


def test_travel_minutes() -> None:
    assert travel_minutes(10) == 24  # cidade: 25 km/h
    assert travel_minutes(50) == 60  # estrada: 50 km/h
    assert travel_minutes(0.1) == 1

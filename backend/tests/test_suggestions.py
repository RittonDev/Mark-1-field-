"""Sugestão de técnicos pela localização da OS (ex.: OS em Santos -> quem mora em Santos)."""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.models import Location, Ticket, User
from tests.conftest import World, requires_db
from tests.test_api import create
from tests.test_technician_regions import _seed

pytestmark = requires_db

API = settings.API_PREFIX
SANTOS = (-23.9608, -46.3336)


async def test_suggests_technicians_by_city(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    await client.patch(
        f"{API}/technicians/{tech}", json={"home_city": "Santos", "home_state": "sp"}, headers=an
    )
    await client.patch(
        f"{API}/technicians/{other}",
        json={"home_city": "São Paulo", "home_state": "SP", "coverage_area": "Capital e Baixada"},
        headers=an,
    )
    loc = (
        await client.post(
            f"{API}/customers/{world.customer_id}/locations",
            json={"name": "Loja Gonzaga", "city": "Santos", "state": "SP"},
            headers=an,
        )
    ).json()
    t = await create(client, world, title="Impressora parada", location_id=loc["id"])

    r = await client.get(f"{API}/tickets/{t['id']}/technician-suggestions", headers=an)
    assert r.status_code == 200, r.text
    first, second = r.json()[0], r.json()[1]
    assert first["id"] == tech and "Mora em Santos" in first["reasons"]
    assert second["id"] == other and "Mesmo estado (SP)" in second["reasons"]
    assert any("OS em aberto" in reason for reason in first["reasons"])

    # Acentos e maiúsculas não atrapalham; serve também antes de a OS existir.
    r = await client.get(f"{API}/technicians/suggest", params={"city": "sao paulo"}, headers=an)
    assert r.json()[0]["id"] == other
    assert (
        await client.get(
            f"{API}/tickets/{t['id']}/technician-suggestions", headers=world.tech.headers
        )
    ).status_code == 403


async def test_suggestions_use_store_history_and_distance(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Endereço do Field Control não confiável: quem já atendeu a loja e está perto vem primeiro."""
    ids = await _seed(engine, world)
    an = world.analyst.headers
    t = await create(client, world, title="PDV sem rede", location_id=ids["fort1"])

    r = await client.get(f"{API}/tickets/{t['id']}/technician-suggestions", headers=an)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [row["id"] for row in rows] == [ids["tech"], ids["other"], ids["live"]]
    first = rows[0]
    # Região efetiva (a base pelo histórico), não o endereço em São Paulo.
    assert (first["home_city"], first["home_state"]) == ("Fortaleza", "CE")
    assert first["distance_km"] == 0.0
    assert any(reason.startswith("Atendeu esta loja 2x") for reason in first["reasons"])
    assert "Base em Fortaleza-CE (3 OS)" in first["reasons"]
    assert any("OS em aberto" in reason for reason in first["reasons"])
    assert any(reason.startswith("Em jornada agora a 1") for reason in rows[2]["reasons"])
    # Inativo não pode receber a OS: fica fora das sugestões.
    assert ids["inactive"] not in {row["id"] for row in rows}


async def _seed_favorites(engine: AsyncEngine, world: World) -> dict:
    """Loja em Santos-SP: um técnico com 2 OS nela (favorito pela regra), um inativo com 3
    (favorito, mas sem acesso ao app), um sem OS (para fixar) e 4 vizinhos que moram ao lado da
    loja e somam mais pontos que o fixado."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        cust = uuid.UUID(world.customer_id)
        store = Location(
            customer_id=cust,
            name="Loja Gonzaga",
            city="Santos",
            state="SP",
            latitude=SANTOS[0],
            longitude=SANTOS[1],
            is_active=True,
        )
        db.add(store)

        def tech(name: str, *, active: bool = True, neighbor: bool = False) -> User:
            user = User(
                name=name,
                email=f"{name.lower().replace(' ', '.')}@exemplo.com",
                password_hash="x",
                role=UserRole.TECHNICIAN,
                is_active=active,
            )
            if neighbor:
                user.home_city, user.home_state = "Santos", "SP"
                user.home_latitude, user.home_longitude = SANTOS
            db.add(user)
            return user

        auto = tech("Favorito Regra")
        inactive = tech("Favorito Inativo", active=False)
        pinned = tech("Favorito Fixado")
        neighbors = [tech(f"Vizinho {n}", neighbor=True) for n in range(1, 5)]
        await db.flush()
        for who, days in ((auto, 10), (auto, 20), (inactive, 5), (inactive, 15), (inactive, 25)):
            at = now - timedelta(days=days)
            db.add(
                Ticket(
                    title="Visita",
                    status=TicketStatus.CLOSED,
                    customer_id=cust,
                    location_id=store.id,
                    assignee_id=who.id,
                    resolved_at=at,
                    created_at=at,
                    updated_at=at,
                )
            )
        await db.commit()
        return {
            "store": str(store.id),
            "auto": str(auto.id),
            "inactive": str(inactive.id),
            "pinned": str(pinned.id),
            "neighbors": [str(n.id) for n in neighbors],
        }


async def test_city_favorites_get_points_and_a_guaranteed_slot(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed_favorites(engine, world)
    an = world.analyst.headers
    place = {"location_id": ids["store"]}
    neighbors = ids["neighbors"]

    r = await client.get(f"{API}/technicians/suggest", params=place, headers=an)
    assert r.status_code == 200, r.text
    assert [row["id"] for row in r.json()] == [ids["auto"], *neighbors]

    r = await client.put(
        f"{API}/technicians/favorites/{ids['pinned']}",
        json={"state": "SP", "city": "Santos", "note": "Atende aos sábados"},
        headers=an,
    )
    assert r.status_code == 200, r.text

    # O fixado ficaria em 6º: com a vaga garantida, entra nos 5 no lugar do último vizinho.
    t = await create(client, world, title="PDV sem rede", location_id=ids["store"])
    r = await client.get(f"{API}/tickets/{t['id']}/technician-suggestions", headers=an)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [row["id"] for row in rows] == [ids["auto"], *neighbors[:3], ids["pinned"]]
    auto, pinned = rows[0], rows[-1]
    assert (auto["favorite"], auto["favorite_note"]) == ("auto", None)
    assert auto["reasons"][0] == "Favorito em Santos-SP"
    assert (pinned["favorite"], pinned["favorite_note"]) == ("manual", "Atende aos sábados")
    assert pinned["reasons"][0] == "Favorito em Santos-SP"
    assert all(row["favorite"] is None for row in rows[1:4])
    assert not any("Favorito em" in reason for row in rows[1:4] for reason in row["reasons"])

    # Com limit=1 e dois favoritos, entra o de mais pontos.
    r = await client.get(f"{API}/technicians/suggest", params={**place, "limit": 1}, headers=an)
    assert [row["id"] for row in r.json()] == [ids["auto"]]

    # O inativo é favorito pela regra, mas não recebe OS: fica fora das sugestões.
    wide = {**place, "limit": 10}
    r = await client.get(f"{API}/technicians/suggest", params=wide, headers=an)
    before = {row["id"]: row for row in r.json()}
    assert ids["inactive"] not in before
    r = await client.get(f"{API}/technicians/favorites/city", params=place, headers=an)
    assert ids["inactive"] in {f["id"] for f in r.json()["favorites"]}

    # Tirado da lista, o mesmo técnico perde os 25 pontos e o motivo.
    r = await client.put(
        f"{API}/technicians/favorites/{ids['auto']}",
        json={"state": "SP", "city": "Santos", "favorite": False},
        headers=an,
    )
    assert r.status_code == 200, r.text
    r = await client.get(f"{API}/technicians/suggest", params=wide, headers=an)
    after = {row["id"]: row for row in r.json()}[ids["auto"]]
    assert after["score"] == before[ids["auto"]]["score"] - 25
    assert after["favorite"] is None
    assert not any(reason.startswith("Favorito em") for reason in after["reasons"])


async def test_suggest_can_exclude_the_ticket_being_edited(
    client: AsyncClient, world: World
) -> None:
    """No editor da OS, o próprio técnico não fica "Ocupado no horário" por causa dela."""
    tech = str(world.tech.user.id)
    an = world.analyst.headers
    later = datetime.now(UTC) + timedelta(days=2)
    day = later.replace(hour=13, minute=0, second=0, microsecond=0)
    start, end = day.isoformat(), (day + timedelta(hours=1)).isoformat()
    t = await create(
        client, world, title="Rack", assignee_id=tech, scheduled_start=start, scheduled_end=end
    )
    params = {"start": start, "end": end, "limit": 10}

    r = await client.get(f"{API}/technicians/suggest", params=params, headers=an)
    assert r.status_code == 200, r.text
    row = {item["id"]: item for item in r.json()}[tech]
    assert row["busy"] is True and "Ocupado no horário" in row["reasons"]
    assert row["day_load"] == 1

    r = await client.get(
        f"{API}/technicians/suggest", params={**params, "exclude_ticket_id": t["id"]}, headers=an
    )
    assert r.status_code == 200, r.text
    row = {item["id"]: item for item in r.json()}[tech]
    assert row["busy"] is False and "Livre no horário" in row["reasons"]
    assert row["day_load"] == 0

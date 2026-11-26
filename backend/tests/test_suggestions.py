"""Sugestão de técnicos pela localização da OS (ex.: OS em Santos -> quem mora em Santos)."""

import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.models import Location, Ticket, User
from app.services import tech_profile
from tests.conftest import World, requires_db
from tests.test_api import create
from tests.test_technician_regions import _seed

pytestmark = requires_db

API = settings.API_PREFIX
SANTOS = (-23.9608, -46.3336)
TZ = ZoneInfo(settings.TIMEZONE)


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


# ------------------------------------------------- disponibilidade informada no app


def _next_local(weekday: int, hour: int) -> datetime:
    """O próximo dia da semana (0 = segunda), a partir de amanhã, na hora local da operação."""
    now = datetime.now(TZ)
    days = (weekday - now.weekday()) % 7 or 7
    return (now + timedelta(days=days)).replace(hour=hour, minute=0, second=0, microsecond=0)


def _visit(start: datetime, hours: int, **place: object) -> dict:
    end = start + timedelta(hours=hours)
    return {**place, "start": start.isoformat(), "end": end.isoformat(), "limit": 10}


async def _set_availability(engine: AsyncEngine, user_id: uuid.UUID, slots: list[str]) -> None:
    """A disponibilidade direto nas colunas (o técnico grava pelo app, em PATCH /me/profile)."""
    stamp = {"availability": {"at": utcnow().isoformat(), "via": "app"}}
    async with engine.begin() as conn:
        await conn.execute(
            update(User)
            .where(User.id == user_id)
            .values(availability=slots, tech_profile_stamps=stamp)
        )


async def _ranking(client: AsyncClient, world: World, params: dict) -> dict[str, dict]:
    r = await client.get(f"{API}/technicians/suggest", params=params, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return {row["id"]: row for row in r.json()}


def test_availability_points_are_small() -> None:
    """Um sinal pequeno: menos que "Ocupado no horário" (−40) e que "Livre no horário" (+5)."""
    inside = tech_profile.AVAILABILITY_INSIDE_POINTS
    outside = tech_profile.AVAILABILITY_OUTSIDE_POINTS
    assert -40 < outside < 0 < inside < 5
    assert abs(outside) <= 6


async def test_availability_is_a_small_signal(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Dentro da disponibilidade informada: +2, sem motivo; fora: −6, com o motivo. Ninguém sai
    da lista, e sem o horário da visita nada muda."""
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    await client.patch(
        f"{API}/technicians/{tech}", json={"home_city": "Santos", "home_state": "SP"}, headers=an
    )
    await client.patch(
        f"{API}/technicians/{other}",
        json={"home_city": "São Paulo", "home_state": "SP"},
        headers=an,
    )
    place = {"city": "Santos", "state": "SP"}
    timed = _visit(_next_local(5, 14), 1, **place)  # sábado, das 14h às 15h
    untimed = {**place, "limit": 10}
    before = await _ranking(client, world, timed)
    plain_before = await _ranking(client, world, untimed)
    assert set(before) == set(plain_before) == {tech, other}
    for row in (*before.values(), *plain_before.values()):
        assert (row["availability"], row["availability_gaps"]) == (None, [])

    await _set_availability(engine, world.tech.user.id, ["sat:afternoon"])
    await _set_availability(engine, world.tech_other.user.id, ["mon:morning"])
    after = await _ranking(client, world, timed)
    assert set(after) == {tech, other}
    inside, outside = after[tech], after[other]
    assert inside["score"] == before[tech]["score"] + 2
    assert (inside["availability"], inside["availability_gaps"]) == ("inside", [])
    assert not any(reason.startswith("Fora da disponibilidade") for reason in inside["reasons"])
    assert inside["reasons"] == before[tech]["reasons"]
    assert outside["score"] == before[other]["score"] - 6
    assert (outside["availability"], outside["availability_gaps"]) == ("outside", ["sat:afternoon"])
    assert "Fora da disponibilidade (sáb · tarde)" in outside["reasons"]

    # Sem o horário da visita: neutro, com os mesmos pontos de antes.
    plain = await _ranking(client, world, untimed)
    for user_id, row in plain.items():
        assert (row["availability"], row["availability_gaps"]) == (None, [])
        assert row["score"] == plain_before[user_id]["score"]
        assert row["reasons"] == plain_before[user_id]["reasons"]


async def test_service_areas_come_from_the_technician(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """As áreas de atuação são as do cadastro do técnico (copiadas da ficha na aprovação)."""
    async with engine.begin() as conn:
        await conn.execute(
            update(User).where(User.id == world.tech.user.id).values(service_areas=["cftv"])
        )
    rows = await _ranking(
        client,
        world,
        {"city": "Cidade Exemplo", "state": "SP", "title": "Câmera sem imagem", "limit": 10},
    )
    assert "Atende CFTV" in rows[str(world.tech.user.id)]["reasons"]
    assert "Atende CFTV" not in rows[str(world.tech_other.user.id)]["reasons"]


async def test_availability_across_midnight(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Sexta das 23h à 1h de sábado toca a noite de sexta e a madrugada de sábado."""
    await _set_availability(engine, world.tech.user.id, ["fri:evening"])
    row = (await _ranking(client, world, _visit(_next_local(4, 23), 2)))[str(world.tech.user.id)]
    assert (row["availability"], row["availability_gaps"]) == ("outside", ["sat:night"])
    assert "Fora da disponibilidade (sáb · madrugada)" in row["reasons"]
    await _set_availability(engine, world.tech.user.id, ["fri:evening", "sat:night"])
    row = (await _ranking(client, world, _visit(_next_local(4, 23), 2)))[str(world.tech.user.id)]
    assert (row["availability"], row["availability_gaps"]) == ("inside", [])

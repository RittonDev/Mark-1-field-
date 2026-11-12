"""Região de atuação dos técnicos (pelo histórico) e busca dos mais próximos de uma loja.

Dados sintéticos: lojas em Fortaleza/Caucaia/São Paulo e técnicos fictícios.
"""

import json
import uuid
from datetime import timedelta
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.importers.fieldcontrol import home_of, placeholder_homes
from app.models import Location, LocationPing, TechnicianShift, Ticket, TicketWorklog, User
from app.services import geo
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX

FORT_1 = (-3.7319, -38.5267)
FORT_2 = (-3.7400, -38.5000)
CAUCAIA = (-3.7361, -38.6531)
SAO_PAULO = (-23.5505, -46.6333)


async def _seed(engine: AsyncEngine, world: World) -> dict[str, str]:
    """Técnico com histórico em Fortaleza (mora em SP), outro que mora em Caucaia,
    um inativo com histórico em São Paulo e um em jornada perto da loja agora."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        cust = uuid.UUID(world.customer_id)

        def loc(name: str, city: str, state: str, point: tuple[float, float] | None) -> Location:
            item = Location(
                customer_id=cust,
                name=name,
                city=city,
                state=state,
                latitude=point[0] if point else None,
                longitude=point[1] if point else None,
                is_active=True,
            )
            db.add(item)
            return item

        fort1 = loc("Loja Aldeota", "Fortaleza", "CE", FORT_1)
        fort2 = loc("Loja Centro", "Fortaleza", "CE", FORT_2)
        loc("Loja Caucaia", "Caucaia", "CE", CAUCAIA)
        sp = loc("Loja Paulista", "São Paulo", "SP", SAO_PAULO)
        no_coords = loc("Loja sem mapa", "Sobral", "CE", None)

        tech = await db.get(User, world.tech.user.id)
        other = await db.get(User, world.tech_other.user.id)
        assert tech is not None and other is not None
        # O endereço "padrão" (SP) não deve ganhar do histórico em Fortaleza.
        tech.home_city, tech.home_state = "São Paulo", "SP"
        tech.home_latitude, tech.home_longitude = SAO_PAULO
        other.home_city, other.home_state = "Caucaia", "CE"
        other.home_latitude, other.home_longitude = CAUCAIA
        inactive = User(
            name="Antigo",
            email="antigo@teste.com.br",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=False,
        )
        live = User(
            name="Em Rota",
            email="emrota@teste.com.br",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=True,
        )
        db.add_all([inactive, live])
        await db.flush()

        def ticket(where: Location, who: User, days_ago: int, status=TicketStatus.CLOSED) -> Ticket:
            at = now - timedelta(days=days_ago)
            item = Ticket(
                title="Visita",
                status=status,
                customer_id=cust,
                location_id=where.id,
                assignee_id=who.id,
                resolved_at=at if status == TicketStatus.CLOSED else None,
                created_at=at,
                updated_at=at,
            )
            db.add(item)
            return item

        ticket(fort1, tech, 30)
        ticket(fort1, tech, 10)
        shared = ticket(fort2, tech, 5)
        ticket(sp, inactive, 40)
        # Cancelada não conta; histórico velho (fora dos 36 meses) também não.
        ticket(sp, tech, 3, TicketStatus.CANCELLED)
        ticket(sp, tech, 365 * 4)
        await db.flush()
        # Visita anterior de outra pessoa na mesma OS conta para quem foi (apontamento).
        db.add(
            TicketWorklog(
                ticket_id=shared.id,
                user_id=other.id,
                description="Primeira visita",
                started_at=now - timedelta(days=6),
                ended_at=now - timedelta(days=6, hours=-1),
                minutes=60,
            )
        )
        shift = TechnicianShift(user_id=live.id, started_at=now - timedelta(hours=1))
        db.add(shift)
        await db.flush()
        db.add(
            LocationPing(
                user_id=live.id,
                shift_id=shift.id,
                recorded_at=now - timedelta(minutes=5),
                latitude=FORT_1[0] + 0.009,  # ~1 km ao norte da loja
                longitude=FORT_1[1],
            )
        )
        await db.commit()
        return {
            "fort1": str(fort1.id),
            "no_coords": str(no_coords.id),
            "tech": str(tech.id),
            "other": str(other.id),
            "inactive": str(inactive.id),
            "live": str(live.id),
        }


async def test_regions_from_history_and_filters(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers

    r = await client.post(f"{API}/technicians/regions/refresh", headers=an)
    assert r.status_code == 200, r.text
    counts = r.json()
    assert counts["history"] == 3  # tech, other (apontamento) e o inativo
    assert counts["home"] == 0 and counts["technicians"] == 4

    techs = {t["id"]: t for t in (await client.get(f"{API}/technicians", headers=an)).json()}
    tech = techs[ids["tech"]]
    assert (tech["base_city"], tech["base_state"], tech["base_source"]) == (
        "Fortaleza",
        "CE",
        "history",
    )
    assert tech["base_visits"] == 3 and tech["last_visit_at"] is not None
    assert techs[ids["live"]]["base_source"] is None

    # UF pela base ou pelo endereço; cidade sem acento e sem diferença de maiúsculas.
    in_ce = {
        t["id"]
        for t in (await client.get(f"{API}/technicians", params={"state": "ce"}, headers=an)).json()
    }
    assert in_ce == {ids["tech"], ids["other"]}
    fortaleza = (
        await client.get(
            f"{API}/technicians", params={"state": "CE", "city": "FORTALEZA"}, headers=an
        )
    ).json()
    # Os dois atuam em Fortaleza (o outro pelo apontamento na loja do centro).
    assert {t["id"] for t in fortaleza} == {ids["tech"], ids["other"]}
    sp = (await client.get(f"{API}/technicians", params={"city": "sao  paulo"}, headers=an)).json()
    # O inativo atua em São Paulo; o técnico só "mora" lá (endereço) e também aparece.
    assert {t["id"] for t in sp} == {ids["inactive"], ids["tech"]}

    regions = (await client.get(f"{API}/technicians/regions", headers=an)).json()
    assert [s["state"] for s in regions] == ["CE", "SP"]
    ce = regions[0]
    # O outro técnico mora em Caucaia, mas já atendeu em Fortaleza: a base (histórico) vence.
    assert ce["total"] == 2 and ce["cities"] == [{"city": "Fortaleza", "total": 2}]
    active_only = (
        await client.get(f"{API}/technicians/regions", params={"active": True}, headers=an)
    ).json()
    assert [s["state"] for s in active_only] == ["CE"]

    assert (
        await client.get(f"{API}/technicians/regions", headers=world.tech.headers)
    ).status_code == 403


async def test_list_refreshes_stale_regions(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    # Sem conta nenhuma ainda: a lista calcula sozinha antes de responder.
    techs = {
        t["id"]: t
        for t in (await client.get(f"{API}/technicians", headers=world.analyst.headers)).json()
    }
    assert techs[ids["tech"]]["base_city"] == "Fortaleza"


async def test_nearby_orders_by_history_live_and_home(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers
    r = await client.get(
        f"{API}/technicians/nearby", params={"location_id": ids["fort1"]}, headers=an
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "Loja Aldeota" in body["point"]["label"]
    rows = body["technicians"]
    order = [t["id"] for t in rows]
    assert order == [ids["tech"], ids["live"], ids["other"], ids["inactive"]]

    first = rows[0]
    assert first["nearest_kind"] == "store_history" and first["distance_km"] == 0.0
    assert first["visits_at_location"] == 2 and first["visits_in_city"] == 3
    assert any(reason.startswith("Atendeu esta loja 2x (última em ") for reason in first["reasons"])
    assert "Base em Fortaleza-CE (3 OS)" in first["reasons"]

    live = rows[1]
    assert live["nearest_kind"] == "live" and 0.5 < live["distance_km"] < 1.5
    assert any(reason.startswith("Em jornada agora a 1") for reason in live["reasons"])

    other = rows[2]
    # Já atendeu a outra loja do centro (apontamento), mais perto que a casa em Caucaia.
    assert other["nearest_kind"] == "store_history" and other["distance_km"] < 5
    assert any(reason.startswith("Já atendeu a ") for reason in other["reasons"])
    assert any(reason.startswith("Mora a 14") for reason in other["reasons"])

    assert rows[3]["is_active"] is False and "Inativo no app" in rows[3]["reasons"]

    only_active = (
        await client.get(
            f"{API}/technicians/nearby",
            params={"location_id": ids["fort1"], "include_inactive": False},
            headers=an,
        )
    ).json()["technicians"]
    assert ids["inactive"] not in {t["id"] for t in only_active}
    near = (
        await client.get(
            f"{API}/technicians/nearby",
            params={"location_id": ids["fort1"], "max_km": 50},
            headers=an,
        )
    ).json()["technicians"]
    assert ids["inactive"] not in {t["id"] for t in near} and len(near) == 3
    limited = (
        await client.get(
            f"{API}/technicians/nearby",
            params={"location_id": ids["fort1"], "limit": 1},
            headers=an,
        )
    ).json()["technicians"]
    assert [t["id"] for t in limited] == [ids["tech"]]


async def test_nearby_point_options_and_errors(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers
    r = await client.get(
        f"{API}/technicians/nearby", params={"city": "fortaleza", "state": "ce"}, headers=an
    )
    assert r.status_code == 200, r.text
    point = r.json()["point"]
    assert abs(point["latitude"] - (FORT_1[0] + FORT_2[0]) / 2) < 1e-6
    assert "Fortaleza-CE" in point["label"]

    coords = (
        await client.get(
            f"{API}/technicians/nearby",
            params={"latitude": SAO_PAULO[0], "longitude": SAO_PAULO[1]},
            headers=an,
        )
    ).json()["technicians"]
    assert coords[0]["id"] == ids["inactive"] and coords[0]["visits_at_location"] == 0

    r = await client.get(
        f"{API}/technicians/nearby", params={"city": "Recife", "state": "PE"}, headers=an
    )
    assert r.status_code == 422
    assert "Não há lojas com coordenadas em Recife-PE para calcular a distância" in r.text
    r = await client.get(
        f"{API}/technicians/nearby", params={"location_id": ids["no_coords"]}, headers=an
    )
    assert r.status_code == 422 and "A loja não tem coordenadas" in r.text
    assert (await client.get(f"{API}/technicians/nearby", headers=an)).status_code == 422
    r = await client.get(
        f"{API}/technicians/nearby", params={"location_id": str(uuid.uuid4())}, headers=an
    )
    assert r.status_code == 404
    r = await client.get(
        f"{API}/technicians/nearby",
        params={"location_id": ids["fort1"]},
        headers=world.tech.headers,
    )
    assert r.status_code == 403


def test_placeholder_home_is_ignored(tmp_path: Path) -> None:
    office = {
        "city": "São Paulo",
        "state": "São Paulo",
        "coords": {"latitude": -23.57, "longitude": -46.7},
    }
    employees = [{"id": i, "address": office} for i in range(25)]
    employees.append(
        {
            "id": 99,
            "address": {
                "city": "Fortaleza",
                "state": "Ceará",
                "coords": {"latitude": -3.73, "longitude": -38.52},
            },
        }
    )
    path = tmp_path / "colaboradores.json"
    path.write_text(json.dumps(employees, indent=1), encoding="utf-8")

    placeholders = placeholder_homes(path)
    assert placeholders == {(-23.57, -46.7)}
    cleared = home_of(office, placeholders)
    assert (
        cleared["placeholder"] is True and cleared["city"] is None and cleared["latitude"] is None
    )
    real = home_of(employees[-1]["address"], placeholders)
    assert real == {
        "city": "Fortaleza",
        "state": "CE",
        "latitude": -3.73,
        "longitude": -38.52,
        "placeholder": False,
    }


BRAZIL_CENTER = (-14.2350, -51.9253)


async def _seed_placeholder(engine: AsyncEngine, world: World) -> dict[str, str]:
    """Lojas com o ponto padrão do geocodificador (centro do Brasil) e um shopping com o mesmo
    ponto em duas lojas da mesma UF (esse vale)."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        cust = uuid.UUID(world.customer_id)

        def loc(name: str, city: str, state: str, point: tuple[float, float] | None) -> Location:
            item = Location(
                customer_id=cust,
                name=name,
                city=city,
                state=state,
                latitude=point[0] if point else None,
                longitude=point[1] if point else None,
                is_active=True,
            )
            db.add(item)
            return item

        target = loc("Iguatemi Fortaleza", "Fortaleza", "CE", BRAZIL_CENTER)
        loc("Loja Aldeota", "Fortaleza", "CE", FORT_1)
        loc("Loja Centro", "Fortaleza", "CE", FORT_2)
        far = loc("Loja Jequié", "Jequié", "BA", BRAZIL_CENTER)
        rio_a = loc("Loja Rio A", "Rio de Janeiro", "RJ", (-22.9068, -43.1729))
        rio_b = loc("Loja Recife B", "Recife", "PE", (-22.9068, -43.1729))  # mesmo ponto, outra UF
        mall_a = loc("Shopping Loja 1", "Fortaleza", "CE", (-3.7550, -38.4890))
        mall_b = loc("Shopping Loja 2", "Fortaleza", "CE", (-3.7550, -38.4890))
        zero = loc("Loja Zero", "Natal", "RN", (0.0, 0.0))
        tech = await db.get(User, world.tech.user.id)
        assert tech is not None
        # Único histórico do técnico: uma loja na Bahia com o ponto padrão.
        db.add(
            Ticket(
                title="Visita",
                status=TicketStatus.CLOSED,
                customer_id=cust,
                location_id=far.id,
                assignee_id=tech.id,
                resolved_at=now - timedelta(days=3),
                created_at=now - timedelta(days=3),
                updated_at=now - timedelta(days=3),
            )
        )
        await db.commit()
        return {
            "target": str(target.id),
            "far": str(far.id),
            "rio_a": str(rio_a.id),
            "rio_b": str(rio_b.id),
            "mall_a": str(mall_a.id),
            "mall_b": str(mall_b.id),
            "zero": str(zero.id),
            "tech": str(tech.id),
        }


async def test_cross_state_duplicates_are_cleared(engine: AsyncEngine, world: World) -> None:
    ids = await _seed_placeholder(engine, world)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        found = {str(i) for i in await geo.invalid_location_ids(db)}
        # Centro do Brasil (2 lojas), o mesmo ponto em RJ e PE e o (0,0); o shopping fica.
        assert found == {ids["target"], ids["far"], ids["rio_a"], ids["rio_b"], ids["zero"]}
        assert await geo.clear_invalid_location_coords(db) == 5
        await db.commit()
        mall = await db.get(Location, uuid.UUID(ids["mall_a"]))
        cleared = await db.get(Location, uuid.UUID(ids["rio_a"]))
        assert mall is not None and mall.latitude is not None
        assert cleared is not None and cleared.latitude is None and cleared.longitude is None
        assert await geo.invalid_location_ids(db) == []


def test_coordinate_rules() -> None:
    assert not geo.valid_coords(*BRAZIL_CENTER)
    assert not geo.valid_coords(-14.23500, -51.92528)  # como o geocodificador grava
    assert not geo.valid_coords(0, 0) and not geo.valid_coords(None, -38.5)
    assert geo.valid_coords(*FORT_1)
    pairs = geo.cross_state_pairs(
        [(-22.9068, -43.1729, "RJ"), (-22.90681, -43.17289, "PE"), (*FORT_1, "CE"), (*FORT_1, "CE")]
    )
    assert pairs == {geo.coord_key(-22.9068, -43.1729)}


async def test_store_without_coords_uses_city_centroid_and_no_false_zero_km(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed_placeholder(engine, world)
    an = world.analyst.headers
    # Sem rodar a limpeza: a regra de validade já vale na hora da busca.
    r = await client.get(
        f"{API}/technicians/nearby", params={"location_id": ids["target"]}, headers=an
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["point"]["label"] == (
        "Iguatemi Fortaleza (centro de Fortaleza-CE, a loja não tem coordenadas)"
    )
    # Centro das lojas válidas de Fortaleza (as duas do centro e as duas do shopping).
    expected_lat = (FORT_1[0] + FORT_2[0] + 2 * -3.7550) / 4
    assert abs(body["point"]["latitude"] - expected_lat) < 1e-6
    # O técnico só esteve na Bahia, numa loja com o ponto padrão: não aparece a "0 km".
    assert ids["tech"] not in {t["id"] for t in body["technicians"]}
    assert all(t["distance_km"] > 0 or t["visits_at_location"] for t in body["technicians"])

    # Loja sem coordenada numa cidade sem nenhuma loja válida: aí sim 422.
    r = await client.get(
        f"{API}/technicians/nearby", params={"location_id": ids["far"]}, headers=an
    )
    assert r.status_code == 422
    assert "A loja não tem coordenadas e não há lojas com coordenadas em Jequié-BA" in r.text

    # A região do técnico também não usa o ponto padrão.
    await client.post(f"{API}/technicians/regions/refresh", headers=an)
    techs = {t["id"]: t for t in (await client.get(f"{API}/technicians", headers=an)).json()}
    assert techs[ids["tech"]]["base_source"] is None

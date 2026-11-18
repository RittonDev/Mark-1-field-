"""Em campo agora: uma regra só (services/field.py) para cartões, filas, Atividades do dia e
Início. A caminho ou em atendimento há mais de 12 h é dado parado (esqueceram de concluir ou de
voltar a OS): não conta como em campo, e nas Atividades de hoje sai da lista e vai para o resumo
(stuck_in_field)."""

import uuid
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus
from app.models import Ticket
from app.services import activities, field
from tests.conftest import World, requires_db
from tests.test_api import create, transition

API = settings.API_PREFIX
S = TicketStatus
TZ = ZoneInfo(settings.TIMEZONE)


def test_stuck_rule_boundaries() -> None:
    now = datetime(2026, 11, 17, 20, 0, tzinfo=UTC)
    limit = field.FIELD_STUCK_AFTER
    assert limit == timedelta(hours=12)
    for status in field.FIELD:
        t = SimpleNamespace(status=status)
        assert field.field_stuck(t, now - limit, now) is False  # 12 h exatas: ainda em campo
        assert field.field_stuck(t, now - limit - timedelta(seconds=1), now) is True
        assert field.field_stuck(t, None, now) is False
    for status in (S.ASSIGNED, S.SCHEDULED, S.ON_HOLD_CUSTOMER, S.RESOLVED):
        old = now - timedelta(days=5)
        assert field.field_stuck(SimpleNamespace(status=status), old, now) is False


async def _in_field(client: AsyncClient, world: World, title: str) -> dict:
    """OS do técnico que saiu e começou o atendimento agora."""
    t = await create(client, world, title=title, assignee_id=str(world.tech.user.id))
    t = await transition(client, world.tech.headers, t, "en_route")
    return await transition(client, world.tech.headers, t, "in_progress")


async def _move_events(engine: AsyncEngine, ticket: dict, hours: float) -> None:
    """Leva o histórico da OS `hours` horas para trás (a ida para campo inclusive)."""
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE ticket_events SET created_at = created_at - make_interval(secs => :s) "
                "WHERE ticket_id = :i"
            ),
            {"s": hours * 3600, "i": uuid.UUID(ticket["id"])},
        )


async def _set_events(engine: AsyncEngine, ticket: dict, at: dict[str, datetime]) -> None:
    """Hora de cada mudança de status da OS (to_value → quando); o resto do histórico fica antes."""
    async with engine.begin() as conn:
        first = min(at.values()) - timedelta(hours=1)
        await conn.execute(
            text("UPDATE ticket_events SET created_at = :at WHERE ticket_id = :i"),
            {"at": first, "i": uuid.UUID(ticket["id"])},
        )
        for to_value, when in at.items():
            await conn.execute(
                text(
                    "UPDATE ticket_events SET created_at = :at "
                    "WHERE ticket_id = :i AND event_type = 'status_changed' AND to_value = :to"
                ),
                {"at": when, "i": uuid.UUID(ticket["id"]), "to": to_value},
            )


@requires_db
async def test_field_since_and_the_clauses(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    stuck = await _in_field(client, world, "Esqueceram de concluir")
    await _move_events(engine, stuck, 13)
    moving = await _in_field(client, world, "Em atendimento agora")
    waiting = await create(
        client, world, title="Ainda não saiu", assignee_id=str(world.tech.user.id)
    )
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        # Migrada em atendimento, sem a ida para campo no histórico: vale o início do atendimento.
        imported = Ticket(
            title="Migrada em atendimento",
            status=S.IN_PROGRESS,
            assignee_id=world.tech.user.id,
            work_started_at=datetime.now(UTC) - timedelta(hours=20),
        )
        db.add(imported)
        await db.commit()

    now = datetime.now(UTC)
    ids = {uuid.UUID(t["id"]) for t in (stuck, moving, waiting)} | {imported.id}
    async with maker() as db:
        since = await field.field_since_of(db, ids)
        in_field = set(await db.scalars(select(Ticket.id).where(field.in_field_now_clause(now))))
        parked = set(await db.scalars(select(Ticket.id).where(field.field_stuck_clause(now))))
    assert set(since) == {uuid.UUID(stuck["id"]), uuid.UUID(moving["id"]), imported.id}
    parked_for = now - since[uuid.UUID(stuck["id"])]
    assert timedelta(hours=12, minutes=55) < parked_for < timedelta(hours=14)
    assert now - since[uuid.UUID(moving["id"])] < timedelta(minutes=5)
    assert since[imported.id] == imported.work_started_at
    assert in_field == {uuid.UUID(moving["id"])}
    assert parked == {uuid.UUID(stuck["id"]), imported.id}
    for t in (stuck, moving):
        row = SimpleNamespace(status=S(t["status"]))
        assert field.field_stuck(row, since[uuid.UUID(t["id"])], now) == (t is stuck)


@requires_db
async def test_today_leaves_the_stuck_out_of_the_list(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    # Em atendimento desde ontem (24 h): parada, não "em atendimento".
    stuck = await _in_field(client, world, "Em campo desde ontem")
    await _move_events(engine, stuck, 24)
    moving = await _in_field(client, world, "Em atendimento agora")

    today = (await client.get(f"{API}/activities/day", headers=an)).json()
    assert [a["ticket"]["id"] for a in today["activities"]] == [moving["id"]]
    summary = today["summary"]
    assert (summary["in_progress"], summary["total"], summary["stuck_in_field"]) == (1, 1, 1)
    # Os filtros valem também para o resumo.
    other = (
        await client.get(
            f"{API}/activities/day",
            params={"assignee_id": str(world.tech_other.user.id)},
            headers=an,
        )
    ).json()
    assert other["summary"]["stuck_in_field"] == 0 and other["activities"] == []

    # O dia de ontem continua mostrando o que foi feito nele (o resumo de parada é só de hoje).
    yesterday = (datetime.now(TZ) - timedelta(days=1)).date().isoformat()
    past = (
        await client.get(f"{API}/activities/day", params={"date": yesterday}, headers=an)
    ).json()
    assert stuck["id"] in {a["ticket"]["id"] for a in past["activities"]}
    assert past["summary"]["stuck_in_field"] == 0


@requires_db
async def test_carry_over_inside_12_hours(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Saiu ontem à noite e segue em atendimento de manhã (menos de 12 h): aparece hoje com o início
    real de ontem; quem passou das 12 h fica só no resumo."""
    night = await _in_field(client, world, "Atendimento noturno")
    await _set_events(
        engine,
        night,
        {
            "en_route": datetime(2030, 3, 10, 21, 0, tzinfo=TZ),
            "in_progress": datetime(2030, 3, 10, 22, 0, tzinfo=TZ),
        },
    )
    forgotten = await _in_field(client, world, "Ficou aberta")
    await _set_events(
        engine,
        forgotten,
        {
            "en_route": datetime(2030, 3, 10, 19, 0, tzinfo=TZ),
            "in_progress": datetime(2030, 3, 10, 19, 30, tzinfo=TZ),  # 12 h 30 antes
        },
    )
    morning = datetime(2030, 3, 11, 8, 0, tzinfo=TZ)
    monkeypatch.setattr(activities, "utcnow", lambda: morning.astimezone(UTC))
    monkeypatch.setattr(activities, "local_today", lambda: date(2030, 3, 11))

    day = (await client.get(f"{API}/activities/day", headers=world.analyst.headers)).json()
    assert day["is_today"] is True and day["date"] == "2030-03-11"
    assert [a["ticket"]["id"] for a in day["activities"]] == [night["id"]]
    item = day["activities"][0]
    assert item["state"] == "in_progress"
    assert datetime.fromisoformat(item["started_at"]) == datetime(2030, 3, 10, 22, 0, tzinfo=TZ)
    assert item["arrived_at"] is None  # a chegada não foi hoje
    assert day["summary"]["stuck_in_field"] == 1

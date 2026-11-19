"""Perfil do técnico: Estatísticas (GET /me/stats e GET /technicians/{id}/stats) e Histórico de
atendimentos (GET /me/history); services/technician_levels.py (stats, attended_clause) e
services/my_history.py.

Atendimento é o do elo sem a janela de 12 meses: OS resolvida ou fechada, com conclusão e visita
(chegada registrada ou OS do Field Control), em que o técnico é hoje o responsável ou vai junto.
O total das Estatísticas e a lista do Histórico usam o mesmo predicado e sempre batem. Tudo só
leitura: nada é gravado.

Dados fictícios: Tecnico Alfa e Tecnico Bravo (@exemplo.com), Loja Exemplo em Cidade Exemplo.
"""

import base64
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import (
    LevelOccurrenceKind,
    LevelTier,
    Responsibility,
    TicketEventType,
    TicketStatus,
    UserRole,
)
from app.core.security import create_access_token
from app.db.base import utcnow
from app.models import (
    Location,
    ServiceType,
    Ticket,
    TicketEvent,
    TicketPayout,
    UnproductiveReason,
    User,
    UserChange,
)
from app.models.technician_level import TechnicianLevel, TechnicianLevelWaiver
from app.models.ticket import ticket_helpers
from app.schemas.ticket import format_ticket_code
from app.services import my_history
from app.services import technician_levels as levels
from app.services.tickets import acted_by_clause
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
FC = {"source": "fieldcontrol"}
# O "agora" fixo das contas por mês: 19/11/2026 às 12:00 em Brasília.
NOW = datetime(2026, 11, 19, 15, tzinfo=UTC)
FORBIDDEN = {"detail": "Sem permissão para esta ação"}
CURSOR_ERROR = {"detail": "Página do histórico inválida. Puxe a lista para recarregar."}
STATS_KEYS = {"computed_at", "lifetime", "metrics", "months"}
MONTH_KEYS = {
    "month",
    "current",
    "services",
    "as_assignee",
    "as_helper",
    "legacy",
    "legacy_only",
    "measured",
    "arrivals",
    "late",
    "reworks",
    "lost",
}
ITEM_KEYS = {
    "id",
    "code",
    "service",
    "location_code",
    "location_name",
    "city",
    "state",
    "resolved_at",
    "month",
    "role",
    "legacy",
}


@pytest.fixture
def brasilia(monkeypatch: pytest.MonkeyPatch) -> ZoneInfo:
    """Meses no fuso da operação."""
    monkeypatch.setattr(settings, "TIMEZONE", "America/Sao_Paulo")
    return ZoneInfo("America/Sao_Paulo")


# ------------------------------------------------------------------ ajudantes
# _tech, _headers, _done e _status_event são cópias dos de test_technician_levels.py.


def _tech(name: str) -> User:
    return User(
        name=f"Tecnico {name}",
        email=f"tecnico.{name.lower()}@exemplo.com",
        password_hash="x",
        role=UserRole.TECHNICIAN,
        is_active=True,
    )


def _headers(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.role.value)}"}


def _done(
    world: World,
    assignee: User | None,
    *,
    now: datetime,
    days_ago: float = 10,
    status: TicketStatus = TicketStatus.CLOSED,
    scheduled: datetime | None = None,
    arrived: datetime | None = None,
    visited: bool = True,
    legacy: dict | None = None,
    title: str = "Visita na Loja Exemplo",
) -> Ticket:
    """OS concluída `days_ago` dias atrás (chegada uma hora antes, sem `arrived` nem `visited`)."""
    at = now - timedelta(days=days_ago)
    if arrived is None and visited:
        arrived = at - timedelta(hours=1)
    ticket = Ticket(
        title=title,
        status=status,
        customer_id=uuid.UUID(world.customer_id),
        location_id=uuid.UUID(world.location_id),
        assignee_id=assignee.id if assignee else None,
        scheduled_start=scheduled,
        arrived_at=arrived,
        resolved_at=at,
        closed_at=at if status == TicketStatus.CLOSED else None,
        created_at=at - timedelta(days=1),
        updated_at=at,
    )
    if legacy is not None:
        # Só a OS migrada leva o campo: na OS daqui ele fica NULL no banco (como na abertura).
        ticket.legacy = legacy
    return ticket


def _status_event(
    ticket: Ticket,
    actor: User | None,
    *,
    to: str,
    at: datetime,
    frm: str | None = None,
    note: str | None = None,
    data: dict | None = None,
) -> TicketEvent:
    return TicketEvent(
        ticket_id=ticket.id,
        actor_id=actor.id if actor else None,
        event_type=TicketEventType.STATUS_CHANGED,
        from_value=frm,
        to_value=to,
        note=note,
        data=data,
        created_at=at,
    )


def _utc(year: int, month: int, day: int, hour: int = 15, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


def _resolved(world: World, assignee: User | None, at: datetime, **extra: object) -> Ticket:
    """OS concluída no instante `at` (a chegada uma hora antes, como em _done)."""
    return _done(world, assignee, now=at, days_ago=0, **extra)  # type: ignore[arg-type]


def _numbers(body: dict) -> dict:
    """O que não depende da hora do pedido: o total, os meses e os números do elo sem a janela."""
    metrics = {k: v for k, v in body["metrics"].items() if not k.startswith("window_")}
    return {"lifetime": body["lifetime"], "months": body["months"], "metrics": metrics}


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


# ------------------------------------------------------------------ estatísticas


async def test_stats_lifetime_and_months(engine: AsyncEngine, world: World, brasilia: ZoneInfo) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        alfa, bravo = _tech("Alfa"), _tech("Bravo")
        db.add_all([alfa, bravo])
        await db.flush()
        sched = _utc(2026, 11, 18, 12)
        on_time = _resolved(
            world, alfa, _utc(2026, 11, 18, 14), scheduled=sched, arrived=sched + timedelta(minutes=10)
        )
        late_sched = _utc(2026, 9, 15, 12)
        late = _resolved(
            world,
            alfa,
            _utc(2026, 9, 15, 18),
            scheduled=late_sched,
            arrived=late_sched + timedelta(minutes=45),
        )
        fc_a = _resolved(world, alfa, _utc(2026, 6, 10), visited=False, legacy=FC)
        fc_b = _resolved(world, alfa, _utc(2026, 6, 20), visited=False, legacy=FC)
        fc_old = _resolved(world, alfa, _utc(2025, 3, 10), visited=False, legacy=FC)
        together = _resolved(world, bravo, _utc(2026, 10, 10))  # Alfa vai junto
        # Fora da conta: cancelada, sem chegada, reaberta e uma só de Bravo.
        cancelled = _resolved(world, alfa, _utc(2026, 11, 2), status=TicketStatus.CANCELLED)
        no_arrival = _resolved(world, alfa, _utc(2026, 11, 3), visited=False)
        reopened = _resolved(world, alfa, _utc(2026, 11, 4), status=TicketStatus.REOPENED)
        bravo_alone = _resolved(world, bravo, _utc(2026, 11, 5))
        db.add_all(
            [
                on_time,
                late,
                fc_a,
                fc_b,
                fc_old,
                together,
                cancelled,
                no_arrival,
                reopened,
                bravo_alone,
            ]
        )
        await db.flush()
        await db.execute(ticket_helpers.insert().values(ticket_id=together.id, user_id=alfa.id))
        await db.commit()

    async with maker() as db:
        out = await levels.stats(db, alfa.id, NOW)
        collected = await levels.collect(db, NOW, alfa.id)
        other = await levels.stats(db, bravo.id, NOW)

    assert out.computed_at == NOW
    assert out.lifetime.model_dump() == {
        "services": 6,
        "as_assignee": 5,
        "as_helper": 1,
        "legacy": 3,
        "first_month": "2025-03",  # 20 meses antes de novembro de 2026
    }
    assert [m.month for m in out.months] == levels.last_months(NOW)
    assert (out.months[0].month, out.months[-1].month) == ("2025-12", "2026-11")
    assert [m.current for m in out.months] == [False] * 11 + [True]
    months = {m.month: m for m in out.months}
    nov = months["2026-11"]
    assert (nov.services, nov.as_assignee, nov.measured, nov.arrivals, nov.late) == (1, 1, 1, 1, 0)
    assert (nov.legacy, nov.legacy_only) == (0, False)
    # Há 5 meses, só do Field Control: a qualidade não é medida.
    jun = months["2026-06"]
    assert (jun.services, jun.as_assignee, jun.legacy, jun.legacy_only) == (2, 2, 2, True)
    assert (jun.measured, jun.arrivals, jun.late, jun.reworks, jun.lost) == (0, 0, 0, 0, 0)
    # Há 2 meses, a atrasada (45 min).
    sep = months["2026-09"]
    assert (sep.services, sep.late, sep.arrivals, sep.measured, sep.legacy_only) == (
        1,
        1,
        1,
        1,
        False,
    )
    # Há 1 mês, junto com Bravo: atendimento dele também, sem medir.
    octo = months["2026-10"]
    assert (octo.services, octo.as_assignee, octo.as_helper, octo.measured) == (1, 0, 1, 0)
    busy = {"2026-11", "2026-10", "2026-09", "2026-06"}
    for key, month in months.items():
        if key not in busy:
            assert month.model_dump() == {
                **dict.fromkeys(MONTH_KEYS - {"month", "current", "legacy_only"}, 0),
                "month": key,
                "current": False,
                "legacy_only": False,
            }
    # A mesma conta de Meu elo (365 dias corridos: a do Field Control de 2025 fica de fora).
    snapshot = levels.Snapshot(
        user_id=alfa.id,
        standing=levels.Standing(LevelTier.BRONZE, NOW, None),
        computed=LevelTier.BRONZE,
        computed_at=NOW,
        window_start=collected.window_start,
        counts=collected.counts[alfa.id],
        occurrences=[],
    )
    assert out.metrics == levels._metrics(snapshot)
    assert (out.metrics.window_start, out.metrics.window_end) == (NOW - levels.WINDOW, NOW)
    assert (out.metrics.services, out.metrics.as_helper, out.metrics.late) == (5, 1, 1)
    # A OS em que os dois foram conta para os dois.
    assert other.lifetime.model_dump() == {
        "services": 2,
        "as_assignee": 2,
        "as_helper": 0,
        "legacy": 0,
        "first_month": "2026-10",
    }


async def test_stats_events_by_month(engine: AsyncEngine, world: World, brasilia: ZoneInfo) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    analyst = world.analyst.user
    async with maker() as db:
        alfa = _tech("Alfa")
        fault = UnproductiveReason(
            name="Atraso do técnico", responsibility=Responsibility.TECHNICIAN, is_active=True
        )
        db.add_all([alfa, fault])
        await db.flush()
        # Concluída em agosto, reaberta em setembro e concluída de novo em outubro.
        rework = _resolved(world, alfa, _utc(2026, 10, 5))
        # Visita perdida em julho; a OS foi concluída em agosto.
        lost = _resolved(world, alfa, _utc(2026, 8, 15))
        # Chegou em 30/04 às 17:00 em Brasília (2 h depois do combinado) e concluiu em 02/05.
        late_sched = _utc(2026, 4, 30, 18)
        late = _resolved(
            world, alfa, _utc(2026, 5, 2), scheduled=late_sched, arrived=late_sched + timedelta(hours=2)
        )
        # Atraso de junho que a central desconsiderou.
        waived_sched = _utc(2026, 6, 15, 12)
        waived = _resolved(
            world,
            alfa,
            _utc(2026, 6, 15, 18),
            scheduled=waived_sched,
            arrived=waived_sched + timedelta(minutes=50),
        )
        db.add_all([rework, lost, late, waived])
        await db.flush()
        db.add_all(
            [
                _status_event(rework, alfa, to="resolved", frm="in_progress", at=_utc(2026, 8, 28)),
                _status_event(
                    rework,
                    analyst,
                    to="reopened",
                    frm="resolved",
                    at=_utc(2026, 9, 3),
                    note="Cliente ligou de novo",
                    data={"technician_id": str(alfa.id)},
                ),
                TicketEvent(
                    ticket_id=lost.id,
                    actor_id=alfa.id,
                    event_type=TicketEventType.UNPRODUCTIVE_VISIT,
                    data={"reason_id": str(fault.id), "technician_id": str(alfa.id)},
                    created_at=_utc(2026, 7, 10),
                ),
                TechnicianLevelWaiver(
                    technician_id=alfa.id,
                    kind=LevelOccurrenceKind.LATE,
                    ticket_id=waived.id,
                    ref_id=waived.id,
                    note="Agenda trocada pela central",
                    created_by_id=analyst.id,
                    created_at=_utc(2026, 6, 16),
                ),
            ]
        )
        await db.commit()

    async with maker() as db:
        out = await levels.stats(db, alfa.id, NOW)
    m = {x.month: x for x in out.months}
    # O retorno cai no mês da reabertura; o atendimento, no da última conclusão.
    assert (m["2026-08"].reworks, m["2026-09"].reworks, m["2026-10"].reworks) == (0, 1, 0)
    assert (m["2026-09"].services, m["2026-10"].services) == (0, 1)
    # A visita perdida cai no mês da visita; a conclusão da OS conta em agosto.
    assert (m["2026-07"].lost, m["2026-08"].lost) == (1, 0)
    assert (m["2026-07"].services, m["2026-08"].services) == (0, 1)
    # A chegada fora do horário cai no mês da chegada; o atendimento e a chegada medida, no da
    # conclusão.
    assert (m["2026-04"].late, m["2026-05"].late) == (1, 0)
    assert (m["2026-04"].arrivals, m["2026-05"].arrivals, m["2026-05"].measured) == (0, 1, 1)
    # O atraso desconsiderado não conta (a chegada, sim).
    assert (m["2026-06"].late, m["2026-06"].arrivals) == (0, 1)
    # Tudo dentro dos 12 meses: a soma das barras é a conta do elo.
    metrics = out.metrics
    assert sum(x.late for x in out.months) == metrics.late == 1
    assert sum(x.reworks for x in out.months) == metrics.reworks == 1
    assert sum(x.lost for x in out.months) == metrics.lost == 1


async def test_stats_month_timezone(
    engine: AsyncEngine, client: AsyncClient, world: World, brasilia: ZoneInfo
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        alfa = _tech("Alfa")
        db.add(alfa)
        await db.flush()
        # 31/10 às 23:30 em Brasília (01/11 em UTC) e 01/11 às 00:30.
        october = _resolved(world, alfa, datetime(2026, 11, 1, 2, 30, tzinfo=UTC))
        november = _resolved(world, alfa, datetime(2026, 11, 1, 3, 30, tzinfo=UTC))
        db.add_all([october, november])
        await db.commit()

    async with maker() as db:
        out = await levels.stats(db, alfa.id, NOW)
    m = {x.month: x for x in out.months}
    assert (m["2026-10"].services, m["2026-11"].services) == (1, 1)
    assert out.lifetime.first_month == "2026-10"
    # O histórico usa o mesmo mês (as seções da lista).
    r = await client.get(f"{API}/me/history", headers=_headers(alfa))
    assert r.status_code == 200, r.text
    body = r.json()
    assert {i["id"]: i["month"] for i in body["items"]} == {
        str(october.id): "2026-10",
        str(november.id): "2026-11",
    }
    assert body["months"] == [{"month": "2026-11", "count": 1}, {"month": "2026-10", "count": 1}]

    # Sem banco: o mês de um instante e os 12 meses de calendário até o de agora.
    assert levels.local_month(datetime(2026, 11, 1, 2, 30, tzinfo=UTC)) == "2026-10"
    assert levels.last_months(datetime(2026, 1, 15, 15, tzinfo=UTC)) == [
        *(f"2025-{month:02d}" for month in range(2, 13)),
        "2026-01",
    ]
    # 01/12 às 01:00 em UTC ainda é novembro em Brasília.
    assert levels.last_months(datetime(2026, 12, 1, 1, tzinfo=UTC), 3) == [
        "2026-09",
        "2026-10",
        "2026-11",
    ]


async def test_stats_read_only(engine: AsyncEngine, client: AsyncClient, world: World) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        alfa = _tech("Alfa")
        db.add(alfa)
        await db.flush()
        ticket = _done(world, alfa, now=now, days_ago=3)
        db.add(ticket)
        await db.flush()
        db.add(_status_event(ticket, alfa, to="resolved", frm="in_progress", at=now - timedelta(3)))
        await db.commit()

    async def tally() -> tuple[int | None, int | None, int | None]:
        async with maker() as db:
            return (
                await db.scalar(select(func.count()).select_from(TechnicianLevel)),
                await db.scalar(select(func.count()).select_from(UserChange)),
                await db.scalar(select(func.count()).select_from(TicketEvent)),
            )

    before = await tally()
    assert before[0] == 0
    for path, headers in (
        (f"{API}/me/stats", _headers(alfa)),
        (f"{API}/me/history", _headers(alfa)),
        (f"{API}/technicians/{alfa.id}/stats", world.analyst.headers),
    ):
        r = await client.get(path, headers=headers)
        assert r.status_code == 200, (path, r.text)
    assert r.json()["lifetime"]["services"] == 1
    # Nem o elo é gravado (sem refresh_one), nem histórico de cadastro ou da OS.
    assert await tally() == before
    async with maker() as db:
        assert await db.get(TechnicianLevel, alfa.id) is None


async def test_stats_routes_and_guards(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        alfa = _tech("Alfa")
        own = User(
            name="Analista Fila Propria",
            email="analista.fila.propria@exemplo.com",
            password_hash="x",
            role=UserRole.ANALYST,
            is_active=True,
            access_overrides={"queue_scope": "own", "queue_unowned": False},
        )
        blind = User(
            name="Analista Sem Tecnicos",
            email="analista.sem.tecnicos@exemplo.com",
            password_hash="x",
            role=UserRole.ANALYST,
            is_active=True,
            access_overrides={"items": {"base.technicians": "none"}},
        )
        db.add_all([alfa, own, blind])
        await db.flush()
        # OS da fila de outro analista: quem vê só a própria fila não a abriria.
        queued = _done(world, alfa, now=now, days_ago=2)
        queued.owner_id = world.analyst.user.id
        fc = _done(world, alfa, now=now, days_ago=40, visited=False, legacy=FC)
        db.add_all([queued, fc])
        await db.commit()

    r = await client.get(f"{API}/me/stats", headers=_headers(alfa))
    assert r.status_code == 200, r.text
    mine = r.json()
    assert set(mine) == STATS_KEYS
    assert mine["lifetime"]["services"] == 2 and mine["lifetime"]["legacy"] == 1
    assert len(mine["months"]) == 12 and all(set(m) == MONTH_KEYS for m in mine["months"])
    for headers in (world.analyst.headers, world.requester.headers, world.admin.headers):
        r = await client.get(f"{API}/me/stats", headers=headers)
        assert (r.status_code, r.json()) == (403, FORBIDDEN)
    assert (await client.get(f"{API}/me/stats")).status_code == 401

    url = f"{API}/technicians/{alfa.id}/stats"
    r = await client.get(url, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    central = r.json()
    assert set(central) == STATS_KEYS | {"technician"}
    assert central["technician"] == {"id": str(alfa.id), "name": "Tecnico Alfa"}
    assert _numbers(central) == _numbers(mine)
    for missing in (world.analyst.user.id, uuid.uuid4()):
        r = await client.get(f"{API}/technicians/{missing}/stats", headers=world.analyst.headers)
        assert (r.status_code, r.json()["detail"]) == (404, "Técnico não encontrado")
    # Sem a tela Técnicos.
    r = await client.get(url, headers=_headers(blind))
    assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN", r.text
    # Técnico (o próprio ou outro) e cliente não usam a rota da central.
    for headers in (_headers(alfa), world.tech.headers, world.requester.headers):
        r = await client.get(url, headers=headers)
        assert (r.status_code, r.json()) == (403, FORBIDDEN)
    # "Somente a própria fila": os mesmos números do administrador (só contagens, sem OS).
    admin = (await client.get(url, headers=world.admin.headers)).json()
    r = await client.get(url, headers=_headers(own))
    assert r.status_code == 200, r.text
    assert _numbers(r.json()) == _numbers(admin) == _numbers(mine)


# ------------------------------------------------------------------ histórico


async def test_history_cut_and_order(
    engine: AsyncEngine, client: AsyncClient, world: World, brasilia: ZoneInfo
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        alfa, bravo = _tech("Alfa"), _tech("Bravo")
        store = Location(
            customer_id=uuid.UUID(world.customer_id),
            name="Loja Exemplo",
            code="0123",
            city="Cidade Exemplo",
            state="SP",
            address_line="Rua Reservada, 100",
            district="Bairro Reservado",
            zip_code="01000-000",
            contact_name="Contato Reservado",
            contact_phone="11 90000-0000",
            is_active=True,
        )
        service = ServiceType(name="Manutenção preventiva", estimated_minutes=60)
        db.add_all([alfa, bravo, store, service])
        await db.flush()

        def at_store(ticket: Ticket, *, typed: bool = True) -> Ticket:
            ticket.location_id = store.id
            ticket.service_type_id = service.id if typed else None
            ticket.description = "Descricao reservada da central"
            ticket.requester_name = "Solicitante Reservado"
            ticket.requester_contact = "solicitante@exemplo.com"
            ticket.service_address = "Rua Reservada, 100"
            ticket.tags = [{"name": "Etiqueta Reservada", "color": None}]
            return ticket

        same = _utc(2026, 11, 10)
        twin_a = at_store(_resolved(world, alfa, same))
        twin_b = at_store(_resolved(world, alfa, same))
        untyped = at_store(
            _resolved(world, alfa, _utc(2026, 11, 12), title="Troca de cabo do PDV"), typed=False
        )
        along = at_store(_resolved(world, bravo, _utc(2026, 11, 8)))  # Alfa vai junto
        migrated = at_store(_resolved(world, alfa, _utc(2026, 11, 6), visited=False, legacy=FC))
        # 31/10 às 23:30 em Brasília.
        boundary = at_store(_resolved(world, alfa, datetime(2026, 11, 1, 2, 30, tzinfo=UTC)))
        db.add_all([twin_a, twin_b, untyped, along, migrated, boundary])
        await db.flush()
        await db.execute(ticket_helpers.insert().values(ticket_id=along.id, user_id=alfa.id))
        db.add(TicketPayout(ticket_id=twin_a.id, technician_id=alfa.id, amount=Decimal("137.50")))
        await db.commit()

    r = await client.get(f"{API}/me/history", headers=_headers(alfa))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"items", "next_cursor", "total", "months"}
    items = body["items"]
    for item in items:
        assert set(item) == ITEM_KEYS, item
    # resolved_at desc; com a mesma data, id desc.
    twins = sorted([twin_a.id, twin_b.id], reverse=True)
    expected = [untyped.id, *twins, along.id, migrated.id, boundary.id]
    assert [i["id"] for i in items] == [str(x) for x in expected]
    by_id = {i["id"]: i for i in items}
    first = by_id[str(twin_a.id)]
    assert datetime.fromisoformat(first.pop("resolved_at")) == same
    assert first == {
        "id": str(twin_a.id),
        "code": format_ticket_code(twin_a.number),
        "service": "Manutenção preventiva",
        "location_code": "0123",
        "location_name": "Loja Exemplo",
        "city": "Cidade Exemplo",
        "state": "SP",
        "month": "2026-11",
        "role": "assignee",
        "legacy": False,
    }
    # Sem tipo de serviço, o título da OS.
    assert by_id[str(untyped.id)]["service"] == "Troca de cabo do PDV"
    assert by_id[str(along.id)]["role"] == "helper"
    assert by_id[str(migrated.id)]["legacy"] is True
    # O mês da conclusão no fuso da operação.
    assert by_id[str(boundary.id)]["month"] == "2026-10"
    assert (body["total"], body["next_cursor"]) == (6, None)
    assert body["months"] == [{"month": "2026-11", "count": 5}, {"month": "2026-10", "count": 1}]
    # Só o recorte de campo.
    for secret in (
        "customer",
        "address",
        "contact",
        "tags",
        "amount",
        "description",
        "priority",
        "due_at",
        "Cliente Teste",
        "Reservad",
        "90000-0000",
        "solicitante@exemplo.com",
        "137.5",
        "Tecnico Bravo",
        str(bravo.id),
    ):
        assert secret not in r.text, secret


async def test_history_pages(
    engine: AsyncEngine, client: AsyncClient, world: World, brasilia: ZoneInfo
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    base = _utc(2026, 11, 10)
    async with maker() as db:
        alfa = _tech("Alfa")
        db.add(alfa)
        await db.flush()
        # 10 em novembro (de 10/11 a 01/11) e 25 em outubro (de 31/10 a 07/10).
        tickets = [_resolved(world, alfa, base - timedelta(days=i)) for i in range(35)]
        db.add_all(tickets)
        await db.commit()
    expected = [str(t.id) for t in tickets]
    th = _headers(alfa)
    url = f"{API}/me/history"

    r = await client.get(url, params={"limit": 30}, headers=th)
    assert r.status_code == 200, r.text
    first = r.json()
    assert [i["id"] for i in first["items"]] == expected[:30]
    assert first["total"] == 35 and first["next_cursor"]
    # Outubro fica partido entre as páginas: vem o total do mês inteiro.
    assert first["months"] == [{"month": "2026-11", "count": 10}, {"month": "2026-10", "count": 25}]

    # Uma OS concluída agora, entre as duas chamadas: não aparece nem empurra a página 2.
    async with maker() as db:
        fresh = _done(world, alfa, now=utcnow(), days_ago=0)
        db.add(fresh)
        await db.commit()
    r = await client.get(url, params={"limit": 30, "cursor": first["next_cursor"]}, headers=th)
    assert r.status_code == 200, r.text
    second = r.json()
    assert [i["id"] for i in second["items"]] == expected[30:]
    assert (second["next_cursor"], second["total"]) == (None, None)
    assert second["months"] == [{"month": "2026-10", "count": 25}]
    seen = [i["id"] for i in first["items"] + second["items"]]
    assert len(seen) == len(set(seen)) == 35
    assert str(fresh.id) not in seen

    # Recomeçando (30 por página por padrão), a nova vem primeiro e o total sobe.
    again = (await client.get(url, headers=th)).json()
    assert len(again["items"]) == 30 and again["items"][0]["id"] == str(fresh.id)
    assert again["total"] == 36


async def test_history_membership_matches_stats(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        alfa, bravo = _tech("Alfa"), _tech("Bravo")
        db.add_all([alfa, bravo])
        await db.flush()
        own = _done(world, alfa, now=now, days_ago=3)
        along = _done(world, bravo, now=now, days_ago=4)  # Alfa vai junto
        migrated = _done(world, alfa, now=now, days_ago=500, visited=False, legacy=FC)
        swapped = _done(world, bravo, now=now, days_ago=5)  # Alfa era o responsável antes
        cancelled = _done(world, alfa, now=now, days_ago=6, status=TicketStatus.CANCELLED)
        reopened = _done(world, alfa, now=now, days_ago=7, status=TicketStatus.REOPENED)
        no_arrival = _done(world, alfa, now=now, days_ago=8, visited=False)
        db.add_all([own, along, migrated, swapped, cancelled, reopened, no_arrival])
        await db.flush()
        await db.execute(ticket_helpers.insert().values(ticket_id=along.id, user_id=alfa.id))
        db.add(
            TicketEvent(
                ticket_id=swapped.id,
                actor_id=world.analyst.user.id,
                event_type=TicketEventType.ASSIGNED,
                from_value=str(alfa.id),
                to_value=str(bravo.id),
                created_at=now - timedelta(days=6),
            )
        )
        await db.commit()

    th = _headers(alfa)
    r = await client.get(f"{API}/me/history", headers=th)
    assert r.status_code == 200, r.text
    history = r.json()
    assert {i["id"] for i in history["items"]} == {str(own.id), str(along.id), str(migrated.id)}
    stats = (await client.get(f"{API}/me/stats", headers=th)).json()
    assert history["total"] == stats["lifetime"]["services"] == 3
    # A busca "técnico que atuou" da central continua com a OS de antes da troca.
    async with maker() as db:
        acted = set(await db.scalars(select(Ticket.id).where(acted_by_clause(alfa.id))))
    assert swapped.id in acted and str(swapped.id) not in {i["id"] for i in history["items"]}


async def test_history_errors(engine: AsyncEngine, client: AsyncClient, world: World) -> None:
    # O cursor vai e volta: base64url sem "=" de "{resolved_at ISO com fuso}|{id}".
    at = datetime(2026, 11, 18, 19, 40, 0, 123456, tzinfo=UTC)
    ticket_id = uuid.uuid4()
    cursor = my_history.encode_cursor(at, ticket_id)
    assert "=" not in cursor and len(cursor) <= my_history.CURSOR_MAX
    assert cursor == _b64(f"{at.isoformat()}|{ticket_id}")
    assert my_history.decode_cursor(cursor) == (at, ticket_id)

    th, url = world.tech.headers, f"{API}/me/history"
    for wrong in (
        "abc",
        "abcde",
        "çã",
        _b64("sem separador"),
        _b64(f"2026-11-18T19:40:00|{ticket_id}"),  # sem fuso
        _b64("2026-11-18T19:40:00+00:00|nao-e-id"),
        _b64(f"ontem|{ticket_id}"),
        _b64(f"2026-11-18T19:40:00+00:00|{ticket_id}|extra"),
    ):
        r = await client.get(url, params={"cursor": wrong}, headers=th)
        assert (r.status_code, r.json()) == (422, CURSOR_ERROR), wrong
    r = await client.get(url, params={"cursor": cursor}, headers=th)
    assert r.status_code == 200, r.text
    assert r.json() == {"items": [], "next_cursor": None, "total": None, "months": []}
    r = await client.get(url, params={"cursor": "a" * 201}, headers=th)
    assert r.status_code == 422 and isinstance(r.json()["detail"], list), r.text

    for limit, msg in ((0, "Deve ser no mínimo 1"), (51, "Deve ser no máximo 50")):
        r = await client.get(url, params={"limit": limit}, headers=th)
        assert r.status_code == 422, r.text
        assert r.json()["detail"][0]["msg"] == msg
    r = await client.get(url, params={"limit": 50}, headers=th)
    assert r.status_code == 200, r.text
    assert r.json() == {"items": [], "next_cursor": None, "total": 0, "months": []}

    for headers in (world.analyst.headers, world.requester.headers, world.admin.headers):
        r = await client.get(url, headers=headers)
        assert (r.status_code, r.json()) == (403, FORBIDDEN)
    assert (await client.get(url)).status_code == 401

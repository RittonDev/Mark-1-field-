"""Tela inicial: o número do topo (focus) e os sinais vitais da operação (pulse).

"Agora" fixo da tela inicial: 17/11/2026 15:00 em São Paulo (terça-feira). A janela de 30 dias
começa em 19/10 e as 8 semanas, na segunda-feira 28/09. Só nomes inventados.
"""

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    ExpenseKind,
    ExpenseStatus,
    PayoutStatus,
    QuoteStatus,
    TicketEventType,
    TicketType,
)
from app.db.base import utcnow
from app.models import (
    Customer,
    Location,
    Quote,
    TicketEvent,
    TicketExpense,
    TicketPayout,
    User,
)
from app.services import home
from app.services.activities import local_today
from tests.conftest import World, requires_db
from tests.test_home_search import (  # noqa: F401 (fixtures db e frozen)
    API,
    NOW,
    TODAY,
    S,
    add_ticket,
    at,
    db,
    frozen,
    groups,
    overview,
)

pytestmark = pytest.mark.usefixtures("frozen")

WINDOW_FROM = "2026-10-19"
NOT_STARTED = ["new", "triage", "assigned", "scheduled", "reopened"]
WEEK_STARTS = [
    "2026-09-28",
    "2026-10-05",
    "2026-10-12",
    "2026-10-19",
    "2026-10-26",
    "2026-11-02",
    "2026-11-09",
    "2026-11-16",
]
ZERO = {"count": 0, "base": 0}
OLDEST_FIRST = {"order_by": "created_at"}


def ago(**delta: float) -> datetime:
    return NOW - timedelta(**delta)


async def list_total(client: AsyncClient, world: World, filters: dict) -> int:
    """Total de GET /tickets com o filtro que a tela devolveu, como a web monta a URL (listas
    repetidas e sim/não como "true")."""
    params: list[tuple[str, str]] = [("page_size", "1")]
    for key, value in filters.items():
        for item in value if isinstance(value, list) else [value]:
            params.append((key, "true" if item is True else str(item)))
    r = await client.get(f"{API}/tickets", params=params, headers=world.supervisor.headers)
    assert r.status_code == 200, r.text
    return r.json()["total"]


@requires_db
async def test_pulse_without_data(client: AsyncClient, world: World) -> None:
    data = await overview(client, world)
    assert data["focus"] == {"total": 0, "next_visit_at": None}
    # Os indicadores de antes continuam iguais (as mesmas 6 chaves).
    assert set(data["kpis"]) == {
        "open",
        "scheduled_today",
        "in_field_now",
        "resolved_today",
        "late",
        "unassigned",
    }
    pulse = data["pulse"]
    assert pulse["window_from"] == WINDOW_FROM
    assert pulse["today"] == {
        "planned": 0,
        "done": 0,
        "in_field": 0,
        "not_started": 0,
        "on_hold": 0,
        "upcoming": 0,
        "unassigned": 0,
        "unassigned_filters": {
            "unassigned": True,
            "open_only": True,
            "scheduled_from": "2026-11-17",
            "scheduled_to": "2026-11-17",
        },
        "technicians": 0,
        "resolved": 0,
    }
    assert pulse["tomorrow"] == {
        "day": "2026-11-18",
        "planned": 0,
        "technicians": 0,
        "unassigned": 0,
        "unassigned_filters": {
            "unassigned": True,
            "open_only": True,
            "scheduled_from": "2026-11-18",
            "scheduled_to": "2026-11-18",
        },
    }
    assert pulse["backlog"] == {
        "open": 0,
        "recent": 0,
        "old": 0,
        "median_age_days": None,
        "ages": [
            {
                "key": "d7",
                "count": 0,
                "filters": {"open_only": True, "created_from": "2026-11-11", **OLDEST_FIRST},
            },
            {
                "key": "d30",
                "count": 0,
                "filters": {
                    "open_only": True,
                    "created_from": "2026-10-19",
                    "created_to": "2026-11-10",
                    **OLDEST_FIRST,
                },
            },
            {
                "key": "d90",
                "count": 0,
                "filters": {
                    "open_only": True,
                    "created_from": "2026-08-20",
                    "created_to": "2026-10-18",
                    **OLDEST_FIRST,
                },
            },
            {
                "key": "older",
                "count": 0,
                "filters": {"open_only": True, "created_to": "2026-08-19", **OLDEST_FIRST},
            },
        ],
        "entered_30d": 0,
        "resolved_30d": 0,
        "cancelled_30d": 0,
        "old_reasons": [],
        "old_filters": {"open_only": True, "created_to": "2026-10-18", **OLDEST_FIRST},
    }
    assert pulse["quality"] == {
        "on_time": ZERO,
        "resolution_sla": ZERO,
        "resolution_sla_imported": 0,
        "store_return": ZERO,
        "return_days": 7,
        "unproductive": 0,
        "visits": 0,
    }
    assert pulse["team"] == {
        "worked": 0,
        "resolved": 0,
        "top3_resolved": 0,
        "in_app": 0,
        "onsite_median_minutes": None,
        "onsite_over": ZERO,
        "onsite_limit_hours": 4,
    }
    assert pulse["customers"] == {"active": 0, "entered": 0, "top": []}
    finance = pulse["finance"]
    money = (
        "payouts_to_pay",
        "payouts_expected",
        "quotes_waiting_total",
        "quotes_approved_month_total",
        "costs_pending_total",
    )
    # Sem lançamento o valor é o número 0; quem diz "sem valores" é a contagem (também 0).
    assert all(finance[key] == 0 and isinstance(finance[key], float) for key in money)
    counts = ("payouts_to_pay_count", "quotes_waiting", "quotes_approved_month", "costs_pending")
    assert all(finance[key] == 0 for key in counts)
    assert finance["payout_tag"] == "Pendente Envio PGTO"
    assert finance["payout_tag_filters"] == {
        "status": ["resolved", "closed"],
        "tag": ["Pendente Envio PGTO"],
    }
    # A caixinha dos orçamentos sem orçamento: tudo 0, e o valor também é o número 0.
    quotes = pulse["quotes"]
    assert quotes == {
        "awaiting": 0,
        "awaiting_total": 0,
        "awaiting_no_link": 0,
        "expiring": 0,
        "expired_90d": 0,
        "expired_90d_total": 0,
        "drafts": 0,
        "in_review": 0,
        "follow_up": 0,
        "follow_up_total": 0,
        "approved_month": 0,
        "approved_month_total": 0,
        "rejected_month": 0,
        "approved_90d": 0,
        "decided_90d": 0,
    }
    assert all(isinstance(quotes[key], float) for key in quotes if key.endswith("_total"))
    assert pulse["weeks"] == [{"start": s, "created": 0, "resolved": 0} for s in WEEK_STARTS]


@requires_db
async def test_focus_counts_each_ticket_once(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    await add_ticket(
        db, world, title="SLA recente", created_at=ago(days=2), resolution_due_at=ago(hours=1)
    )
    await add_ticket(
        db, world, title="SLA antiga", created_at=ago(days=40), resolution_due_at=ago(days=20)
    )
    # Antiga com o prazo vencendo (voltou de uma pausa): fica fora do topo, como a "SLA antiga".
    await add_ticket(
        db,
        world,
        title="Antiga vencendo",
        created_at=ago(days=40),
        resolution_due_at=NOW + timedelta(hours=2),
    )
    # Dois motivos na mesma OS (chegada atrasada e prazo vencendo): conta uma vez no topo.
    await add_ticket(
        db,
        world,
        title="Atrasada e vencendo",
        status=S.ASSIGNED,
        arrival_due_at=ago(minutes=30),
        resolution_due_at=NOW + timedelta(hours=5),
    )
    await add_ticket(db, world, title="Nove horas", scheduled_start=at(TODAY, 9))
    stuck = await add_ticket(
        db, world, title="Atendimento esquecido", status=S.IN_PROGRESS, arrived_at=ago(hours=13)
    )
    await add_ticket(
        db, world, title="Atendimento agora", status=S.IN_PROGRESS, arrived_at=ago(hours=2)
    )
    # Editada há 1 h, mas a caminho desde a madrugada: vale o histórico de status.
    on_the_way = await add_ticket(
        db, world, title="A caminho esquecida", status=S.EN_ROUTE, updated_at=ago(hours=1)
    )
    db.add(
        TicketEvent(
            ticket_id=on_the_way.id,
            event_type=TicketEventType.STATUS_CHANGED,
            from_value="scheduled",
            to_value="en_route",
            created_at=ago(hours=14),
        )
    )
    await add_ticket(
        db,
        world,
        title="Sem técnico amanhã",
        assignee_id=None,
        scheduled_start=at(TODAY + timedelta(days=1), 10),
    )
    await add_ticket(
        db,
        world,
        title="Sem técnico depois",
        assignee_id=None,
        scheduled_start=NOW + timedelta(days=3),
    )
    await db.commit()

    data = await overview(client, world)
    g = groups(data)
    assert {key: grp["count"] for key, grp in g.items() if grp["tier"] == "now"} == {
        "sla_breached": 1,
        "late_arrival": 1,
        "due_soon": 1,
        "today_not_started": 1,
        "field_stuck": 2,
        "unassigned_visit": 1,
    }
    assert data["focus"] == {"total": 6, "next_visit_at": None}
    assert g["unassigned"]["tier"] == "routine" and g["unassigned"]["count"] == 2
    tiers = [grp["tier"] for grp in data["attention"]]
    assert tiers == sorted(tiers, key=["now", "routine"].index)
    assert g["sla_breached"]["filters"] == {"sla_breached": True, "created_from": WINDOW_FROM}
    assert g["unassigned_visit"]["filters"] == {
        "unassigned": True,
        "open_only": True,
        "scheduled_from": "2026-11-17",
        "scheduled_to": "2026-11-18",
    }
    for key in ("late_arrival", "field_stuck", "due_soon"):
        assert g[key]["filters"] is None and g[key]["link"] is None, key
    stuck_items = g["field_stuck"]["items"]
    assert [i["ticket_id"] for i in stuck_items] == [str(on_the_way.id), str(stuck.id)]
    assert [i["reason"] for i in stuck_items] == [
        "Em deslocamento desde hoje às 01:00 (14 h)",
        "Em atendimento desde hoje às 02:00 (13 h)",
    ]
    assert datetime.fromisoformat(stuck_items[0]["when"]) == ago(hours=14)
    assert g["due_soon"]["items"][0]["reason"] == "Vence hoje às 20:00"
    # Os indicadores seguem sem o corte de 30 dias: as duas com SLA estourado.
    assert data["kpis"]["late"] == 2 and data["kpis"]["in_field_now"] == 3


@requires_db
async def test_routine_recent_cut_and_old_backlog(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    recent = await add_ticket(
        db,
        world,
        title="Recente sem técnico",
        status=S.NEW,
        assignee_id=None,
        created_at=ago(days=5),
    )
    await add_ticket(
        db,
        world,
        title="Antiga sem ninguém",
        status=S.NEW,
        assignee_id=None,
        owner_id=None,
        created_at=ago(days=40),
    )
    await add_ticket(
        db,
        world,
        title="Antiga agendada",
        scheduled_start=ago(days=20),
        created_at=ago(days=45),
        resolution_due_at=ago(days=10),
    )
    await add_ticket(
        db,
        world,
        title="Antiga improdutiva",
        status=S.ASSIGNED,
        scheduled_start=None,
        last_unproductive_at=ago(days=35),
        created_at=ago(days=50),
    )
    await add_ticket(
        db,
        world,
        title="Improdutiva ontem",
        status=S.ASSIGNED,
        scheduled_start=None,
        last_unproductive_at=ago(days=1),
        created_at=ago(days=60),
    )
    missed = await add_ticket(
        db, world, title="Passou sem baixa", scheduled_start=at(TODAY - timedelta(days=2), 10)
    )
    await add_ticket(db, world, title="Parada", updated_at=ago(days=4))
    await db.commit()

    data = await overview(client, world)
    g = groups(data)
    # As antigas (SLA estourado, sem analista) não entram na rotina: ficam na "Fila antiga".
    assert {key: grp["count"] for key, grp in g.items()} == {
        "unassigned": 1,
        "missed_visits": 1,
        "unproductive_pending": 1,
        "stale": 1,
    }
    assert all(grp["tier"] == "routine" for grp in g.values())
    assert [i["ticket_id"] for i in g["unassigned"]["items"]] == [str(recent.id)]
    assert g["missed_visits"]["filters"] == {
        "status": NOT_STARTED,
        "scheduled_from": "2026-11-10",
        "scheduled_to": "2026-11-16",
    }
    item = g["missed_visits"]["items"][0]
    assert (item["ticket_id"], item["reason"]) == (str(missed.id), "Era 15/11 às 10:00, sem início")
    assert g["unproductive_pending"]["severity"] == "medium"
    assert g["stale"]["severity"] == "low"
    assert data["focus"]["total"] == 0

    backlog = data["pulse"]["backlog"]
    assert (backlog["open"], backlog["recent"], backlog["old"]) == (7, 3, 4)
    assert [(a["key"], a["count"]) for a in backlog["ages"]] == [
        ("d7", 3),
        ("d30", 0),
        ("d90", 4),
        ("older", 0),
    ]
    assert backlog["median_age_days"] == 40.0
    old_to = "2026-10-18"
    assert backlog["old_reasons"] == [
        {"key": "unproductive", "label": "Improdutiva sem reagendar", "count": 2, "filters": None},
        {
            "key": "no_owner",
            "label": "Sem analista responsável",
            "count": 1,
            "filters": {"no_owner": True, "open_only": True, "created_to": old_to},
        },
        {
            "key": "unassigned",
            "label": "Sem técnico",
            "count": 1,
            "filters": {"unassigned": True, "open_only": True, "created_to": old_to},
        },
        {
            "key": "overdue_visit",
            "label": "Visita passou sem baixa",
            "count": 1,
            "filters": {
                "status": NOT_STARTED,
                "scheduled_to": "2026-11-16",
                "created_to": old_to,
            },
        },
        {
            "key": "sla_breached",
            "label": "SLA estourado",
            "count": 1,
            "filters": {"sla_breached": True, "created_to": old_to},
        },
    ]


@requires_db
async def test_today_and_tomorrow(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    tech, other = world.tech.user.id, world.tech_other.user.id
    tomorrow = TODAY + timedelta(days=1)
    await add_ticket(
        db,
        world,
        title="Concluída cedo",
        status=S.RESOLVED,
        scheduled_start=at(TODAY, 8),
        resolved_at=at(TODAY, 10),
    )
    await add_ticket(db, world, title="A caminho", status=S.EN_ROUTE, scheduled_start=at(TODAY, 14))
    await add_ticket(db, world, title="Nove horas", scheduled_start=at(TODAY, 9))
    await add_ticket(db, world, title="Quinze para as três", scheduled_start=at(TODAY, 14, 45))
    await add_ticket(
        db, world, title="Quatro da tarde", assignee_id=other, scheduled_start=at(TODAY, 16)
    )
    await add_ticket(
        db,
        world,
        title="Esperando o cliente",
        status=S.ON_HOLD_CUSTOMER,
        scheduled_start=at(TODAY, 11),
    )
    await add_ticket(
        db,
        world,
        title="Sem técnico à noite",
        status=S.NEW,
        assignee_id=None,
        scheduled_start=at(TODAY, 18),
    )
    await add_ticket(
        db, world, title="Cancelada", status=S.CANCELLED, scheduled_start=at(TODAY, 12)
    )
    # Agendada para outro dia e concluída agora: entra nas resolvidas de hoje, não nas visitas.
    await add_ticket(
        db,
        world,
        title="Fechada agora",
        status=S.CLOSED,
        scheduled_start=at(TODAY - timedelta(days=3), 9),
        resolved_at=ago(minutes=30),
    )
    for hour, assignee in ((9, tech), (10, other)):
        await add_ticket(
            db,
            world,
            title=f"Amanhã {hour}h",
            assignee_id=assignee,
            scheduled_start=at(tomorrow, hour),
        )
    await add_ticket(
        db,
        world,
        title="Amanhã sem técnico",
        status=S.NEW,
        assignee_id=None,
        scheduled_start=at(tomorrow, 11),
    )
    await add_ticket(
        db, world, title="Amanhã cancelada", status=S.CANCELLED, scheduled_start=at(tomorrow, 12)
    )
    await db.commit()

    data = await overview(client, world)
    today = data["pulse"]["today"]
    assert {key: value for key, value in today.items() if key != "unassigned_filters"} == {
        "planned": 7,
        "done": 1,
        "in_field": 1,
        "not_started": 1,
        "on_hold": 1,
        "upcoming": 3,
        "unassigned": 1,
        "technicians": 2,
        "resolved": 2,
    }
    # A barra do dia fecha: cada visita planejada está em uma parte só.
    parts = ("done", "in_field", "not_started", "upcoming", "on_hold")
    assert sum(today[key] for key in parts) == today["planned"]
    assert datetime.fromisoformat(data["focus"]["next_visit_at"]) == at(TODAY, 16)
    next_day = data["pulse"]["tomorrow"]
    assert (next_day["planned"], next_day["technicians"], next_day["unassigned"]) == (3, 2, 1)
    assert data["kpis"]["scheduled_today"] == 7
    assert groups(data)["unassigned_visit"]["count"] == 2


@requires_db
async def test_backlog_ages_and_flow(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    for age in (timedelta(hours=1), timedelta(days=10), timedelta(days=45), timedelta(days=120)):
        await add_ticket(db, world, created_at=NOW - age)
    await add_ticket(db, world, status=S.CLOSED, created_at=ago(days=50), resolved_at=ago(days=5))
    await add_ticket(db, world, status=S.CLOSED, created_at=ago(days=42), resolved_at=ago(days=40))
    await add_ticket(
        db, world, status=S.CANCELLED, created_at=ago(days=3), cancelled_at=ago(days=2)
    )
    await db.commit()

    backlog = (await overview(client, world))["pulse"]["backlog"]
    assert (backlog["open"], backlog["recent"], backlog["old"]) == (4, 2, 2)
    assert [a["count"] for a in backlog["ages"]] == [1, 1, 1, 1]
    assert backlog["median_age_days"] == 27.5
    flow = (backlog["entered_30d"], backlog["resolved_30d"], backlog["cancelled_30d"])
    assert flow == (3, 1, 1)


@requires_db
async def test_quality_on_time_sla_unproductive(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    async def visit(arrived: datetime, **fields: object) -> None:
        await add_ticket(
            db,
            world,
            status=S.CLOSED,
            created_at=arrived - timedelta(days=1),
            arrived_at=arrived,
            resolved_at=arrived + timedelta(hours=1),
            **fields,
        )

    # Com prazo de chegada: 10 min antes (no horário) e 20 min depois (atrasada).
    await visit(ago(days=5, minutes=10), arrival_due_at=ago(days=5), scheduled_start=None)
    await visit(
        ago(days=4) + timedelta(minutes=20), arrival_due_at=ago(days=4), scheduled_start=None
    )
    # Só com a agenda: vale o horário + 30 min (20 min no horário, 45 min atrasada).
    await visit(ago(days=3) + timedelta(minutes=20), scheduled_start=ago(days=3))
    await visit(ago(days=2) + timedelta(minutes=45), scheduled_start=ago(days=2))
    # Fora da janela; e uma chegada sem com o que comparar (conta só nas idas à loja).
    await visit(ago(days=40), scheduled_start=ago(days=40))
    await add_ticket(db, world, status=S.IN_PROGRESS, scheduled_start=None, arrived_at=ago(hours=1))
    # Prazo de solução: no prazo, atrasada (importada do Field Control) e sem prazo.
    in_time = await add_ticket(
        db, world, status=S.CLOSED, resolution_due_at=ago(days=1), resolved_at=ago(days=2)
    )
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        resolution_due_at=ago(days=3),
        resolved_at=ago(days=2),
        legacy={"source": "fieldcontrol"},
    )
    await add_ticket(db, world, status=S.CLOSED, resolved_at=ago(days=2))
    for days in (2, 1, 40):
        db.add(
            TicketEvent(
                ticket_id=in_time.id,
                event_type=TicketEventType.UNPRODUCTIVE_VISIT,
                to_value="Loja fechada",
                created_at=ago(days=days),
            )
        )
    await db.commit()

    quality = (await overview(client, world))["pulse"]["quality"]
    assert quality["on_time"] == {"count": 2, "base": 4}
    assert quality["resolution_sla"] == {"count": 1, "base": 2}
    assert quality["resolution_sla_imported"] == 1
    assert (quality["unproductive"], quality["visits"]) == (2, 7)


@requires_db
async def test_store_return_needs_complete_follow_up(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    customer_id = uuid.UUID(world.customer_id)
    stores = [Location(customer_id=customer_id, name=f"Loja Fictícia {n}") for n in range(1, 5)]
    db.add_all(stores)
    await db.flush()

    async def done(store: Location, days: int) -> None:
        await add_ticket(
            db,
            world,
            status=S.CLOSED,
            location_id=store.id,
            created_at=ago(days=days + 1),
            resolved_at=ago(days=days),
        )

    # Loja 1: nova corretiva 3 dias depois da conclusão (é retorno).
    await done(stores[0], 10)
    await add_ticket(db, world, location_id=stores[0].id, created_at=ago(days=7))
    # Loja 2: preventiva dentro dos 7 dias e corretiva depois deles (não é retorno).
    await done(stores[1], 20)
    await add_ticket(
        db, world, location_id=stores[1].id, type=TicketType.PREVENTIVE, created_at=ago(days=18)
    )
    await add_ticket(db, world, location_id=stores[1].id, created_at=ago(days=11))
    # Loja 3: concluída há 3 dias, sem os 7 dias de acompanhamento (fora da base).
    await done(stores[2], 3)
    # Loja 4: o retorno foi cancelado (não conta).
    await done(stores[3], 15)
    await add_ticket(
        db, world, location_id=stores[3].id, status=S.CANCELLED, created_at=ago(days=13)
    )
    await db.commit()

    quality = (await overview(client, world))["pulse"]["quality"]
    assert quality["store_return"] == {"count": 1, "base": 3}


@requires_db
async def test_team_block(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    tech, other = world.tech.user.id, world.tech_other.user.id
    await db.execute(update(User).where(User.id == tech).values(last_login_at=ago(days=1)))
    for seconds in (3600, 18000, 0):
        await add_ticket(db, world, status=S.CLOSED, resolved_at=ago(days=2), work_seconds=seconds)
    await add_ticket(
        db, world, status=S.CLOSED, assignee_id=other, resolved_at=ago(days=3), work_seconds=7200
    )
    # O analista resolveu no remoto (não é técnico); a de 40 dias fica fora da janela.
    await add_ticket(
        db, world, status=S.CLOSED, assignee_id=world.analyst.user.id, resolved_at=ago(days=1)
    )
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        created_at=ago(days=41),
        resolved_at=ago(days=40),
        work_seconds=3600,
    )
    await db.commit()

    team = (await overview(client, world))["pulse"]["team"]
    assert team == {
        "worked": 2,
        "resolved": 4,
        "top3_resolved": 4,
        "in_app": 1,
        "onsite_median_minutes": 120,
        "onsite_over": {"count": 1, "base": 3},
        "onsite_limit_hours": 4,
    }


@requires_db
async def test_customers_block(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    main = world.customer_id
    second = Customer(name="Rede Fictícia de Testes")
    third = Customer(name="Comércio Imaginário")
    db.add_all([second, third])
    await db.flush()
    second_store = Location(customer_id=second.id, name="Filial Fictícia Norte")
    third_store = Location(customer_id=third.id, name="Filial Fictícia Sul")
    db.add_all([second_store, third_store])
    await db.flush()
    start = ago(days=1)
    for minutes in (10, 50):
        await add_ticket(
            db,
            world,
            status=S.CLOSED,
            created_at=ago(days=2),
            scheduled_start=start,
            arrived_at=start + timedelta(minutes=minutes),
            resolved_at=start + timedelta(hours=2),
        )
    await add_ticket(db, world, created_at=ago(days=2), resolution_due_at=ago(hours=1))
    on_second = {"customer_id": second.id, "location_id": second_store.id}
    await add_ticket(db, world, created_at=ago(days=3), **on_second)
    await add_ticket(db, world, created_at=ago(days=40), **on_second)
    # Só uma OS antiga, com a chegada também antes da janela: o cliente não aparece.
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        customer_id=third.id,
        location_id=third_store.id,
        created_at=ago(days=46),
        scheduled_start=ago(days=45),
        arrived_at=ago(days=45),
        resolved_at=ago(days=45) + timedelta(hours=1),
    )
    await db.commit()

    customers = (await overview(client, world))["pulse"]["customers"]
    assert (customers["active"], customers["entered"]) == (2, 4)
    first, runner_up = customers["top"]
    assert first == {
        "id": main,
        "name": "Cliente Teste",
        "created": 3,
        "on_time": {"count": 1, "base": 2},
        "breached": 1,
        "filters": {"customer_id": main, "created_from": WINDOW_FROM},
        "breached_filters": {
            "customer_id": main,
            "sla_breached": True,
            "created_from": WINDOW_FROM,
        },
    }
    assert (runner_up["id"], runner_up["created"]) == (str(second.id), 1)
    assert runner_up["breached"] == 0 and runner_up["breached_filters"] is None


@requires_db
async def test_finance_values_and_payout_tag(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    tech, other = world.tech.user.id, world.tech_other.user.id
    late = await add_ticket(db, world, status=S.CLOSED, resolved_at=ago(days=10))
    recent = await add_ticket(
        db, world, status=S.CLOSED, assignee_id=other, resolved_at=ago(days=2)
    )
    still_open = await add_ticket(db, world)
    paid = await add_ticket(db, world, status=S.CLOSED, resolved_at=ago(days=20))
    pgto = {"name": "Pendente Envio PGTO", "color": "field-pale"}
    # A etiqueta nas concluídas (com grafia diferente também) e numa OS aberta (não conta).
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        created_at=ago(days=41),
        resolved_at=ago(days=40),
        tags=[pgto],
    )
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        assignee_id=other,
        resolved_at=ago(days=1),
        tags=[{"name": " pendente  envio pgto ", "color": None}],
    )
    await add_ticket(db, world, tags=[pgto])

    def quote(title: str, total: str, status: QuoteStatus, **fields: object) -> Quote:
        value = Decimal(total)
        return Quote(
            ticket_id=still_open.id,
            title=title,
            subtotal=value,
            total=value,
            status=status,
            **fields,
        )

    def expense(total: str, **fields: object) -> TicketExpense:
        value = Decimal(total)
        return TicketExpense(
            ticket_id=still_open.id,
            kind=ExpenseKind.TOLL,
            description="Pedágio",
            quantity=Decimal("1"),
            unit_value=value,
            total=value,
            **fields,
        )

    db.add_all(
        [
            TicketPayout(ticket_id=late.id, technician_id=tech, amount=Decimal("150")),
            TicketPayout(ticket_id=recent.id, technician_id=other, amount=Decimal("100")),
            TicketPayout(ticket_id=still_open.id, technician_id=tech, amount=Decimal("90")),
            TicketPayout(
                ticket_id=paid.id,
                technician_id=tech,
                amount=Decimal("80"),
                status=PayoutStatus.PAID,
            ),
            quote("Rack", "300", QuoteStatus.SENT, sent_at=ago(days=1)),
            quote(
                "Vencido",
                "70",
                QuoteStatus.SENT,
                sent_at=ago(days=9),
                valid_until=TODAY - timedelta(days=1),
            ),
            quote("Cabos", "500", QuoteStatus.APPROVED, decided_at=ago(days=2)),
            quote("Nobreak", "700", QuoteStatus.APPROVED, decided_at=at(date(2026, 10, 30), 10)),
            expense("12.5", technician_id=tech),
            expense("20", status=ExpenseStatus.APPROVED),
        ]
    )
    await db.commit()

    finance = (await overview(client, world))["pulse"]["finance"]
    assert finance == {
        "payouts_to_pay": 250.0,
        "payouts_to_pay_count": 2,
        "payouts_technicians": 2,
        "payouts_late": 1,
        "payouts_expected": 90.0,
        "payout_tag": "Pendente Envio PGTO",
        "payout_tag_tickets": 2,
        "payout_tag_technicians": 2,
        "payout_tag_over_30d": 1,
        "payout_tag_filters": {"status": ["resolved", "closed"], "tag": ["Pendente Envio PGTO"]},
        "quotes_waiting": 1,
        "quotes_waiting_total": 300.0,
        "quotes_approved_month": 1,
        "quotes_approved_month_total": 500.0,
        "costs_pending": 1,
        "costs_pending_total": 12.5,
    }
    # O link da etiqueta abre a lista com exatamente essas OS.
    assert await list_total(client, world, finance["payout_tag_filters"]) == 2


@requires_db
async def test_quotes_box(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ticket = await add_ticket(db, world, title="OS com orçamentos")
    cancelled = await add_ticket(db, world, title="OS cancelada", status=S.CANCELLED)
    sent, expired, draft = QuoteStatus.SENT, QuoteStatus.EXPIRED, QuoteStatus.DRAFT
    approved, rejected = QuoteStatus.APPROVED, QuoteStatus.REJECTED

    def quote(title: str, total: str, status: QuoteStatus, **fields: object) -> Quote:
        value = Decimal(total)
        fields.setdefault("ticket_id", ticket.id)
        return Quote(title=title, subtotal=value, total=value, status=status, **fields)

    def listed(now: datetime, today: date) -> list[Quote]:
        """Os orçamentos dos recortes com link para a lista (aguardando, vencidos e rascunhos),
        com as datas relativas a `now` e `today`."""

        def day(n: int) -> date:
            return today + timedelta(days=n)

        def before(**delta: float) -> datetime:
            return now - timedelta(**delta)

        gone = {"ticket_id": cancelled.id}
        return [
            # Aguardando a assinatura (o da OS cancelada também, como na lista).
            quote(
                "Na validade", "100.25", sent, link_id="l1", valid_until=day(10), sent_at=before(days=1)
            ),
            quote("Sem link", "200", sent, valid_until=day(5), sent_at=before(days=3)),
            quote("Vence amanhã", "400", sent, link_id="l2", valid_until=day(1), sent_at=before(days=1)),
            quote(
                "Vence hoje, cobrado agora",
                "500",
                sent,
                link_id="l3",
                valid_until=day(0),
                sent_at=before(days=5),
                last_reminded_at=now,
                reminder_count=1,
            ),
            quote(
                "Da OS cancelada", "600", sent, link_id="l4", valid_until=day(10), sent_at=before(days=3), **gone
            ),
            # Vencidos pela criação nos 90 dias: o enviado com a validade passada também conta.
            quote(
                "Validade passada",
                "1000",
                sent,
                link_id="l5",
                valid_until=day(-2),
                sent_at=before(days=9),
                created_at=before(days=10),
            ),
            quote("Vencido há 8 dias", "2000", expired, valid_until=day(-8), created_at=before(days=10)),
            quote(
                "Vencido da OS cancelada", "8000", expired, valid_until=day(-3), created_at=before(days=5), **gone
            ),
            quote("Criado há 100 dias", "4000", expired, valid_until=day(-95), created_at=before(days=100)),
            # Rascunhos: o nunca enviado e o editado depois do envio (em revisão).
            quote("Rascunho", "10", draft),
            quote("Em revisão", "20", draft, sent_at=before(days=3), updated_at=before(days=2)),
        ]

    db.add_all(
        [
            *listed(NOW, TODAY),
            # Link antigo (só o hash) e sem validade: aguardando, e o cliente tem como assinar.
            quote("Link antigo, sem validade", "300", sent, token_hash="f" * 64, sent_at=ago(days=1)),
            # Respondidos. O de 31/10 às 23h30 em São Paulo (já 01/11 em UTC) é do mês passado.
            quote("Aprovado", "50", approved, decided_at=ago(days=2)),
            quote("Aprovado da OS cancelada", "60", approved, decided_at=ago(days=2), ticket_id=cancelled.id),
            quote("Aprovado em 31/10", "70", approved, decided_at=at(date(2026, 10, 31), 23, 30)),
            quote("Aprovado há 60 dias", "80", approved, decided_at=ago(days=60)),
            quote("Aprovado há 100 dias", "90", approved, decided_at=ago(days=100)),
            quote("Recusado", "30", rejected, decided_at=ago(days=5)),
            quote("Cancelado", "40", QuoteStatus.CANCELLED),
        ]
    )
    await db.commit()

    data = await overview(client, world)
    quotes = data["pulse"]["quotes"]
    assert quotes == {
        "awaiting": 6,  # os 5 enviados na validade (um de OS cancelada) e o sem validade
        "awaiting_total": 2100.25,
        "awaiting_no_link": 1,
        "expiring": 2,  # vence hoje e vence amanhã
        "expired_90d": 3,  # validade passada, vencido há 8 dias e o da OS cancelada
        "expired_90d_total": 11000.0,
        "drafts": 2,
        "in_review": 1,
        "follow_up": 4,  # sem link, vence amanhã, validade passada e em revisão
        "follow_up_total": 1620.0,
        "approved_month": 1,
        "approved_month_total": 50.0,
        "rejected_month": 1,
        "approved_90d": 3,  # no mês, em 31/10 e há 60 dias
        "decided_90d": 6,  # os 3 aprovados, o recusado e os 2 vencidos de OS aberta
    }
    # A fila é o número do grupo do Início; o aprovado no mês, o mesmo do financeiro.
    assert groups(data)["quotes_waiting"]["count"] == quotes["follow_up"]
    finance = data["pulse"]["finance"]
    assert (finance["quotes_approved_month"], finance["quotes_approved_month_total"]) == (1, 50.0)

    # GET /quotes usa o relógio de verdade: os mesmos orçamentos de novo, com as datas relativas a
    # ele, e a tela sem o "agora" fixo. Cada recorte com link bate com a lista do link.
    await db.execute(delete(Quote))
    db.add_all(listed(utcnow(), local_today()))
    await db.commit()
    monkeypatch.setattr(home, "utcnow", utcnow)
    monkeypatch.setattr(home, "local_today", local_today)
    quotes = (await overview(client, world))["pulse"]["quotes"]
    counts = (quotes["awaiting"], quotes["expired_90d"], quotes["drafts"], quotes["follow_up"])
    assert counts == (5, 3, 2, 4)
    start = (utcnow() - timedelta(days=90)).isoformat()
    for params, count in (
        ({"status": "sent"}, quotes["awaiting"]),
        ({"status": "expired", "start": start}, quotes["expired_90d"]),
        ({"status": "draft"}, quotes["drafts"]),
        ({"follow_up": "true"}, quotes["follow_up"]),
    ):
        r = await client.get(f"{API}/quotes", params=params, headers=world.analyst.headers)
        assert r.status_code == 200, r.text
        assert (r.headers["x-total-count"], len(r.json())) == (str(count), count), params


@requires_db
async def test_weeks_follow_local_mondays(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    # Domingo 23h30 em São Paulo (já segunda em UTC) é da semana anterior.
    await add_ticket(db, world, created_at=at(date(2026, 11, 15), 23, 30))
    await add_ticket(db, world, created_at=at(date(2026, 11, 16), 0, 30))
    await add_ticket(db, world, created_at=at(date(2026, 9, 28), 8))
    await add_ticket(db, world, created_at=at(date(2026, 9, 27), 12))  # antes das 8 semanas
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        created_at=at(date(2026, 11, 2), 9),
        resolved_at=at(date(2026, 11, 10), 9),
    )
    await db.commit()

    weeks = (await overview(client, world))["pulse"]["weeks"]
    assert [w["start"] for w in weeks] == WEEK_STARTS
    assert [(w["created"], w["resolved"]) for w in weeks] == [
        (1, 0),
        (0, 0),
        (0, 0),
        (0, 0),
        (0, 0),
        (1, 0),
        (1, 1),
        (1, 0),
    ]


@requires_db
async def test_late_technician_uses_schedule_without_arrival_due(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    # OS sem prazo de chegada (como as importadas), abertas antes da janela: vale a agenda +
    # 30 min. Duas chegaram 45 min depois; a de 20 min ficou no horário.
    for days, minutes in ((3, 45), (10, 45), (5, 20)):
        start = ago(days=days)
        await add_ticket(
            db,
            world,
            status=S.CLOSED,
            created_at=ago(days=45),
            scheduled_start=start,
            arrived_at=start + timedelta(minutes=minutes),
            resolved_at=start + timedelta(hours=2),
        )
    await db.commit()

    found = {s["key"]: s for s in (await overview(client, world))["suggestions"]}
    late = found["late_technician"]
    assert late["title"] == "Tecnico chegou atrasado em 2 OS nos últimos 30 dias"
    assert late["filters"]["assignee_id"] == str(world.tech.user.id)


@requires_db
async def test_filters_reproduce_list_totals(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    second = Customer(name="Rede Fictícia Dois")
    db.add(second)
    await db.flush()
    second_store = Location(customer_id=second.id, name="Filial Fictícia Dois")
    db.add(second_store)
    await db.flush()
    on_second = {"customer_id": second.id, "location_id": second_store.id}
    nobody = {"status": S.NEW, "assignee_id": None, "scheduled_start": None}
    # Prazos longe de "agora": a lista compara com o relógio de verdade.
    # Abertas na janela de 30 dias.
    await add_ticket(db, world, created_at=ago(days=2), resolution_due_at=ago(days=1))
    await add_ticket(db, world, created_at=ago(days=3), **nobody)
    await add_ticket(db, world, status=S.NEW, assignee_id=None, scheduled_start=at(TODAY, 18))
    await add_ticket(
        db,
        world,
        status=S.NEW,
        assignee_id=None,
        scheduled_start=at(TODAY + timedelta(days=1), 9),
    )
    await add_ticket(
        db, world, created_at=ago(days=5), scheduled_start=at(TODAY - timedelta(days=3), 9)
    )
    await add_ticket(db, world, created_at=ago(days=6), owner_id=None)
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        created_at=ago(days=5),
        resolution_due_at=ago(days=3),
        resolved_at=ago(days=2),
    )
    await add_ticket(db, world, created_at=ago(days=8), resolution_due_at=ago(days=4), **on_second)
    await add_ticket(db, world, created_at=ago(days=12), **on_second)
    await add_ticket(db, world, status=S.CANCELLED, assignee_id=None, scheduled_start=at(TODAY, 10))
    # Abertas antes (a "Fila antiga").
    await add_ticket(db, world, created_at=ago(days=40), resolution_due_at=ago(days=20))
    await add_ticket(db, world, created_at=ago(days=50), owner_id=None, **nobody)
    await add_ticket(db, world, created_at=ago(days=60), scheduled_start=ago(days=25))
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        created_at=ago(days=45),
        resolution_due_at=ago(days=35),
        resolved_at=ago(days=33),
    )
    await add_ticket(db, world, created_at=ago(days=100))
    await db.commit()

    data = await overview(client, world)
    pulse = data["pulse"]
    backlog = pulse["backlog"]
    # Todo grupo com filtro tem de bater com a lista (o de hoje sem início vem sem filtro).
    checks: list[tuple[str, int, dict]] = [
        (grp["key"], grp["count"], grp["filters"]) for grp in data["attention"] if grp["filters"]
    ]
    checks += [(f"idade {a['key']}", a["count"], a["filters"]) for a in backlog["ages"]]
    checks += [
        (f"antiga {r['key']}", r["count"], r["filters"])
        for r in backlog["old_reasons"]
        if r["filters"]
    ]
    checks.append(("fila antiga", backlog["old"], backlog["old_filters"]))
    for customer in pulse["customers"]["top"]:
        checks.append((customer["name"], customer["created"], customer["filters"]))
        if customer["breached_filters"]:
            sla = customer["breached_filters"]
            checks.append((f"{customer['name']} SLA", customer["breached"], sla))
    for day in ("today", "tomorrow"):
        checks.append((day, pulse[day]["unassigned"], pulse[day]["unassigned_filters"]))

    groups_with_list = {
        "sla_breached",
        "unassigned_visit",
        "missed_visits",
        "unassigned",
        "no_owner",
        "violation_pending",
    }
    assert groups_with_list <= {name for name, _, _ in checks}
    assert len(checks) == 21 and all(count > 0 for _, count, _ in checks)
    for name, count, filters in checks:
        assert await list_total(client, world, filters) == count, name

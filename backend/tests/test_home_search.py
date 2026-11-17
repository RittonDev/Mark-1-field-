"""Tela inicial da gestão (pontos de atenção, indicadores, sugestões) e a busca inteligente.

Os dados são inventados e gravados direto no banco (horários exatos). "Agora" e "hoje" ficam fixos
em 17/11/2026 15:00 (São Paulo) para os prazos e períodos não dependerem da hora do teste.
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.documents import cnpj_with_check_digits
from app.core.enums import (
    ExpenseKind,
    ExpenseStatus,
    PartRequestStatus,
    PayoutStatus,
    QuoteStatus,
    TicketEventType,
    TicketPriority,
    TicketSource,
    TicketStatus,
    UserRole,
)
from app.models import (
    Customer,
    Location,
    Quote,
    ServiceType,
    Ticket,
    TicketEvent,
    TicketExpense,
    TicketPartRequest,
    TicketPayout,
    User,
)
from app.models.ticket import ticket_helpers
from app.schemas.home import ListFilters
from app.services import home, smart_search
from app.services.smart_search import read_query
from tests.conftest import World, requires_db

API = settings.API_PREFIX
TZ = ZoneInfo(settings.TIMEZONE)
TODAY = date(2026, 11, 17)  # terça-feira
NOW = datetime(2026, 11, 17, 15, 0, tzinfo=TZ).astimezone(UTC)
S = TicketStatus


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime.combine(day, time(hour, minute), tzinfo=TZ)


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """ "Agora" fixo para a tela inicial e para a busca."""
    monkeypatch.setattr(home, "utcnow", lambda: NOW)
    monkeypatch.setattr(home, "local_today", lambda: TODAY)
    monkeypatch.setattr(smart_search, "utcnow", lambda: NOW)
    monkeypatch.setattr(smart_search, "local_today", lambda: TODAY)


@pytest.fixture
async def db(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        yield session


async def add_ticket(db: AsyncSession, world: World, **fields: object) -> Ticket:
    """OS "sem problema nenhum" (agendada daqui a 3 dias, com técnico e analista); cada teste
    muda só o que cria o ponto de atenção."""
    data: dict[str, object] = {
        "title": "Manutenção de teste",
        "status": S.SCHEDULED,
        "customer_id": uuid.UUID(world.customer_id),
        "location_id": uuid.UUID(world.location_id),
        "assignee_id": world.tech.user.id,
        "owner_id": world.analyst.user.id,
        "scheduled_start": NOW + timedelta(days=3),
        "created_at": NOW - timedelta(hours=1),
        "updated_at": NOW - timedelta(hours=1),
    }
    data.update(fields)
    ticket = Ticket(**data)
    db.add(ticket)
    await db.flush()
    return ticket


async def add_user(db: AsyncSession, name: str, role: UserRole, active: bool = True) -> User:
    user = User(
        name=name,
        email=f"{uuid.uuid4().hex[:10]}@teste.com.br",
        password_hash="x",
        role=role,
        is_active=active,
    )
    db.add(user)
    await db.flush()
    return user


async def overview(client: AsyncClient, world: World) -> dict:
    r = await client.get(f"{API}/home/overview", headers=world.supervisor.headers)
    assert r.status_code == 200, r.text
    return r.json()


def groups(data: dict) -> dict[str, dict]:
    return {g["key"]: g for g in data["attention"]}


# =========================================================================== tela inicial


@requires_db
async def test_home_is_for_ticket_managers_only(client: AsyncClient, world: World) -> None:
    url = f"{API}/home/overview"
    assert (await client.get(url)).status_code == 401
    assert (await client.get(url, headers=world.tech.headers)).status_code == 403
    assert (await client.get(url, headers=world.requester.headers)).status_code == 403
    for actor in (world.analyst, world.supervisor, world.admin):
        assert (await client.get(url, headers=actor.headers)).status_code == 200


@requires_db
async def test_home_without_data(client: AsyncClient, world: World, frozen: None) -> None:
    data = await overview(client, world)
    assert data["kpis"] == {
        "open": 0,
        "scheduled_today": 0,
        "in_field_now": 0,
        "resolved_today": 0,
        "late": 0,
        "unassigned": 0,
    }
    assert data["attention"] == [] and data["suggestions"] == []
    days = [w["day"] for w in data["week"]]
    assert days == [(TODAY - timedelta(days=n)).isoformat() for n in range(6, -1, -1)]
    assert all(w["created"] == 0 and w["resolved"] == 0 for w in data["week"])
    assert datetime.fromisoformat(data["generated_at"]) == NOW


@requires_db
async def test_home_attention_groups(
    client: AsyncClient, world: World, db: AsyncSession, frozen: None
) -> None:
    tech = world.tech.user.id
    no_problem = await add_ticket(db, world, title="Tudo certo")

    # SLA estourado: pela solução e pela 1ª resposta.
    sla_solution = await add_ticket(
        db,
        world,
        title="Solução vencida",
        response_due_at=NOW - timedelta(hours=5),
        first_response_at=NOW - timedelta(hours=6),
        resolution_due_at=NOW - timedelta(hours=2),
    )
    sla_response = await add_ticket(
        db,
        world,
        title="Resposta vencida",
        response_due_at=NOW - timedelta(minutes=30),
        resolution_due_at=NOW + timedelta(hours=5),
    )
    # Chegada atrasada (e os que não contam: já chegou; prazo ainda não venceu).
    late = await add_ticket(
        db,
        world,
        title="A caminho",
        status=S.EN_ROUTE,
        arrival_due_at=NOW - timedelta(minutes=40),
    )
    await add_ticket(
        db,
        world,
        title="Chegou",
        status=S.IN_PROGRESS,
        arrival_due_at=NOW - timedelta(hours=1),
        arrived_at=NOW - timedelta(minutes=70),
    )
    await add_ticket(db, world, title="No prazo", arrival_due_at=NOW + timedelta(hours=1))
    # Visitas de hoje: 09:00 sem início conta; 14:45 (15 min) e 16:00 ainda não.
    not_started = await add_ticket(db, world, title="Nove horas", scheduled_start=at(TODAY, 9))
    await add_ticket(db, world, title="Quinze para as três", scheduled_start=at(TODAY, 14, 45))
    await add_ticket(db, world, title="Quatro da tarde", scheduled_start=at(TODAY, 16))
    # Sem técnico: aberta há 30 h; visita amanhã cedo. Aberta há 2 h com visita em 3 dias, não.
    old_unassigned = await add_ticket(
        db,
        world,
        title="Sem técnico antiga",
        status=S.NEW,
        assignee_id=None,
        scheduled_start=None,
        created_at=NOW - timedelta(hours=30),
    )
    soon_unassigned = await add_ticket(
        db,
        world,
        title="Sem técnico amanhã",
        assignee_id=None,
        scheduled_start=NOW + timedelta(hours=20),
    )
    await add_ticket(
        db,
        world,
        title="Sem técnico com folga",
        assignee_id=None,
        created_at=NOW - timedelta(hours=2),
    )
    # Improdutiva sem nova data (a reagendada não conta).
    unproductive = await add_ticket(
        db,
        world,
        title="Improdutiva",
        status=S.ASSIGNED,
        scheduled_start=None,
        last_unproductive_at=NOW - timedelta(days=1),
        unproductive_count=2,
    )
    await add_ticket(
        db,
        world,
        title="Improdutiva reagendada",
        last_unproductive_at=NOW - timedelta(days=2),
        scheduled_start=NOW + timedelta(days=1),
    )
    # Sem agenda: técnico de campo sem data (o analista no remoto não conta).
    no_schedule = await add_ticket(
        db, world, title="Sem data", status=S.ASSIGNED, scheduled_start=None
    )
    await add_ticket(
        db,
        world,
        title="Remoto",
        status=S.ASSIGNED,
        scheduled_start=None,
        assignee_id=world.analyst.user.id,
    )
    # Parada há 4 dias.
    stale = await add_ticket(db, world, title="Parada", updated_at=NOW - timedelta(days=4))
    # Sem analista: nenhum, ou um que saiu da gestão.
    gone = await add_user(db, "Analista Que Saiu", UserRole.ANALYST, active=False)
    no_owner = await add_ticket(db, world, title="Sem analista", owner_id=None)
    orphan = await add_ticket(db, world, title="Analista saiu", owner_id=gone.id)
    # Solicitação do portal esperando a central.
    portal = await add_ticket(
        db,
        world,
        title="Pedido do portal",
        status=S.NEW,
        source=TicketSource.PORTAL,
        assignee_id=None,
        scheduled_start=None,
        created_at=NOW - timedelta(hours=2),
    )
    # Concluídas: SLA violado sem motivo (conta) e no prazo (não conta); resolvida hoje.
    violated = await add_ticket(
        db,
        world,
        title="Fechada atrasada",
        status=S.CLOSED,
        resolution_due_at=NOW - timedelta(days=3),
        resolved_at=NOW - timedelta(days=2),
        closed_at=NOW - timedelta(days=1),
    )
    await add_ticket(
        db,
        world,
        title="Fechada no prazo",
        status=S.CLOSED,
        resolution_due_at=NOW - timedelta(days=1),
        resolved_at=NOW - timedelta(days=2),
    )
    await add_ticket(
        db, world, title="Resolvida hoje", status=S.RESOLVED, resolved_at=NOW - timedelta(hours=1)
    )
    # Pagamento do técnico pendente há 10 dias (3 dias e pago não contam).
    paid_late = await add_ticket(
        db, world, title="Paga atrasado", status=S.CLOSED, resolved_at=NOW - timedelta(days=10)
    )
    recent = await add_ticket(
        db, world, title="Concluída recente", status=S.CLOSED, resolved_at=NOW - timedelta(days=3)
    )
    paid = await add_ticket(
        db, world, title="Já paga", status=S.CLOSED, resolved_at=NOW - timedelta(days=20)
    )
    db.add_all(
        [
            TicketPayout(ticket_id=paid_late.id, technician_id=tech, amount=Decimal("150")),
            TicketPayout(ticket_id=recent.id, technician_id=tech, amount=Decimal("90")),
            TicketPayout(
                ticket_id=paid.id,
                technician_id=tech,
                amount=Decimal("80"),
                status=PayoutStatus.PAID,
            ),
            # Pedido de peça aberto (o já orçado não conta).
            TicketPartRequest(
                ticket_id=no_problem.id,
                description="Fonte 12V",
                quantity=Decimal("2"),
                requested_by_id=tech,
            ),
            TicketPartRequest(
                ticket_id=no_problem.id,
                description="Cabo HDMI",
                quantity=Decimal("1"),
                status=PartRequestStatus.QUOTED,
            ),
            # Custo extra a aprovar (o aprovado não conta).
            TicketExpense(
                ticket_id=no_problem.id,
                kind=ExpenseKind.TOLL,
                description="Pedágio",
                quantity=Decimal("1"),
                unit_value=Decimal("12.5"),
                total=Decimal("12.5"),
                technician_id=tech,
            ),
            TicketExpense(
                ticket_id=no_problem.id,
                kind=ExpenseKind.PARKING,
                description="Estacionamento",
                quantity=Decimal("1"),
                unit_value=Decimal("20"),
                total=Decimal("20"),
                status=ExpenseStatus.APPROVED,
            ),
            # Orçamentos para cobrar: enviado há 4 dias sem resposta e vencido ontem (contam);
            # enviado há 1 dia (ainda não).
            Quote(
                ticket_id=no_problem.id,
                title="Rack",
                subtotal=Decimal("300"),
                total=Decimal("300"),
                status=QuoteStatus.SENT,
                sent_at=NOW - timedelta(days=4),
            ),
            Quote(
                ticket_id=no_problem.id,
                title="Cabos",
                subtotal=Decimal("50"),
                total=Decimal("50"),
                status=QuoteStatus.SENT,
                sent_at=NOW - timedelta(days=1),
            ),
            Quote(
                ticket_id=no_problem.id,
                title="Vencido",
                subtotal=Decimal("70"),
                total=Decimal("70"),
                status=QuoteStatus.SENT,
                sent_at=NOW - timedelta(days=5),
                valid_until=TODAY - timedelta(days=1),
            ),
        ]
    )
    await db.commit()

    data = await overview(client, world)
    g = groups(data)
    counts = {key: group["count"] for key, group in g.items()}
    assert counts == {
        "sla_breached": 2,
        "late_arrival": 1,
        "today_not_started": 1,
        "unassigned_visit": 1,
        "unassigned": 4,
        "unproductive_pending": 1,
        "no_schedule": 1,
        "part_requests_open": 1,
        "costs_pending": 1,
        "portal_requests": 1,
        "stale": 1,
        "no_owner": 2,
        "violation_pending": 1,
        "payouts_pending": 1,
        "quotes_waiting": 2,
    }
    # O que pede ação agora primeiro; depois o mais grave e, no mesmo nível, o maior número.
    order = [(grp["tier"], grp["severity"], grp["count"]) for grp in data["attention"]]
    tier = {"now": 0, "routine": 1}
    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    assert order == sorted(order, key=lambda o: (tier[o[0]], rank[o[1]], -o[2]))
    assert [grp["key"] for grp in data["attention"]] == [
        "sla_breached",
        "late_arrival",
        "today_not_started",
        "unassigned_visit",
        "unassigned",
        "no_owner",
        "unproductive_pending",
        "no_schedule",
        "portal_requests",
        "part_requests_open",
        "costs_pending",
        "quotes_waiting",
        "stale",
        "violation_pending",
        "payouts_pending",
    ]
    now = {"sla_breached", "late_arrival", "today_not_started", "unassigned_visit"}
    assert {key for key, grp in g.items() if grp["tier"] == "now"} == now

    def ids(key: str) -> list[str]:
        return [item["ticket_id"] for item in g[key]["items"]]

    assert ids("sla_breached") == [str(sla_solution.id), str(sla_response.id)]
    reasons = [item["reason"] for item in g["sla_breached"]["items"]]
    assert reasons == ["Prazo de solução estourado há 2 h", "1ª resposta estourada há 30 min"]
    assert ids("late_arrival") == [str(late.id)]
    assert g["late_arrival"]["items"][0]["reason"] == "Chegada atrasada há 40 min · Em deslocamento"
    assert ids("today_not_started") == [str(not_started.id)]
    assert g["today_not_started"]["items"][0]["reason"] == "Agendada para 09:00, sem início há 6 h"
    assert ids("unassigned_visit") == [str(soon_unassigned.id)]
    assert g["unassigned_visit"]["items"][0]["reason"] == "Visita amanhã às 11:00 sem técnico"
    # Sem técnico (rotina): a visita mais próxima primeiro, depois as sem data, mais antigas antes.
    assert ids("unassigned")[0] == str(soon_unassigned.id)
    old_reason = next(
        i["reason"] for i in g["unassigned"]["items"] if i["ticket_id"] == str(old_unassigned.id)
    )
    assert old_reason == "Sem técnico há 1 dia"
    assert ids("unproductive_pending") == [str(unproductive.id)]
    assert g["unproductive_pending"]["items"][0]["reason"] == (
        "Improdutiva em 16/11: falta reagendar (2 visitas improdutivas)"
    )
    assert ids("no_schedule") == [str(no_schedule.id)]
    assert ids("stale") == [str(stale.id)]
    assert g["stale"]["items"][0]["reason"] == "Sem atualização há 4 dias"
    assert set(ids("no_owner")) == {str(no_owner.id), str(orphan.id)}
    assert "saiu da gestão" in next(
        i["reason"] for i in g["no_owner"]["items"] if i["ticket_id"] == str(orphan.id)
    )
    assert ids("portal_requests") == [str(portal.id)]
    assert ids("violation_pending") == [str(violated.id)]
    assert g["violation_pending"]["items"][0]["reason"].endswith("(solução)")
    payout = g["payouts_pending"]["items"][0]
    assert payout["ticket_id"] == str(paid_late.id) and payout["technician"] == "Tecnico"
    assert payout["reason"] == "R$ 150,00 a pagar · concluída há 10 dias"
    part = g["part_requests_open"]["items"][0]
    assert part["ticket_id"] == str(no_problem.id) and part["reason"].startswith("Peça: Fonte 12V")
    assert "(2 un)" in part["reason"] and part["technician"] == "Tecnico"
    cost = g["costs_pending"]["items"][0]
    assert cost["reason"].startswith("Pedágio de R$ 12,50 aguardando aprovação")
    # Quem vence antes primeiro (o vencido ontem); depois o sem validade, com o motivo.
    expired, waiting = (item["reason"] for item in g["quotes_waiting"]["items"])
    assert expired.startswith("ORC-") and expired.endswith("(R$ 70,00) venceu em 16/11: renove")
    assert waiting.startswith("ORC-")
    assert waiting.endswith("(R$ 300,00) enviado há 4 dias, sem resposta")

    # Os nomes vêm junto (cliente, loja, técnico), sem consulta por item.
    item = g["late_arrival"]["items"][0]
    assert (item["customer"], item["location"], item["technician"]) == (
        "Cliente Teste",
        "Matriz",
        "Tecnico",
    )
    assert item["number"] == late.number and item["title"] == "A caminho"
    assert datetime.fromisoformat(item["when"]) == NOW - timedelta(minutes=40)

    # Filtro da lista (só as chaves usadas) ou a página que mostra tudo. Os grupos recortados
    # nos últimos 30 dias levam o mesmo corte (created_from = hoje - 29).
    window = (TODAY - timedelta(days=29)).isoformat()
    assert g["sla_breached"]["filters"] == {"sla_breached": True, "created_from": window}
    assert g["unassigned_visit"]["filters"] == {
        "unassigned": True,
        "open_only": True,
        "scheduled_from": TODAY.isoformat(),
        "scheduled_to": (TODAY + timedelta(days=1)).isoformat(),
    }
    assert g["unassigned"]["filters"] == {
        "unassigned": True,
        "open_only": True,
        "created_from": window,
    }
    assert g["no_owner"]["filters"] == {"no_owner": True, "open_only": True, "created_from": window}
    assert g["violation_pending"]["filters"] == {"violation_pending": True, "created_from": window}
    # A lista não reproduz a tolerância de 30 min: o grupo vem sem filtro (e sem "Ver todas").
    assert g["today_not_started"]["filters"] is None
    links = {key: grp["link"] for key, grp in g.items() if grp["link"]}
    assert links == {
        "costs_pending": "/custos",
        "portal_requests": "/solicitacoes",
        "payouts_pending": "/pagamentos",
        "quotes_waiting": "/orcamentos?cobrar=1",
    }
    assert all(grp["title"] and grp["hint"] for grp in data["attention"])

    kpis = data["kpis"]
    assert kpis["late"] == 2 and kpis["in_field_now"] == 2 and kpis["resolved_today"] == 1
    assert kpis["scheduled_today"] == 3
    assert kpis["unassigned"] == 4  # as três sem técnico e a do portal
    open_count = sum(
        1
        for t in (await db.execute(Ticket.__table__.select())).all()
        if t.status in {s.value for s in home.OPEN_STATUSES}
    )
    assert kpis["open"] == open_count


@requires_db
async def test_home_items_are_capped_at_five_oldest_first(
    client: AsyncClient, world: World, db: AsyncSession, frozen: None
) -> None:
    for days in range(4, 11):
        await add_ticket(db, world, title=f"Parada {days}", updated_at=NOW - timedelta(days=days))
    await db.commit()
    stale = groups(await overview(client, world))["stale"]
    assert stale["count"] == 7 and len(stale["items"]) == 5
    assert [i["title"] for i in stale["items"]] == [f"Parada {d}" for d in (10, 9, 8, 7, 6)]
    assert stale["filters"] is None and stale["link"] is None


@requires_db
async def test_home_week_counts_sao_paulo_days(
    client: AsyncClient, world: World, db: AsyncSession, frozen: None
) -> None:
    # 23:30 do dia 15 em São Paulo já é dia 16 em UTC: conta no dia 15.
    await add_ticket(db, world, created_at=at(TODAY - timedelta(days=2), 23, 30))
    await add_ticket(db, world, created_at=at(TODAY, 8))
    await add_ticket(db, world, created_at=at(TODAY, 9))
    await add_ticket(
        db,
        world,
        status=S.CLOSED,
        created_at=at(TODAY - timedelta(days=30), 9),
        resolved_at=at(TODAY - timedelta(days=1), 10),
    )
    await add_ticket(db, world, created_at=at(TODAY - timedelta(days=7), 12))  # fora da semana
    await db.commit()
    week = {
        w["day"]: (w["created"], w["resolved"]) for w in (await overview(client, world))["week"]
    }
    assert len(week) == 7
    assert week[(TODAY - timedelta(days=2)).isoformat()] == (1, 0)
    assert week[(TODAY - timedelta(days=1)).isoformat()] == (0, 1)
    assert week[TODAY.isoformat()] == (2, 0)
    assert (TODAY - timedelta(days=7)).isoformat() not in week


@requires_db
async def test_home_suggestions(
    client: AsyncClient, world: World, db: AsyncSession, frozen: None
) -> None:
    tomorrow = TODAY + timedelta(days=1)
    customer = Customer(name="Rede Fictícia de Óticas")
    db.add(customer)
    await db.flush()
    store = Location(customer_id=customer.id, name="Ótica Imaginária Centro", city="Campinas")
    db.add(store)
    await db.flush()
    where = {"customer_id": customer.id, "location_id": store.id}
    # Loja com 3 OS em 30 dias (reincidência) e o cliente com mais OS em aberto.
    for n in range(3):
        await add_ticket(
            db, world, title=f"Reincidente {n}", created_at=NOW - timedelta(days=n + 1), **where
        )
    # Duas OS de amanhã sem técnico.
    for hour in (9, 14):
        await add_ticket(db, world, assignee_id=None, scheduled_start=at(tomorrow, hour))
    # O técnico chegou atrasado duas vezes no mês (OS abertas antes: não pesam na reincidência).
    for days in (3, 10):
        due = NOW - timedelta(days=days)
        await add_ticket(
            db,
            world,
            status=S.CLOSED,
            created_at=NOW - timedelta(days=45),
            arrival_due_at=due,
            arrived_at=due + timedelta(minutes=45),
            resolved_at=due + timedelta(hours=2),
        )
    # Tipo de serviço que leva o dobro do previsto (3 OS concluídas com 2 h).
    kind = ServiceType(name="Instalação de rack", estimated_minutes=60)
    db.add(kind)
    await db.flush()
    for _ in range(3):
        await add_ticket(
            db,
            world,
            status=S.CLOSED,
            service_type_id=kind.id,
            work_seconds=7200,
            resolved_at=NOW - timedelta(days=40),
            created_at=NOW - timedelta(days=41),
        )
    await db.commit()

    found = {s["key"]: s for s in (await overview(client, world))["suggestions"]}
    assert set(found) == {
        "tomorrow_unassigned",
        "late_technician",
        "recurrence",
        "top_customer",
        "slow_service_type",
    }
    assert found["tomorrow_unassigned"]["title"] == "2 OS de amanhã ainda estão sem técnico"
    assert found["tomorrow_unassigned"]["filters"] == {
        "scheduled_from": tomorrow.isoformat(),
        "scheduled_to": tomorrow.isoformat(),
        "unassigned": True,
        "open_only": True,
    }
    late = found["late_technician"]
    assert late["title"] == "Tecnico chegou atrasado em 2 OS nos últimos 30 dias"
    assert late["filters"]["assignee_id"] == str(world.tech.user.id)
    assert found["recurrence"]["title"] == (
        "Ótica Imaginária Centro teve 3 OS em 30 dias: vale uma visita preventiva"
    )
    assert found["recurrence"]["filters"] == {
        "location_id": str(store.id),
        "created_from": (TODAY - timedelta(days=29)).isoformat(),
    }
    assert "Rede Fictícia de Óticas · Campinas" in found["recurrence"]["detail"]
    # O cliente padrão tem as 2 de amanhã; o das óticas, as 3 reincidentes.
    assert found["top_customer"]["title"] == "Rede Fictícia de Óticas concentra 3 OS em aberto"
    assert found["top_customer"]["filters"] == {"customer_id": str(customer.id), "open_only": True}
    slow = found["slow_service_type"]
    assert slow["title"] == "Instalação de rack leva 2h e a estimativa é 1h"
    assert slow["link"] == "/tipos-servico" and slow["filters"] is None
    assert "3 OS concluídas" in slow["detail"]


def test_list_filters_only_present_keys() -> None:
    assert ListFilters().model_dump() == {}
    assert ListFilters(open_only=True, tag=["Projeto"]).model_dump(mode="json") == {
        "tag": ["Projeto"],
        "open_only": True,
    }


def test_home_texts() -> None:
    assert home.span_text(timedelta(minutes=0)) == "1 min"
    assert home.span_text(timedelta(minutes=80)) == "1 h 20 min"
    assert home.span_text(timedelta(hours=14, minutes=5)) == "14 h"
    assert home.span_text(timedelta(days=1, hours=3)) == "1 dia"
    assert home.span_text(timedelta(days=12)) == "12 dias"
    assert home.money_text(Decimal("1234.5")) == "R$ 1.234,50"
    assert home.duration_text(130) == "2h10" and home.duration_text(45) == "45 min"
    assert home.quantity_text(Decimal("2.500"), "m") == "2,5 m"


# =========================================================================== busca: leitura


def parse(q: str) -> smart_search.Parsed:
    return read_query(q, TODAY)


def period(p: smart_search.Period | None) -> tuple[str, str] | None:
    return (p.start.isoformat(), p.end.isoformat()) if p else None


@pytest.mark.parametrize(
    ("q", "created", "scheduled"),
    [
        ("hoje", None, ("2026-11-17", "2026-11-17")),
        ("ontem", ("2026-11-16", "2026-11-16"), None),
        ("amanhã", None, ("2026-11-18", "2026-11-18")),
        ("depois de amanhã", None, ("2026-11-19", "2026-11-19")),
        ("esta semana", None, ("2026-11-16", "2026-11-22")),
        ("semana passada", ("2026-11-09", "2026-11-15"), None),
        ("próxima semana", None, ("2026-11-23", "2026-11-29")),
        ("este mês", ("2026-11-01", "2026-11-30"), None),
        ("mês passado", ("2026-10-01", "2026-10-31"), None),
        ("novembro", ("2026-11-01", "2026-11-30"), None),
        ("dezembro", ("2025-12-01", "2025-12-31"), None),
        ("agendadas para dezembro", None, ("2026-12-01", "2026-12-31")),
        ("nov/2025", ("2025-11-01", "2025-11-30"), None),
        ("nov/25", ("2025-11-01", "2025-11-30"), None),
        ("novembro de 2024", ("2024-11-01", "2024-11-30"), None),
        ("11/2023", ("2023-11-01", "2023-11-30"), None),
        ("em março", ("2026-03-01", "2026-03-31"), None),
        ("março de 2022", ("2022-03-01", "2022-03-31"), None),
        ("criadas em 2024", ("2024-01-01", "2024-12-31"), None),
        ("em 2022", ("2022-01-01", "2022-12-31"), None),
        ("de 2022 a 2023", ("2022-01-01", "2023-12-31"), None),
        ("12/11", ("2026-11-12", "2026-11-12"), None),
        ("12/11/2025", ("2025-11-12", "2025-11-12"), None),
        ("12-11-2025", ("2025-11-12", "2025-11-12"), None),
        ("2025-11-12", ("2025-11-12", "2025-11-12"), None),
        ("12 de novembro de 2025", ("2025-11-12", "2025-11-12"), None),
        ("20/11", None, ("2026-11-20", "2026-11-20")),
        ("de 01/11 a 15/11", ("2026-11-01", "2026-11-15"), None),
        ("entre 28/12 e 05/01/2026", ("2025-12-28", "2026-01-05"), None),
        ("01/11/2025 - 15/11/2025", ("2025-11-01", "2025-11-15"), None),
        ("últimos 7 dias", ("2026-11-11", "2026-11-17"), None),
        ("ultimos 30 dias", ("2026-10-19", "2026-11-17"), None),
        ("próximos 7 dias", None, ("2026-11-17", "2026-11-23")),
        ("criadas hoje", ("2026-11-17", "2026-11-17"), None),
        ("abertas ontem", ("2026-11-16", "2026-11-16"), None),
        ("aberta em 12/11", ("2026-11-12", "2026-11-12"), None),
        ("agendadas amanhã", None, ("2026-11-18", "2026-11-18")),
        ("visita 20/11", None, ("2026-11-20", "2026-11-20")),
        ("para semana passada", None, ("2026-11-09", "2026-11-15")),
        (
            "criadas em outubro agendadas para novembro",
            ("2026-10-01", "2026-10-31"),
            ("2026-11-01", "2026-11-30"),
        ),
    ],
)
def test_periods(q: str, created: tuple | None, scheduled: tuple | None) -> None:
    p = parse(q)
    assert (period(p.created), period(p.scheduled)) == (created, scheduled)
    # A palavra que diz o campo não vira status nem texto.
    assert not p.status and not p.flags
    assert [w.text for w in p.content()] == []
    expected = (created is not None) + (scheduled is not None)
    assert [c.kind for _, c in p.chips] == ["period"] * expected


def test_period_labels_and_odd_dates() -> None:
    assert [c.label for _, c in parse("nov/2025").chips] == ["Criadas: novembro de 2025"]
    assert [c.label for _, c in parse("agendadas amanhã").chips] == ["Agendadas: amanhã"]
    assert [c.label for _, c in parse("de 01/11 a 15/11").chips] == [
        "Criadas: 01/11/2026 a 15/11/2026"
    ]
    # Data impossível, ano fora do intervalo e "março" sozinho (pode ser nome) não são período.
    for q in ("31/02", "12/11/1890", "março", "loja 2015"):
        p = parse(q)
        assert p.created is None and p.scheduled is None, q
    # Número sozinho é o nº da OS, não o ano.
    assert parse("2024").number == 2024 and parse("2024").created is None


@pytest.mark.parametrize(
    ("q", "status", "flags"),
    [
        ("abertas", [], {"open_only"}),
        ("em aberto", [], {"open_only"}),
        ("atrasadas", [], {"sla_breached"}),
        ("vencidas", [], {"sla_breached"}),
        ("estouradas", [], {"sla_breached"}),
        ("fora do SLA", [], {"sla_breached"}),
        ("em campo", ["en_route", "in_progress"], set()),
        ("em deslocamento", ["en_route"], set()),
        ("a caminho", ["en_route"], set()),
        ("em atendimento", ["in_progress"], set()),
        ("em execução", ["in_progress"], set()),
        ("concluídas", ["resolved", "closed"], set()),
        ("encerradas", ["resolved", "closed"], set()),
        ("fechadas", ["resolved", "closed"], set()),
        ("canceladas", ["cancelled"], set()),
        ("sem técnico", [], {"unassigned", "open_only"}),
        ("sem agenda", [], {"unscheduled", "open_only"}),
        ("improdutivas", [], {"unproductive"}),
        ("pendentes", ["on_hold_customer", "on_hold_vendor"], set()),
        ("aguardando cliente", ["on_hold_customer"], set()),
        ("agendadas", ["scheduled"], set()),
        ("reabertas", ["reopened"], set()),
        ("sem analista", [], {"no_owner", "open_only"}),
        ("justificar SLA", [], {"violation_pending"}),
        ("em campo ou em atendimento", ["en_route", "in_progress"], set()),
    ],
)
def test_statuses(q: str, status: list[str], flags: set[str]) -> None:
    p = parse(q)
    assert [s.value for s in p.status] == status
    assert set(p.flags) == flags
    assert [c.kind for _, c in p.chips] == ["status"] * len({c.label for _, c in p.chips})
    assert p.content() == []


def test_numbers_and_documents() -> None:
    for q in ("OS 16976", "os-016976", "OS-016976", "#16976", "os016976", "nº 16976"):
        p = parse(q)
        assert (p.number, p.number_explicit) == (16976, True), q
        assert [c.label for _, c in p.chips] == ["OS-016976"]
    lone = parse(" 016976 ")
    assert (lone.number, lone.number_explicit) == (16976, False)
    assert parse("99999999999").number is None  # 11 dígitos: CPF, não OS
    assert parse("os 12/11").number is None  # "as OS de 12/11"
    cnpj = cnpj_with_check_digits("112223330001")
    formatted = f"{cnpj[:2]}.{cnpj[2:5]}.{cnpj[5:8]}/{cnpj[8:12]}-{cnpj[12:]}"
    assert parse(formatted).document == cnpj and parse(cnpj).document == cnpj
    alnum = cnpj_with_check_digits("12ABC34501DE")
    pretty = f"{alnum[:2]}.{alnum[2:5]}.{alnum[5:8]}/{alnum[8:12]}-{alnum[12:]}".lower()
    assert parse(pretty).document == alnum
    assert parse("123.456.789-09").document == "12345678909"
    assert parse("manutencao2025").document is None  # 14 letras e números, não é CNPJ


def test_odd_input_never_breaks_the_reader() -> None:
    for q in ("", "   ", "!!!", "\x00\x01", "%_%", "'; drop table tickets; --", "ç" * 500, "😀"):
        p = parse(q)
        assert len(p.query) <= smart_search.MAX_QUERY
    assert parse("x" * 500).query == "x" * smart_search.MAX_QUERY


def test_name_matching_rules() -> None:
    words = smart_search.name_words("O Relicário Fictício")
    assert words == ("relicario", "ficticio")
    assert smart_search.score(["relicario"], words) == 2
    assert smart_search.score(["ficticio", "relicario"], words) == 3
    assert smart_search.score(["relic"], words) == 1
    assert smart_search.score(["re"], words) == 0
    assert smart_search.close("relicaro", "relicario")
    assert smart_search.close("relciario", "relicario")
    assert not smart_search.close("relio", "relicario")
    assert smart_search.accent_regex("acao") == "[aáàâãäAÁÀÂÃÄ][cçCÇ][aáàâãäAÁÀÂÃÄ][oóòôõöOÓÒÔÕÖ]"


# =========================================================================== busca: banco


@dataclass
class Data:
    relicario: Customer
    padaria: Customer
    aurora: Location
    centro: Location
    estrela: Location
    joao: User
    joao_old: User
    marina: User
    joana: User
    t: dict[str, Ticket]


def tag(name: str) -> dict[str, str]:
    return {"name": name, "color": "#123456"}


async def build(db: AsyncSession, world: World) -> Data:
    """Dois clientes inventados com lojas, quatro técnicos (um inativo) e OS de vários anos."""
    relicario = Customer(
        name="O Relicário Fictício", document=cnpj_with_check_digits("112223330001")
    )
    padaria = Customer(
        name="Padaria Estrela Imaginária", document=cnpj_with_check_digits("12ABC34501DE")
    )
    db.add_all([relicario, padaria])
    await db.flush()
    aurora = Location(
        customer_id=relicario.id,
        name="Relicário Shopping Aurora",
        code="0041",
        city="Campinas",
        document=cnpj_with_check_digits("112223330002"),
    )
    centro = Location(
        customer_id=relicario.id, name="Relicário Centro Velho", code="0042", city="São Paulo"
    )
    estrela = Location(
        customer_id=padaria.id, name="Estrela Matriz", code="77", city="Ribeirão Preto"
    )
    db.add_all([aurora, centro, estrela])
    joao = await add_user(db, "João Arcanjo Teste", UserRole.TECHNICIAN)
    joao_old = await add_user(db, "João Velho Teste", UserRole.TECHNICIAN, active=False)
    marina = await add_user(db, "Marina Quimera", UserRole.TECHNICIAN)
    joana = await add_user(db, "Joana Fictícia", UserRole.TECHNICIAN)
    rel = {"customer_id": relicario.id, "owner_id": world.analyst.user.id}
    t: dict[str, Ticket] = {}
    t["impressao"] = await add_ticket(
        db,
        world,
        **rel,
        location_id=aurora.id,
        title="Impressão falhando no caixa",
        assignee_id=joao.id,
        scheduled_start=at(TODAY, 10),
        created_at=at(date(2026, 11, 10), 9),
        tags=[tag("Ticket Avulso"), tag("Pendente Envio PGTO")],
    )
    t["camera_2022"] = await add_ticket(
        db,
        world,
        **rel,
        location_id=centro.id,
        title="Câmera sem imagem",
        status=S.CLOSED,
        assignee_id=marina.id,
        scheduled_start=at(date(2022, 3, 15), 14),
        created_at=at(date(2022, 3, 15), 8),
        resolved_at=at(date(2022, 3, 16), 9),
        tags=[tag("Ticket Contratual")],
    )
    t["nobreak"] = await add_ticket(
        db,
        world,
        customer_id=padaria.id,
        location_id=estrela.id,
        title="Troca de nobreak",
        status=S.NEW,
        assignee_id=None,
        scheduled_start=None,
        priority=TicketPriority.CRITICAL,
        created_at=at(date(2026, 11, 16), 11),
        tags=[tag("Custo Extra"), tag("Ticket Avulso")],
    )
    t["lenta"] = await add_ticket(
        db,
        world,
        **rel,
        location_id=aurora.id,
        title="Internet lenta no estoque",
        status=S.EN_ROUTE,
        assignee_id=marina.id,
        scheduled_start=at(TODAY, 13),
        created_at=at(TODAY, 8),
        resolution_due_at=NOW - timedelta(hours=1),
        tags=[tag("Pendente Envio PGTO")],
    )
    t["rack"] = await add_ticket(
        db,
        world,
        title="Organizar rack",
        status=S.ASSIGNED,
        assignee_id=joana.id,
        scheduled_start=None,
        created_at=at(date(2026, 11, 1), 10),
        last_unproductive_at=at(date(2026, 11, 12), 10),
        unproductive_count=1,
        tags=[tag("Ticket Avulso")],
    )
    t["projeto_2024"] = await add_ticket(
        db,
        world,
        title="Implantação antiga",
        status=S.CLOSED,
        scheduled_start=at(date(2024, 11, 12), 9),
        created_at=at(date(2024, 11, 12), 8),
        resolved_at=at(date(2024, 11, 13), 8),
        tags=[tag("Projeto"), tag("Layout Experimental"), tag("Pendente Envio PGTO")],
    )
    t["espera"] = await add_ticket(
        db,
        world,
        title="Aguardando peça",
        status=S.ON_HOLD_VENDOR,
        created_at=at(date(2026, 11, 5), 9),
    )
    t["cancelada"] = await add_ticket(
        db,
        world,
        title="Cancelada pelo cliente",
        status=S.CANCELLED,
        created_at=at(date(2026, 10, 20), 9),
    )
    t["semana_que_vem"] = await add_ticket(
        db,
        world,
        **rel,
        location_id=centro.id,
        title="Preventiva mensal",
        assignee_id=joao.id,
        scheduled_start=at(date(2026, 11, 24), 9),
        created_at=at(TODAY, 9),
    )
    # Técnico que atuou: já foi responsável (atribuição feita aqui, guarda o id)...
    t["passou_por_joao_velho"] = await add_ticket(
        db,
        world,
        title="Troca de técnico",
        assignee_id=marina.id,
        created_at=at(date(2025, 6, 2), 9),
    )
    # ... atribuição importada do Field Control (guarda o nome)...
    t["importada"] = await add_ticket(
        db,
        world,
        title="OS importada",
        status=S.CLOSED,
        assignee_id=None,
        created_at=at(date(2023, 5, 5), 9),
        resolved_at=at(date(2023, 5, 6), 9),
        tags=[tag("Ticket Contratual")],
    )
    # ... outro técnico da visita agora, e um que já foi outro técnico da visita.
    t["ajudante"] = await add_ticket(
        db,
        world,
        title="Visita em dupla",
        assignee_id=marina.id,
        created_at=at(date(2026, 9, 1), 9),
    )
    t["ex_ajudante"] = await add_ticket(
        db,
        world,
        title="Dupla antiga",
        assignee_id=marina.id,
        created_at=at(date(2025, 2, 1), 9),
        tags=[tag("Ticket Contratual")],
    )
    db.add_all(
        [
            TicketEvent(
                ticket_id=t["passou_por_joao_velho"].id,
                event_type=TicketEventType.ASSIGNED,
                from_value=None,
                to_value=str(joao_old.id),
                data={"from_name": None, "to_name": joao_old.name},
            ),
            TicketEvent(
                ticket_id=t["passou_por_joao_velho"].id,
                event_type=TicketEventType.ASSIGNED,
                from_value=str(joao_old.id),
                to_value=str(marina.id),
                data={"from_name": joao_old.name, "to_name": marina.name},
            ),
            TicketEvent(
                ticket_id=t["importada"].id,
                event_type=TicketEventType.ASSIGNED,
                to_value=joao_old.name,
                data={"source": "fieldcontrol", "task": "abc"},
            ),
            TicketEvent(
                ticket_id=t["ex_ajudante"].id,
                event_type=TicketEventType.HELPERS_CHANGED,
                data={"added": [joana.name], "removed": [], "added_ids": [str(joana.id)]},
            ),
        ]
    )
    await db.execute(insert(ticket_helpers).values(ticket_id=t["ajudante"].id, user_id=joana.id))
    await db.commit()
    return Data(relicario, padaria, aurora, centro, estrela, joao, joao_old, marina, joana, t)


@pytest.fixture
async def data(db: AsyncSession, world: World, frozen: None) -> Data:
    return await build(db, world)


async def search(client: AsyncClient, world: World, q: str, **params: object) -> dict:
    r = await client.get(
        f"{API}/search/smart", params={"q": q, **params}, headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    return r.json()


def titles(result: dict) -> set[str]:
    return {t["title"] for t in result["tickets"]}


def chips(result: dict) -> list[tuple[str, str]]:
    return [(c["kind"], c["label"]) for c in result["chips"]]


@requires_db
async def test_search_is_for_ticket_managers_only(client: AsyncClient, world: World) -> None:
    url = f"{API}/search/smart"
    assert (await client.get(url, params={"q": "x"})).status_code == 401
    for actor in (world.tech, world.requester):
        assert (await client.get(url, params={"q": "x"}, headers=actor.headers)).status_code == 403
    for actor in (world.analyst, world.supervisor, world.admin):
        assert (await client.get(url, params={"q": "x"}, headers=actor.headers)).status_code == 200
    too_many = await client.get(url, params={"q": "x", "limit": 99}, headers=world.admin.headers)
    assert too_many.status_code == 422


@requires_db
async def test_search_empty_and_odd_input(client: AsyncClient, world: World, data: Data) -> None:
    empty = await search(client, world, "")
    assert empty == {
        "query": "",
        "chips": [],
        "filters": None,
        "total": 0,
        "tickets": [],
        "customers": [],
        "locations": [],
        "technicians": [],
    }
    assert (await search(client, world, "   "))["filters"] is None
    for q in (
        "!!!",
        "\x00abc",
        "%_%",
        "'; drop table tickets; --",
        "a" * 500,
        "😀 ção",
        "99999999999999999999",
        "os",
        "de da do",
        "31/02",
        "(.*)+$",
        "[[[",
    ):
        r = await client.get(f"{API}/search/smart", params={"q": q}, headers=world.analyst.headers)
        assert r.status_code == 200, (q, r.text)
    assert (await search(client, world, "de da do"))["filters"] is None


@requires_db
async def test_search_by_number(client: AsyncClient, world: World, data: Data) -> None:
    target = data.t["nobreak"]
    code = f"OS-{target.number:06d}"
    n = target.number
    for q in (str(n), f"OS {n}", f"os-{n:06d}", f"#{n}", f"OS-{n:06d}"):
        r = await search(client, world, q)
        assert r["filters"] == {"number": target.number}, q
        assert r["total"] == 1 and r["tickets"][0]["id"] == str(target.id)
        assert chips(r) == [("number", code)]
        first = r["tickets"][0]
        assert (first["customer"], first["location"], first["city"]) == (
            "Padaria Estrela Imaginária",
            "Estrela Matriz",
            "Ribeirão Preto",
        )
        assert first["status"] == "new" and first["technician"] is None
        assert [t["name"] for t in first["tags"]] == ["Custo Extra", "Ticket Avulso"]
    # Sem OS com o número: o código da loja ("0041" e "77").
    store = await search(client, world, "41")
    assert store["filters"] == {"location_id": str(data.aurora.id)}
    assert chips(store) == [("location", "Relicário Shopping Aurora (0041)")]
    assert titles(store) == {"Impressão falhando no caixa", "Internet lenta no estoque"}
    assert store["customers"][0]["id"] == str(data.relicario.id)
    assert (await search(client, world, "loja 77"))["filters"] == {
        "location_id": str(data.estrela.id)
    }
    # "OS 77" é sempre o número (não existe: nenhuma OS).
    missing = await search(client, world, "OS 77")
    assert missing["filters"] == {"number": 77} and missing["total"] == 0


@requires_db
async def test_search_by_document(client: AsyncClient, world: World, data: Data) -> None:
    doc = data.relicario.document
    pretty = f"{doc[:2]}.{doc[2:5]}.{doc[5:8]}/{doc[8:12]}-{doc[12:]}"
    for q in (doc, pretty):
        r = await search(client, world, q)
        assert r["filters"] == {"customer_id": str(data.relicario.id)}
        assert chips(r) == [("customer", "O Relicário Fictício")]
        assert r["customers"][0]["document"] == doc
    alnum = data.padaria.document
    pretty = f"{alnum[:2]}.{alnum[2:5]}.{alnum[5:8]}/{alnum[8:12]}-{alnum[12:]}".lower()
    r = await search(client, world, pretty)
    assert r["filters"] == {"customer_id": str(data.padaria.id)}
    branch = await search(client, world, data.aurora.document)
    assert branch["filters"] == {"location_id": str(data.aurora.id)}
    unknown = await search(client, world, "98.765.432/0001-10")
    assert unknown["filters"] == {"q": "98765432000110"} and unknown["total"] == 0


@requires_db
async def test_search_by_status(client: AsyncClient, world: World, data: Data) -> None:
    open_ = await search(client, world, "abertas", limit=20)
    assert open_["filters"] == {"open_only": True}
    assert "Câmera sem imagem" not in titles(open_) and "Troca de nobreak" in titles(open_)
    late = await search(client, world, "atrasadas")
    assert late["filters"] == {"sla_breached": True}
    assert titles(late) == {"Internet lenta no estoque"}
    field = await search(client, world, "em campo")
    assert field["filters"] == {"status": ["en_route", "in_progress"]}
    assert titles(field) == {"Internet lenta no estoque"}
    assert titles(await search(client, world, "a caminho")) == {"Internet lenta no estoque"}
    done = await search(client, world, "concluídas", limit=20)
    assert done["filters"] == {"status": ["resolved", "closed"]}
    assert "Câmera sem imagem" in titles(done) and "Implantação antiga" in titles(done)
    assert titles(await search(client, world, "canceladas")) == {"Cancelada pelo cliente"}
    assert titles(await search(client, world, "pendentes")) == {"Aguardando peça"}
    unassigned = await search(client, world, "sem técnico")
    assert unassigned["filters"] == {"unassigned": True, "open_only": True}
    assert titles(unassigned) == {"Troca de nobreak"}
    # "Sem agenda" e "improdutivas" a lista ainda não filtra: o total já vem certo.
    no_date = await search(client, world, "sem agenda")
    assert no_date["filters"] == {"open_only": True}
    assert titles(no_date) == {"Troca de nobreak", "Organizar rack"}
    assert no_date["total"] == 2
    unproductive = await search(client, world, "improdutivas")
    assert unproductive["total"] == 1 and titles(unproductive) == {"Organizar rack"}
    scheduled = await search(client, world, "agendadas", limit=20)
    assert scheduled["filters"] == {"status": ["scheduled"]}
    urgent = await search(client, world, "urgentes")
    assert urgent["filters"] == {"priority": ["critical", "high"]}
    assert titles(urgent) == {"Troca de nobreak"}
    assert chips(urgent) == [("priority", "Urgentes (crítica e alta)")]


@requires_db
async def test_search_by_period_including_old_dates(
    client: AsyncClient, world: World, data: Data
) -> None:
    today = await search(client, world, "hoje")
    assert today["filters"] == {
        "scheduled_from": TODAY.isoformat(),
        "scheduled_to": TODAY.isoformat(),
    }
    # A agenda do dia em ordem de horário.
    assert [t["title"] for t in today["tickets"]] == [
        "Impressão falhando no caixa",
        "Internet lenta no estoque",
    ]
    assert titles(await search(client, world, "próxima semana")) == {"Preventiva mensal"}
    assert titles(await search(client, world, "criadas ontem")) == {"Troca de nobreak"}
    assert titles(await search(client, world, "mês passado")) == {"Cancelada pelo cliente"}
    for q in ("março de 2022", "15/03/2022", "de 01/03/2022 a 31/03/2022", "criadas em 2022"):
        r = await search(client, world, q)
        assert titles(r) == {"Câmera sem imagem"}, q
    old = await search(client, world, "novembro de 2024 projeto")
    assert titles(old) == {"Implantação antiga"}
    assert old["filters"] == {
        "tag": ["Projeto"],
        "created_from": "2024-11-01",
        "created_to": "2024-11-30",
    }


@requires_db
async def test_search_by_customer_location_city_and_typo(
    client: AsyncClient, world: World, data: Data
) -> None:
    r = await search(client, world, "relicario")
    assert r["filters"] == {"customer_id": str(data.relicario.id)}
    assert chips(r) == [("customer", "O Relicário Fictício")]
    assert r["total"] == 4
    assert r["customers"][0] == {
        "id": str(data.relicario.id),
        "name": "O Relicário Fictício",
        "document": data.relicario.document,
        "open_count": 3,
    }
    # As lojas com a palavra aparecem também (e o técnico nenhum).
    assert {loc["name"] for loc in r["locations"]} == {
        "Relicário Shopping Aurora",
        "Relicário Centro Velho",
    }
    assert r["technicians"] == []
    # Mais recentes primeiro (agenda ou abertura).
    assert r["tickets"][0]["title"] == "Preventiva mensal"
    assert r["tickets"][-1]["title"] == "Câmera sem imagem"

    assert (await search(client, world, "RELICÁRIO abertas"))["filters"] == {
        "customer_id": str(data.relicario.id),
        "open_only": True,
    }
    store = await search(client, world, "relicario aurora")
    assert store["filters"] == {"location_id": str(data.aurora.id)}
    assert store["customers"][0]["id"] == str(data.relicario.id)
    within = await search(client, world, "relicario centro velho em aberto")
    assert within["filters"] == {"location_id": str(data.centro.id), "open_only": True}
    assert titles(within) == {"Preventiva mensal"}
    bakery = await search(client, world, "padaria estrela")
    assert bakery["filters"] == {"customer_id": str(data.padaria.id)}
    typo = await search(client, world, "relicaro")
    assert typo["filters"] == {"customer_id": str(data.relicario.id)}

    city = await search(client, world, "campinas")
    assert chips(city) == [("city", "Campinas")]
    assert city["filters"] == {"q": "campinas"}
    assert titles(city) == {"Impressão falhando no caixa", "Internet lenta no estoque"}
    sp = await search(client, world, "são paulo abertas")
    assert sp["filters"] == {"q": "sao paulo", "open_only": True}
    assert titles(sp) == {"Preventiva mensal"}


@requires_db
async def test_search_by_technician_who_acted(
    client: AsyncClient, world: World, data: Data
) -> None:
    joao = await search(client, world, "joao")
    # Homônimo inativo: vale o único ativo.
    assert joao["filters"] == {"technician_id": str(data.joao.id)}
    assert chips(joao) == [("technician", "Técnico: João Arcanjo Teste")]
    assert titles(joao) == {"Impressão falhando no caixa", "Preventiva mensal"}
    assert {t["name"] for t in joao["technicians"]} == {"João Arcanjo Teste", "João Velho Teste"}
    # Sobrenome sozinho não escolhe o técnico (é palavra comum demais): vira texto, que ainda
    # acha as OS dele pelo nome do responsável.
    surname = await search(client, world, "arcanjo")
    assert surname["filters"] == {"q": "arcanjo"}
    assert titles(surname) == {"Impressão falhando no caixa", "Preventiva mensal"}
    assert surname["technicians"][0]["id"] == str(data.joao.id)
    assert joao["technicians"][0] == {
        "id": str(data.joao.id),
        "name": "João Arcanjo Teste",
        "city": None,
        "active": True,
    }
    # O inativo pelo nome inteiro: atribuído antes (id no histórico) e na OS importada (nome).
    old = await search(client, world, "técnico João Velho")
    assert old["filters"] == {"technician_id": str(data.joao_old.id)}
    assert titles(old) == {"Troca de técnico", "OS importada"}
    assert (await search(client, world, "do joao velho teste"))["filters"] == old["filters"]
    # Outro técnico da visita (agora ou antes).
    joana = await search(client, world, "joana")
    assert titles(joana) == {"Organizar rack", "Visita em dupla", "Dupla antiga"}
    marina = await search(client, world, "tecnico marina concluídas")
    assert marina["filters"] == {
        "status": ["resolved", "closed"],
        "technician_id": str(data.marina.id),
    }
    assert titles(marina) == {"Câmera sem imagem"}


@requires_db
async def test_search_by_tag(client: AsyncClient, world: World, data: Data) -> None:
    pgto = await search(client, world, "pendente pgto")
    assert pgto["filters"] == {"tag": ["Pendente Envio PGTO"]}
    assert chips(pgto) == [("tag", "Pendente Envio PGTO")]
    assert titles(pgto) == {
        "Impressão falhando no caixa",
        "Internet lenta no estoque",
        "Implantação antiga",
    }
    assert (await search(client, world, "avulso"))["filters"] == {"tag": ["Ticket Avulso"]}
    loose = await search(client, world, "avulso abertas")
    assert loose["filters"] == {"tag": ["Ticket Avulso"], "open_only": True}
    assert titles(loose) == {"Impressão falhando no caixa", "Troca de nobreak", "Organizar rack"}
    assert (await search(client, world, "custo extra"))["filters"] == {"tag": ["Custo Extra"]}
    assert (await search(client, world, "projeto"))["filters"] == {"tag": ["Projeto"]}
    contract = await search(client, world, "contratual")
    assert contract["filters"] == {"tag": ["Ticket Contratual"]} and contract["total"] == 3
    # Etiqueta rara não é escolhida por uma palavra solta, só pela frase inteira.
    assert (await search(client, world, "experimental"))["filters"] == {"q": "experimental"}
    assert (await search(client, world, "layout experimental"))["filters"] == {
        "tag": ["Layout Experimental"]
    }


@requires_db
async def test_search_free_text(client: AsyncClient, world: World, data: Data) -> None:
    # Sem acento acha com acento (título), e o texto vai para a lista em `q`.
    r = await search(client, world, "impressao")
    assert r["filters"] == {"q": "impressao"} and titles(r) == {"Impressão falhando no caixa"}
    assert chips(r) == [("text", "impressao")]
    accented = await search(client, world, "câmera")
    assert titles(accented) == {"Câmera sem imagem"} and chips(accented) == [("text", "câmera")]
    # Texto + cliente + status juntos.
    mixed = await search(client, world, "relicario internet abertas")
    assert mixed["filters"] == {
        "customer_id": str(data.relicario.id),
        "q": "internet",
        "open_only": True,
    }
    assert titles(mixed) == {"Internet lenta no estoque"}
    none = await search(client, world, "parafuso inexistente")
    assert none["total"] == 0 and none["filters"] == {"q": "parafuso inexistente"}
    # Na loja (nome) e no cliente também, como a busca da lista.
    assert titles(await search(client, world, "estoque")) == {"Internet lenta no estoque"}
    assert "Troca de nobreak" in titles(await search(client, world, "imaginaria nobreak"))


@requires_db
async def test_search_limit_and_total(client: AsyncClient, world: World, data: Data) -> None:
    r = await search(client, world, "abertas", limit=2)
    assert len(r["tickets"]) == 2 and r["total"] > 2
    joao = await search(client, world, "joao", limit=1)
    assert len(joao["technicians"]) == 1 and joao["technicians"][0]["id"] == str(data.joao.id)

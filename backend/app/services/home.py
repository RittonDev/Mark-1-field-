"""Tela inicial da gestão: indicadores do dia, pontos de atenção das OS e sugestões.

Uma varredura das OS conta todos os grupos e indicadores (FILTER no banco); cada grupo com
alguma OS traz até 5 exemplos, já com cliente, loja e técnico na mesma consulta. "Hoje" e os
dias da semana seguem o fuso da operação (America/Sao_Paulo).
"""

import uuid
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import settings
from app.core.enums import (
    ExpenseKind,
    ExpenseStatus,
    PartRequestStatus,
    PayoutStatus,
    QuoteStatus,
    TicketSource,
    TicketStatus,
    UserRole,
)
from app.db.base import utcnow
from app.models import (
    Customer,
    Location,
    Quote,
    ServiceType,
    Ticket,
    TicketExpense,
    TicketPartRequest,
    TicketPayout,
    User,
)
from app.schemas.home import (
    AttentionGroup,
    AttentionItem,
    HomeKpis,
    HomeOverview,
    ListFilters,
    Suggestion,
    WeekDay,
)
from app.services import durations
from app.services import portal as portal_svc
from app.services.activities import day_bounds, local_today
from app.services.tickets import breached_clause, orphan_owner_ids, violation_pending_clause
from app.services.workflow import OPEN_STATUSES, STATUS_INFO

S = TicketStatus
ITEMS = 5
MAX_SUGGESTIONS = 6
FIELD = (S.EN_ROUTE, S.IN_PROGRESS)
DONE = (S.RESOLVED, S.CLOSED)
FINISHED = (S.RESOLVED, S.CLOSED, S.CANCELLED)
# Visita do dia que ainda não começou (nem saiu para o local).
NOT_STARTED = (S.NEW, S.TRIAGE, S.ASSIGNED, S.SCHEDULED, S.REOPENED)
# Com técnico definido e sem chegada registrada.
ARRIVAL_PENDING = (S.ASSIGNED, S.SCHEDULED, S.EN_ROUTE)
# Estados em que a OS precisa de uma data de visita.
NEEDS_SCHEDULE = (S.NEW, S.TRIAGE, S.ASSIGNED, S.REOPENED)

START_TOLERANCE = timedelta(minutes=30)
UNASSIGNED_HORIZON = timedelta(hours=48)
UNASSIGNED_AGE = timedelta(hours=24)
STALE_AFTER = timedelta(days=3)
PAYOUT_LATE = timedelta(days=7)
QUOTE_WAIT = timedelta(days=3)
RECENT_DAYS = 30
WEEK_DAYS = 7
RECURRENCE_MIN = 3
TOP_CUSTOMER_MIN = 3
LATE_TECH_MIN = 2
SLOW_RATIO = 1.3
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}

EXPENSE_LABELS = {
    ExpenseKind.MATERIAL: "Material",
    ExpenseKind.KM: "Km rodado",
    ExpenseKind.TOLL: "Pedágio",
    ExpenseKind.PARKING: "Estacionamento",
    ExpenseKind.TRANSPORT: "Transporte",
    ExpenseKind.MEAL: "Alimentação",
    ExpenseKind.OTHER: "Outro custo",
}


@dataclass(frozen=True)
class Moment:
    now: datetime
    today: date
    day_start: datetime
    day_end: datetime

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(settings.TIMEZONE)

    def days_ago(self, days: int) -> datetime:
        """Começo do dia `days` dias atrás (no fuso da operação)."""
        return day_bounds(self.today - timedelta(days=days))[0]


def _moment() -> Moment:
    now = utcnow()
    today = local_today()
    start, end = day_bounds(today)
    return Moment(now=now, today=today, day_start=start, day_end=end)


# --------------------------------------------------------------------------- textos


def span_text(delta: timedelta) -> str:
    """Tempo corrido curto: "5 min", "1 h 20 min", "14 h", "3 dias"."""
    minutes = max(0, int(delta.total_seconds() // 60))
    if minutes < 60:
        return f"{max(minutes, 1)} min"
    hours, rest = divmod(minutes, 60)
    if hours < 24:
        return f"{hours} h {rest} min" if rest and hours < 10 else f"{hours} h"
    days = hours // 24
    return "1 dia" if days == 1 else f"{days} dias"


def duration_text(minutes: float) -> str:
    """Duração de serviço: "45 min", "1h", "2h10"."""
    total = round(minutes)
    if total < 60:
        return f"{total} min"
    hours, rest = divmod(total, 60)
    return f"{hours}h{rest:02d}" if rest else f"{hours}h"


def money_text(value: Decimal | float | int | None) -> str:
    """R$ 1.234,56"""
    text = f"{Decimal(value or 0):,.2f}"
    return "R$ " + text.replace(",", "_").replace(".", ",").replace("_", ".")


def quantity_text(value: Decimal | None, unit: str | None) -> str:
    number = Decimal(value or 0).normalize()
    text = f"{number:f}".replace(".", ",")
    return f"{text} {unit or 'un'}".strip()


def plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _local(value: datetime, m: Moment) -> datetime:
    return value.astimezone(m.tz)


def _hm(value: datetime, m: Moment) -> str:
    return _local(value, m).strftime("%H:%M")


def _dm(value: datetime, m: Moment) -> str:
    return _local(value, m).strftime("%d/%m")


def _when_text(value: datetime, m: Moment) -> str:
    """ "hoje às 14:00", "amanhã às 09:00" ou "18/11 às 09:00"."""
    day = _local(value, m).date()
    if day == m.today:
        prefix = "hoje"
    elif day == m.today + timedelta(days=1):
        prefix = "amanhã"
    elif day == m.today - timedelta(days=1):
        prefix = "ontem"
    else:
        prefix = _dm(value, m)
    return f"{prefix} às {_hm(value, m)}"


# --------------------------------------------------------------------------- condições


def _open() -> ColumnElement[bool]:
    return Ticket.status.in_(OPEN_STATUSES)


def _technicians() -> Select[tuple[uuid.UUID]]:
    return select(User.id).where(User.role == UserRole.TECHNICIAN)


def late_arrival_clause(m: Moment) -> ColumnElement[bool]:
    """Técnico definido, prazo de chegada vencido e ninguém chegou."""
    return and_(
        Ticket.status.in_(ARRIVAL_PENDING),
        Ticket.assignee_id.is_not(None),
        Ticket.arrival_due_at < m.now,
        Ticket.arrived_at.is_(None),
    )


def today_not_started_clause(m: Moment) -> ColumnElement[bool]:
    """Visita de hoje cujo horário passou há 30 min ou mais sem sair nem começar."""
    return and_(
        Ticket.status.in_(NOT_STARTED),
        Ticket.scheduled_start >= m.day_start,
        Ticket.scheduled_start < m.day_end,
        Ticket.scheduled_start <= m.now - START_TOLERANCE,
    )


def unassigned_soon_clause(m: Moment) -> ColumnElement[bool]:
    """Em aberto sem técnico com visita nas próximas 48 h (ou já passada) ou aberta há 24 h+."""
    return and_(
        _open(),
        Ticket.assignee_id.is_(None),
        or_(
            Ticket.scheduled_start <= m.now + UNASSIGNED_HORIZON,
            Ticket.created_at < m.now - UNASSIGNED_AGE,
        ),
    )


def unproductive_pending_clause() -> ColumnElement[bool]:
    """Última visita improdutiva e sem data nova depois dela (a mesma regra da Minha fila)."""
    return and_(
        _open(),
        Ticket.status.not_in(FIELD),
        Ticket.last_unproductive_at.is_not(None),
        or_(
            Ticket.scheduled_start.is_(None),
            Ticket.scheduled_start < Ticket.last_unproductive_at,
        ),
    )


def no_schedule_clause() -> ColumnElement[bool]:
    """Técnico definido e sem data de visita (as improdutivas ficam no grupo delas)."""
    return and_(
        Ticket.status.in_(NEEDS_SCHEDULE),
        Ticket.scheduled_start.is_(None),
        Ticket.last_unproductive_at.is_(None),
        Ticket.assignee_id.in_(_technicians()),
    )


def stale_clause(m: Moment) -> ColumnElement[bool]:
    return and_(_open(), Ticket.updated_at < m.now - STALE_AFTER)


def no_owner_clause() -> ColumnElement[bool]:
    """Sem analista responsável (ou com um que saiu da gestão), como o filtro da lista."""
    return and_(_open(), or_(Ticket.owner_id.is_(None), Ticket.owner_id.in_(orphan_owner_ids())))


def portal_clause() -> ColumnElement[bool]:
    """Solicitações do portal esperando a central (a mesma regra de /portal/inbox-count)."""
    return and_(Ticket.source == TicketSource.PORTAL, Ticket.status.in_(portal_svc.CANCELLABLE))


# --------------------------------------------------------------------------- exemplos (itens)

_TECH = aliased(User, name="item_technician")
_ROW_COLUMNS = (
    Ticket.id,
    Ticket.number,
    Ticket.title,
    Ticket.status,
    Ticket.created_at,
    Ticket.updated_at,
    Ticket.scheduled_start,
    Ticket.arrival_due_at,
    Ticket.response_due_at,
    Ticket.resolution_due_at,
    Ticket.first_response_at,
    Ticket.resolved_at,
    Ticket.sla_paused_at,
    Ticket.last_unproductive_at,
    Ticket.unproductive_count,
    Ticket.owner_id,
    Ticket.response_violation_reason_id,
    Ticket.resolution_violation_reason_id,
    Customer.name.label("customer_name"),
    Location.name.label("location_name"),
)


def _ticket_select(*extra: Any) -> Select[Any]:
    """Colunas da OS + nomes (cliente, loja e técnico responsável) numa consulta só."""
    return (
        select(*_ROW_COLUMNS, _TECH.name.label("technician_name"), *extra)
        .outerjoin(Customer, Customer.id == Ticket.customer_id)
        .outerjoin(Location, Location.id == Ticket.location_id)
        .outerjoin(_TECH, _TECH.id == Ticket.assignee_id)
    )


def _item(
    row: Any, when: datetime | None, reason: str, technician: str | None = None
) -> AttentionItem:
    return AttentionItem(
        ticket_id=row.id,
        number=row.number,
        title=row.title,
        customer=row.customer_name,
        location=row.location_name,
        technician=technician if technician is not None else row.technician_name,
        when=when,
        reason=reason,
    )


Reason = Callable[[Any, Moment], tuple[datetime | None, str]]


async def _ticket_items(
    db: AsyncSession,
    m: Moment,
    cond: ColumnElement[bool],
    order: Sequence[Any],
    reason: Reason,
) -> list[AttentionItem]:
    rows = (await db.execute(_ticket_select().where(cond).order_by(*order).limit(ITEMS))).all()
    items = []
    for row in rows:
        when, text = reason(row, m)
        items.append(_item(row, when, text))
    return items


def _sla_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    clock = row.sla_paused_at or m.now
    paused = " (SLA pausado)" if row.sla_paused_at else ""
    if row.resolution_due_at is not None and clock > row.resolution_due_at:
        due = row.resolution_due_at
        return due, f"Prazo de solução estourado há {span_text(m.now - due)}{paused}"
    due = row.response_due_at
    late = span_text(m.now - due) if due else ""
    return due, f"1ª resposta estourada há {late}{paused}"


def _late_arrival_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    due = row.arrival_due_at
    label = STATUS_INFO[row.status].label
    return due, f"Chegada atrasada há {span_text(m.now - due)} · {label}"


def _not_started_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    start = row.scheduled_start
    return start, f"Agendada para {_hm(start, m)}, sem início há {span_text(m.now - start)}"


def _unassigned_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    start = row.scheduled_start
    if start is not None and start <= m.now + UNASSIGNED_HORIZON:
        if start < m.now:
            return start, f"Visita era {_when_text(start, m)} e segue sem técnico"
        return start, f"Visita {_when_text(start, m)} sem técnico"
    return row.created_at, f"Sem técnico há {span_text(m.now - row.created_at)}"


def _unproductive_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    at = row.last_unproductive_at
    text = f"Improdutiva em {_dm(at, m)}: falta reagendar"
    count = row.unproductive_count or 0
    if count > 1:
        text += f" ({count} visitas improdutivas)"
    return at, text


def _no_schedule_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    return row.created_at, (
        f"Técnico definido, sem data de visita (aberta há {span_text(m.now - row.created_at)})"
    )


def _stale_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    return row.updated_at, f"Sem atualização há {span_text(m.now - row.updated_at)}"


def _no_owner_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    if row.owner_id is not None:
        return row.created_at, "O analista responsável saiu da gestão: escolha outro"
    return (
        row.created_at,
        f"Sem analista responsável (aberta há {span_text(m.now - row.created_at)})",
    )


def _violation_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    response_late = (
        row.first_response_at is not None
        and row.response_due_at is not None
        and row.first_response_at > row.response_due_at
    ) or (
        row.first_response_at is None
        and row.response_due_at is not None
        and row.response_due_at < m.now
    )
    clocks = []
    if response_late and row.response_violation_reason_id is None:
        clocks.append("1ª resposta")
    if (
        row.resolved_at is not None
        and row.resolution_due_at is not None
        and row.resolved_at > row.resolution_due_at
        and row.resolution_violation_reason_id is None
    ):
        clocks.append("solução")
    which = " e ".join(clocks) or "prazo"
    return row.resolved_at, f"Informe o motivo da violação de SLA ({which})"


def _portal_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    return row.created_at, f"Aberta pelo cliente há {span_text(m.now - row.created_at)}"


# --------------------------------------------------------------------------- grupos


@dataclass
class GroupSpec:
    key: str
    title: str
    severity: str
    hint: str
    filters: ListFilters | None = None
    link: str | None = None


GROUPS: dict[str, GroupSpec] = {
    spec.key: spec
    for spec in (
        GroupSpec(
            "sla_breached",
            "SLA estourado",
            "critical",
            "OS em aberto com prazo de SLA vencido.",
            ListFilters(sla_breached=True),
        ),
        GroupSpec(
            "late_arrival",
            "Chegada atrasada",
            "high",
            "O prazo de chegada passou e o técnico ainda não chegou ao local.",
        ),
        GroupSpec(
            "today_not_started",
            "Visitas de hoje sem início",
            "high",
            "Agendadas para hoje, 30 min ou mais depois do horário e sem saída ou início.",
        ),
        GroupSpec(
            "unassigned_soon",
            "Sem técnico",
            "high",
            "Visita nas próximas 48 h ou aberta há mais de 24 h, e ninguém para atender.",
            ListFilters(unassigned=True, open_only=True),
        ),
        GroupSpec(
            "unproductive_pending",
            "Improdutivas sem reagendar",
            "high",
            "A última visita foi improdutiva e a OS ainda não tem data nova.",
        ),
        GroupSpec(
            "no_schedule",
            "Sem agenda",
            "medium",
            "Técnico definido, mas sem data de visita.",
        ),
        GroupSpec(
            "part_requests_open",
            "Pedidos de peça",
            "medium",
            "Pedidos de peça dos técnicos esperando orçamento.",
        ),
        GroupSpec(
            "costs_pending",
            "Custos extras a aprovar",
            "medium",
            "Custos lançados nas OS esperando aprovação.",
            link="/custos",
        ),
        GroupSpec(
            "portal_requests",
            "Solicitações do portal",
            "medium",
            "Pedidos abertos pelos clientes no portal esperando a central.",
            link="/solicitacoes",
        ),
        GroupSpec(
            "stale",
            "Paradas há 3 dias ou mais",
            "medium",
            "OS em aberto sem nenhuma atualização há 3 dias ou mais.",
        ),
        GroupSpec(
            "no_owner",
            "Sem analista responsável",
            "medium",
            "OS em aberto fora da fila de qualquer analista.",
            ListFilters(no_owner=True, open_only=True),
        ),
        GroupSpec(
            "violation_pending",
            "Justificar SLA",
            "low",
            "OS concluídas com SLA violado e sem o motivo informado.",
            ListFilters(violation_pending=True),
        ),
        GroupSpec(
            "payouts_pending",
            "Pagamentos de técnicos atrasados",
            "low",
            "OS concluídas há mais de 7 dias com pagamento do técnico pendente.",
            link="/pagamentos",
        ),
        GroupSpec(
            "quotes_waiting",
            "Orçamentos sem resposta",
            "low",
            "Orçamentos enviados ao cliente há mais de 3 dias, ainda sem resposta.",
            link="/orcamentos",
        ),
    )
}


def _today_filters(m: Moment) -> ListFilters:
    return ListFilters(scheduled_from=m.today, scheduled_to=m.today, status=list(NOT_STARTED))


# --------------------------------------------------------------------------- contagens


async def _ticket_counts(db: AsyncSession, m: Moment) -> dict[str, int]:
    """Indicadores e grupos das OS numa varredura só (COUNT ... FILTER)."""
    tomorrow_start, tomorrow_end = day_bounds(m.today + timedelta(days=1))
    columns = {
        "open": _open(),
        "scheduled_today": and_(
            Ticket.scheduled_start >= m.day_start,
            Ticket.scheduled_start < m.day_end,
            Ticket.status != S.CANCELLED,
        ),
        "in_field_now": Ticket.status.in_(FIELD),
        "resolved_today": and_(Ticket.resolved_at >= m.day_start, Ticket.resolved_at < m.day_end),
        "unassigned": and_(_open(), Ticket.assignee_id.is_(None)),
        "sla_breached": breached_clause(m.now),
        "late_arrival": late_arrival_clause(m),
        "today_not_started": today_not_started_clause(m),
        "unassigned_soon": unassigned_soon_clause(m),
        "unproductive_pending": unproductive_pending_clause(),
        "no_schedule": no_schedule_clause(),
        "stale": stale_clause(m),
        "no_owner": no_owner_clause(),
        "violation_pending": violation_pending_clause(m.now),
        "tomorrow_unassigned": and_(
            Ticket.scheduled_start >= tomorrow_start,
            Ticket.scheduled_start < tomorrow_end,
            Ticket.assignee_id.is_(None),
            Ticket.status.not_in(FINISHED),
        ),
    }
    stmt = select(
        *(func.count().filter(cond).label(name) for name, cond in columns.items())
    ).select_from(Ticket)
    row = (await db.execute(stmt)).one()
    counts = {name: int(getattr(row, name) or 0) for name in columns}
    # O mesmo número do aviso do menu (GET /portal/inbox-count).
    counts["portal_requests"] = await portal_svc.inbox_count(db)
    return counts


async def _part_requests(db: AsyncSession, m: Moment) -> tuple[int, list[AttentionItem]]:
    cond = and_(TicketPartRequest.status == PartRequestStatus.OPEN, Ticket.status != S.CANCELLED)
    count = await db.scalar(
        select(func.count())
        .select_from(TicketPartRequest)
        .join(Ticket, Ticket.id == TicketPartRequest.ticket_id)
        .where(cond)
    )
    if not count:
        return 0, []
    asker = aliased(User, name="part_asker")
    rows = (
        await db.execute(
            _ticket_select(
                TicketPartRequest.created_at.label("asked_at"),
                TicketPartRequest.description.label("part"),
                TicketPartRequest.quantity,
                TicketPartRequest.unit,
                asker.name.label("asker_name"),
            )
            .join(TicketPartRequest, TicketPartRequest.ticket_id == Ticket.id)
            .outerjoin(asker, asker.id == TicketPartRequest.requested_by_id)
            .where(cond)
            .order_by(TicketPartRequest.created_at.asc())
            .limit(ITEMS)
        )
    ).all()
    items = [
        _item(
            row,
            row.asked_at,
            f"Peça: {row.part} ({quantity_text(row.quantity, row.unit)}), pedida há "
            f"{span_text(m.now - row.asked_at)}",
            technician=row.asker_name or row.technician_name,
        )
        for row in rows
    ]
    return int(count), items


async def _costs(db: AsyncSession, m: Moment) -> tuple[int, list[AttentionItem]]:
    cond = TicketExpense.status == ExpenseStatus.PENDING
    count = await db.scalar(select(func.count()).select_from(TicketExpense).where(cond))
    if not count:
        return 0, []
    payee = aliased(User, name="expense_technician")
    rows = (
        await db.execute(
            _ticket_select(
                TicketExpense.created_at.label("spent_at"),
                TicketExpense.kind,
                TicketExpense.total,
                payee.name.label("payee_name"),
            )
            .join(TicketExpense, TicketExpense.ticket_id == Ticket.id)
            .outerjoin(payee, payee.id == TicketExpense.technician_id)
            .where(cond)
            .order_by(TicketExpense.created_at.asc())
            .limit(ITEMS)
        )
    ).all()
    items = [
        _item(
            row,
            row.spent_at,
            f"{EXPENSE_LABELS.get(row.kind, 'Custo')} de {money_text(row.total)} aguardando "
            f"aprovação há {span_text(m.now - row.spent_at)}",
            technician=row.payee_name or row.technician_name,
        )
        for row in rows
    ]
    return int(count), items


async def _payouts(db: AsyncSession, m: Moment) -> tuple[int, list[AttentionItem]]:
    cond = and_(
        TicketPayout.status == PayoutStatus.PENDING,
        Ticket.status.in_(DONE),
        Ticket.resolved_at < m.now - PAYOUT_LATE,
    )
    count = await db.scalar(
        select(func.count())
        .select_from(TicketPayout)
        .join(Ticket, Ticket.id == TicketPayout.ticket_id)
        .where(cond)
    )
    if not count:
        return 0, []
    payee = aliased(User, name="payout_technician")
    rows = (
        await db.execute(
            _ticket_select(TicketPayout.amount, payee.name.label("payee_name"))
            .join(TicketPayout, TicketPayout.ticket_id == Ticket.id)
            .outerjoin(payee, payee.id == TicketPayout.technician_id)
            .where(cond)
            .order_by(Ticket.resolved_at.asc(), Ticket.number)
            .limit(ITEMS)
        )
    ).all()
    items = [
        _item(
            row,
            row.resolved_at,
            f"{money_text(row.amount)} a pagar · concluída há {span_text(m.now - row.resolved_at)}",
            technician=row.payee_name,
        )
        for row in rows
    ]
    return int(count), items


async def _quotes(db: AsyncSession, m: Moment) -> tuple[int, list[AttentionItem]]:
    # Enviado com a validade vencida já conta como vencido (services/quotes.refresh_expiry).
    cond = and_(
        Quote.status == QuoteStatus.SENT,
        Quote.sent_at < m.now - QUOTE_WAIT,
        or_(Quote.valid_until.is_(None), Quote.valid_until >= m.today),
    )
    count = await db.scalar(select(func.count()).select_from(Quote).where(cond))
    if not count:
        return 0, []
    rows = (
        await db.execute(
            _ticket_select(
                Quote.number.label("quote_number"), Quote.sent_at, Quote.total.label("amount")
            )
            .join(Quote, Quote.ticket_id == Ticket.id)
            .where(cond)
            .order_by(Quote.sent_at.asc())
            .limit(ITEMS)
        )
    ).all()
    items = [
        _item(
            row,
            row.sent_at,
            f"ORC-{row.quote_number:06d} ({money_text(row.amount)}) enviado há "
            f"{span_text(m.now - row.sent_at)}, sem resposta",
        )
        for row in rows
    ]
    return int(count), items


# Grupos que vêm das OS: condição, ordem dos exemplos (o mais urgente primeiro) e o motivo.
TicketGroup = tuple[Callable[[Moment], ColumnElement[bool]], Callable[[], list[Any]], Reason]

TICKET_GROUPS: dict[str, TicketGroup] = {
    "sla_breached": (
        lambda m: breached_clause(m.now),
        lambda: [
            Ticket.resolution_due_at.asc().nulls_last(),
            Ticket.response_due_at.asc().nulls_last(),
        ],
        _sla_reason,
    ),
    "late_arrival": (
        late_arrival_clause,
        lambda: [Ticket.arrival_due_at.asc()],
        _late_arrival_reason,
    ),
    "today_not_started": (
        today_not_started_clause,
        lambda: [Ticket.scheduled_start.asc()],
        _not_started_reason,
    ),
    "unassigned_soon": (
        unassigned_soon_clause,
        lambda: [Ticket.scheduled_start.asc().nulls_last(), Ticket.created_at.asc()],
        _unassigned_reason,
    ),
    "unproductive_pending": (
        lambda m: unproductive_pending_clause(),
        lambda: [Ticket.last_unproductive_at.asc()],
        _unproductive_reason,
    ),
    "no_schedule": (
        lambda m: no_schedule_clause(),
        lambda: [Ticket.created_at.asc()],
        _no_schedule_reason,
    ),
    "stale": (stale_clause, lambda: [Ticket.updated_at.asc()], _stale_reason),
    "no_owner": (lambda m: no_owner_clause(), lambda: [Ticket.created_at.asc()], _no_owner_reason),
    # As mais recentes primeiro: são as que a equipe ainda lembra o motivo.
    "violation_pending": (
        lambda m: violation_pending_clause(m.now),
        lambda: [Ticket.resolved_at.desc().nulls_last()],
        _violation_reason,
    ),
    "portal_requests": (
        lambda m: portal_clause(),
        lambda: [Ticket.created_at.asc()],
        _portal_reason,
    ),
}

OtherGroup = Callable[[AsyncSession, Moment], Awaitable[tuple[int, list[AttentionItem]]]]
OTHER_GROUPS: dict[str, OtherGroup] = {
    "part_requests_open": _part_requests,
    "costs_pending": _costs,
    "payouts_pending": _payouts,
    "quotes_waiting": _quotes,
}


async def _attention(db: AsyncSession, m: Moment, counts: dict[str, int]) -> list[AttentionGroup]:
    groups: list[AttentionGroup] = []
    for key, (cond, order, reason) in TICKET_GROUPS.items():
        count = counts[key]
        if count:
            items = await _ticket_items(db, m, cond(m), order(), reason)
            groups.append(_group(key, count, items, m))
    for key, load in OTHER_GROUPS.items():
        count, items = await load(db, m)
        if count:
            groups.append(_group(key, count, items, m))
    groups.sort(key=lambda g: (SEVERITY_RANK[g.severity], -g.count))
    return groups


def _group(key: str, count: int, items: list[AttentionItem], m: Moment) -> AttentionGroup:
    spec = GROUPS[key]
    filters = _today_filters(m) if key == "today_not_started" else spec.filters
    return AttentionGroup(
        key=key,
        title=spec.title,
        severity=spec.severity,  # type: ignore[arg-type]
        count=count,
        hint=spec.hint,
        filters=filters,
        link=spec.link,
        items=items,
    )


# --------------------------------------------------------------------------- semana e sugestões


async def _recent_rows(db: AsyncSession, m: Moment) -> list[Any]:
    """OS dos últimos 30 dias (abertura ou prazo de chegada) e as concluídas na semana."""
    since = m.days_ago(RECENT_DAYS - 1)
    week_start = m.days_ago(WEEK_DAYS - 1)
    stmt = select(
        Ticket.created_at,
        Ticket.resolved_at,
        Ticket.location_id,
        Ticket.assignee_id,
        Ticket.arrival_due_at,
        Ticket.arrived_at,
        Ticket.status,
    ).where(
        or_(
            Ticket.created_at >= since,
            Ticket.resolved_at >= week_start,
            Ticket.arrival_due_at >= since,
        )
    )
    return list((await db.execute(stmt)).all())


def _week(rows: list[Any], m: Moment) -> list[WeekDay]:
    days = [m.today - timedelta(days=offset) for offset in range(WEEK_DAYS - 1, -1, -1)]
    created: Counter[date] = Counter()
    resolved: Counter[date] = Counter()
    for row in rows:
        created[_local(row.created_at, m).date()] += 1
        if row.resolved_at is not None:
            resolved[_local(row.resolved_at, m).date()] += 1
    return [WeekDay(day=day, created=created[day], resolved=resolved[day]) for day in days]


def _arrived_late(row: Any, m: Moment, since: datetime) -> bool:
    due = row.arrival_due_at
    if due is None or row.assignee_id is None or not since <= due <= m.now:
        return False
    if row.arrived_at is not None:
        return row.arrived_at > due
    return row.status not in FINISHED


async def _suggest_tomorrow(m: Moment, counts: dict[str, int]) -> Suggestion | None:
    n = counts["tomorrow_unassigned"]
    if not n:
        return None
    tomorrow = m.today + timedelta(days=1)
    return Suggestion(
        key="tomorrow_unassigned",
        title=f"{n} {plural(n, 'OS de amanhã ainda está', 'OS de amanhã ainda estão')} sem técnico",
        detail="Defina os técnicos hoje para confirmar as visitas com as lojas.",
        filters=ListFilters(
            scheduled_from=tomorrow, scheduled_to=tomorrow, unassigned=True, open_only=True
        ),
    )


async def _suggest_late_technician(
    db: AsyncSession, m: Moment, rows: list[Any]
) -> Suggestion | None:
    since = m.days_ago(RECENT_DAYS - 1)
    late = Counter(row.assignee_id for row in rows if _arrived_late(row, m, since))
    if not late:
        return None
    tech_id, n = late.most_common(1)[0]
    if n < LATE_TECH_MIN:
        return None
    name = await db.scalar(select(User.name).where(User.id == tech_id))
    if not name:
        return None
    others = sum(1 for count in late.values() if count >= LATE_TECH_MIN) - 1
    detail = "Vale conversar sobre rota, horários e quantas visitas ele pega por dia."
    if others > 0:
        detail += f" Mais {others} {plural(others, 'técnico', 'técnicos')} com 2 ou mais atrasos."
    return Suggestion(
        key="late_technician",
        title=f"{name} chegou atrasado em {n} OS nos últimos 30 dias",
        detail=detail,
        filters=ListFilters(
            assignee_id=tech_id, created_from=m.today - timedelta(days=RECENT_DAYS - 1)
        ),
    )


async def _suggest_recurrence(db: AsyncSession, m: Moment, rows: list[Any]) -> Suggestion | None:
    since = m.days_ago(RECENT_DAYS - 1)
    per_store = Counter(
        row.location_id for row in rows if row.location_id is not None and row.created_at >= since
    )
    repeated = [(loc, n) for loc, n in per_store.items() if n >= RECURRENCE_MIN]
    if not repeated:
        return None
    repeated.sort(key=lambda item: (-item[1], str(item[0])))
    location_id, n = repeated[0]
    store = (
        await db.execute(
            select(Location.name, Location.city, Customer.name.label("customer"))
            .outerjoin(Customer, Customer.id == Location.customer_id)
            .where(Location.id == location_id)
        )
    ).first()
    if store is None:
        return None
    where = " · ".join(part for part in (store.customer, store.city) if part)
    detail = f"{where}. " if where else ""
    detail += "Repetição costuma indicar causa que não foi resolvida."
    if len(repeated) > 1:
        k = len(repeated) - 1
        detail += f" Mais {k} {plural(k, 'loja', 'lojas')} com 3 ou mais OS no período."
    return Suggestion(
        key="recurrence",
        title=f"{store.name} teve {n} OS em 30 dias: vale uma visita preventiva",
        detail=detail,
        filters=ListFilters(
            location_id=location_id, created_from=m.today - timedelta(days=RECENT_DAYS - 1)
        ),
    )


async def _suggest_top_customer(db: AsyncSession, counts: dict[str, int]) -> Suggestion | None:
    total_open = counts["open"]
    if not total_open:
        return None
    row = (
        await db.execute(
            select(Ticket.customer_id, Customer.name, func.count().label("n"))
            .join(Customer, Customer.id == Ticket.customer_id)
            .where(_open())
            .group_by(Ticket.customer_id, Customer.name)
            .order_by(func.count().desc(), Customer.name)
            .limit(1)
        )
    ).first()
    if row is None or row.n < TOP_CUSTOMER_MIN:
        return None
    share = round(100 * row.n / total_open)
    return Suggestion(
        key="top_customer",
        title=f"{row.name} concentra {row.n} OS em aberto",
        detail=f"São {share}% das OS em aberto. Vale alinhar as prioridades com o cliente.",
        filters=ListFilters(customer_id=row.customer_id, open_only=True),
    )


async def _suggest_slow_service(db: AsyncSession) -> Suggestion | None:
    types = (
        await db.execute(
            select(ServiceType.id, ServiceType.name, ServiceType.estimated_minutes).where(
                ServiceType.is_active.is_(True), ServiceType.estimated_minutes > 0
            )
        )
    ).all()
    if not types:
        return None
    stats = await durations.observed_stats(db, [t.id for t in types])
    slow = []
    for t in types:
        info = stats.get(t.id)
        if not info or info["observed_count"] < durations.MIN_SAMPLES:
            continue
        median = info["observed_median_minutes"]
        if median > t.estimated_minutes * SLOW_RATIO:
            slow.append((median / t.estimated_minutes, t, median, info["observed_count"]))
    if not slow:
        return None
    slow.sort(key=lambda item: (-item[0], item[1].name))
    _, worst, median, count = slow[0]
    detail = f"Mediana de {count} OS concluídas. Ajuste a estimativa para a agenda não estourar."
    if len(slow) > 1:
        k = len(slow) - 1
        detail += f" Mais {k} {plural(k, 'tipo', 'tipos')} acima do previsto."
    return Suggestion(
        key="slow_service_type",
        title=(
            f"{worst.name} leva {duration_text(median)} e a estimativa é "
            f"{duration_text(worst.estimated_minutes)}"
        ),
        detail=detail,
        link="/tipos-servico",
    )


async def _suggestions(
    db: AsyncSession, m: Moment, counts: dict[str, int], rows: list[Any]
) -> list[Suggestion]:
    found = [
        await _suggest_tomorrow(m, counts),
        await _suggest_late_technician(db, m, rows),
        await _suggest_recurrence(db, m, rows),
        await _suggest_top_customer(db, counts),
        await _suggest_slow_service(db),
    ]
    return [s for s in found if s is not None][:MAX_SUGGESTIONS]


# --------------------------------------------------------------------------- tela


async def overview(db: AsyncSession) -> HomeOverview:
    m = _moment()
    counts = await _ticket_counts(db, m)
    attention = await _attention(db, m, counts)
    rows = await _recent_rows(db, m)
    return HomeOverview(
        generated_at=m.now,
        kpis=HomeKpis(
            open=counts["open"],
            scheduled_today=counts["scheduled_today"],
            in_field_now=counts["in_field_now"],
            resolved_today=counts["resolved_today"],
            late=counts["sla_breached"],
            unassigned=counts["unassigned"],
        ),
        attention=attention,
        suggestions=await _suggestions(db, m, counts, rows),
        week=_week(rows, m),
    )

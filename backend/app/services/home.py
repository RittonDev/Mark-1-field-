"""Tela inicial da gestão: o número do topo (focus), os sinais vitais da operação (pulse), os
pontos de atenção das OS e sugestões.

Uma varredura das OS conta os indicadores, os grupos e quase todos os sinais vitais (FILTER
no banco, sem COUNT(DISTINCT)); o resto sai de consultas pequenas (técnicos com visita,
retorno na loja, improdutivas, equipe, clientes e financeiro). Cada grupo com alguma OS traz
até 5 exemplos, já com cliente, loja e técnico na mesma consulta. Os grupos de rotina e os
números de 30 dias olham o que foi aberto na janela; o que ficou de antes vai para a "Fila
antiga". "Hoje", os dias e as semanas seguem o fuso da operação (America/Sao_Paulo).
"""

import uuid
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import (
    ColumnElement,
    DateTime,
    Float,
    Select,
    and_,
    case,
    cast,
    func,
    literal,
    not_,
    or_,
    select,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import settings
from app.core.enums import (
    ExpenseKind,
    ExpenseStatus,
    PartRequestStatus,
    PayoutStatus,
    QuoteStatus,
    TicketEventType,
    TicketSource,
    TicketStatus,
    TicketType,
    UserRole,
)
from app.db.base import utcnow
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
from app.schemas.home import (
    AgeBucket,
    AttentionGroup,
    AttentionItem,
    CustomerPulse,
    HomeBacklog,
    HomeCustomers,
    HomeFinance,
    HomeFocus,
    HomeKpis,
    HomeOverview,
    HomePulse,
    HomeQuality,
    HomeTeam,
    HomeToday,
    HomeTomorrow,
    ListFilters,
    OldReason,
    Ratio,
    Suggestion,
    WeekDay,
    WeekFlow,
)
from app.services import durations, tag_rules
from app.services import field as field_svc
from app.services import portal as portal_svc
from app.services.activities import day_bounds, local_today
from app.services.field import SCHEDULE_TOLERANCE
from app.services.reports import month_bounds
from app.services.tickets import (
    breached_clause,
    has_any_tag,
    orphan_owner_ids,
    violation_pending_clause,
)
from app.services.workflow import OPEN_STATUSES, STATUS_INFO

S = TicketStatus
ITEMS = 5
MAX_SUGGESTIONS = 6
FIELD = (S.EN_ROUTE, S.IN_PROGRESS)
DONE = (S.RESOLVED, S.CLOSED)
FINISHED = (S.RESOLVED, S.CLOSED, S.CANCELLED)
ON_HOLD = (S.ON_HOLD_CUSTOMER, S.ON_HOLD_VENDOR)
# Visita do dia que ainda não começou (nem saiu para o local).
NOT_STARTED = (S.NEW, S.TRIAGE, S.ASSIGNED, S.SCHEDULED, S.REOPENED)
# Com técnico definido e sem chegada registrada.
ARRIVAL_PENDING = (S.ASSIGNED, S.SCHEDULED, S.EN_ROUTE)
# Estados em que a OS precisa de uma data de visita.
NEEDS_SCHEDULE = (S.NEW, S.TRIAGE, S.ASSIGNED, S.REOPENED)

START_TOLERANCE = timedelta(minutes=30)
UNASSIGNED_HORIZON = timedelta(hours=48)
STALE_AFTER = timedelta(days=3)
PAYOUT_LATE = timedelta(days=7)
QUOTE_WAIT = timedelta(days=3)
FIELD_STUCK_AFTER = timedelta(hours=12)
DUE_SOON = timedelta(hours=24)
TAG_OLD = timedelta(days=30)
RECENT_DAYS = 30
WEEK_DAYS = 7
WEEKS = 8
MISSED_DAYS = 7
# Retorno na loja: nova corretiva até 7 dias depois da conclusão, nas concluídas de 30 dias que
# já tiveram os 7 dias de acompanhamento.
RETURN_DAYS = 7
RETURN_BASE_DAYS = 30
TOP_CUSTOMERS = 5
RECURRENCE_MIN = 3
TOP_CUSTOMER_MIN = 3
LATE_TECH_MIN = 2
SLOW_RATIO = 1.3
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
# "now" pede ação agora e entra no número do topo; "routine" é o resto.
TIER_RANK = {"now": 0, "routine": 1}
NOW_KEYS = (
    "sla_breached",
    "late_arrival",
    "today_not_started",
    "field_stuck",
    "due_soon",
    "unassigned_visit",
)

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

    @property
    def recent_from(self) -> date:
        """1º dia dos "últimos 30 dias" (hoje - 29): o `created_from` da lista."""
        return self.today - timedelta(days=RECENT_DAYS - 1)

    @property
    def recent_start(self) -> datetime:
        """Começo da janela de 30 dias (o início de `recent_from`)."""
        return self.days_ago(RECENT_DAYS - 1)

    @property
    def old_to(self) -> date:
        """Último dia da "Fila antiga" (o `created_to` das abertas antes da janela)."""
        return self.recent_from - timedelta(days=1)

    @property
    def tomorrow(self) -> date:
        return self.today + timedelta(days=1)

    @property
    def tomorrow_end(self) -> datetime:
        return day_bounds(self.today + timedelta(days=2))[0]

    @property
    def week_starts(self) -> list[date]:
        """As segundas-feiras das últimas 8 semanas, da mais antiga para a atual."""
        monday = self.today - timedelta(days=self.today.weekday())
        return [monday - timedelta(weeks=n) for n in range(WEEKS - 1, -1, -1)]


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


def recent(m: Moment) -> ColumnElement[bool]:
    """Aberta nos últimos 30 dias: o corte da rotina e dos números de 30 dias (o resto é a
    "Fila antiga"). É o mesmo `created_from` (hoje - 29) que os filtros mandam para a lista."""
    return Ticket.created_at >= m.recent_start


def field_since() -> ColumnElement[Any]:
    """Desde quando a OS está em campo: a última ida para "Em deslocamento" ou "Em atendimento" no
    histórico; sem esse evento (OS importada), o início do atendimento, a chegada ou a última
    mudança. Fora de campo é nulo: o CASE só roda a subconsulta nas OS em campo."""
    moved = (
        select(func.max(TicketEvent.created_at))
        .where(
            TicketEvent.ticket_id == Ticket.id,
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            TicketEvent.to_value.in_([s.value for s in FIELD]),
        )
        .correlate(Ticket)
        .scalar_subquery()
    )
    since = func.coalesce(moved, Ticket.work_started_at, Ticket.arrived_at, Ticket.updated_at)
    return case((Ticket.status.in_(FIELD), since))


def field_stuck_clause(m: Moment) -> ColumnElement[bool]:
    """A caminho ou em atendimento há mais de 12 h (esqueceram de concluir ou de voltar a OS)."""
    return field_since() < m.now - FIELD_STUCK_AFTER


def due_soon_clause(m: Moment) -> ColumnElement[bool]:
    """Prazo de solução nas próximas 24 h, com o SLA correndo e ainda sem estourar."""
    return and_(
        _open(),
        Ticket.sla_paused_at.is_(None),
        Ticket.resolution_due_at > m.now,
        Ticket.resolution_due_at <= m.now + DUE_SOON,
        not_(breached_clause(m.now)),
    )


def unassigned_visit_clause(m: Moment) -> ColumnElement[bool]:
    """Em aberto sem técnico com visita hoje (mesmo se o horário já passou) ou amanhã."""
    return and_(
        _open(),
        Ticket.assignee_id.is_(None),
        Ticket.scheduled_start >= m.day_start,
        Ticket.scheduled_start < m.tomorrow_end,
    )


def missed_visits_clause(m: Moment) -> ColumnElement[bool]:
    """Agendada nos 7 dias anteriores e ainda sem saída nem início."""
    return and_(
        Ticket.status.in_(NOT_STARTED),
        Ticket.scheduled_start >= m.days_ago(MISSED_DAYS),
        Ticket.scheduled_start < m.day_start,
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


def arrival_limit() -> ColumnElement[Any]:
    """Até quando a chegada é "no horário": o prazo de chegada da OS ou, sem ele (OS importada),
    o horário agendado mais a tolerância de field.SCHEDULE_TOLERANCE."""
    return func.coalesce(Ticket.arrival_due_at, Ticket.scheduled_start + SCHEDULE_TOLERANCE)


def on_time_base(m: Moment) -> ColumnElement[bool]:
    """Chegadas da janela de 30 dias com o que comparar (prazo de chegada ou agenda)."""
    return and_(
        Ticket.arrived_at >= m.recent_start,
        or_(Ticket.arrival_due_at.is_not(None), Ticket.scheduled_start.is_not(None)),
    )


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
    extra: Sequence[Any] = (),
) -> list[AttentionItem]:
    stmt = _ticket_select(*extra).where(cond).order_by(*order).limit(ITEMS)
    rows = (await db.execute(stmt)).all()
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


def _field_stuck_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    since = row.field_since
    label = STATUS_INFO[row.status].label
    return since, f"{label} desde {_when_text(since, m)} ({span_text(m.now - since)})"


def _due_soon_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    due = row.resolution_due_at
    return due, f"Vence {_when_text(due, m)}"


def _missed_reason(row: Any, m: Moment) -> tuple[datetime | None, str]:
    start = row.scheduled_start
    return start, f"Era {_when_text(start, m)}, sem início"


# --------------------------------------------------------------------------- grupos


@dataclass
class GroupSpec:
    key: str
    title: str
    severity: str
    hint: str
    filters: ListFilters | None = None
    link: str | None = None
    tier: str = "routine"
    # Filtro que depende do dia (o "Ver todas" com as datas de hoje); no lugar de `filters`.
    make_filters: Callable[[Moment], ListFilters] | None = None


def _recent_filters(**flags: Any) -> Callable[[Moment], ListFilters]:
    """O filtro da lista com o mesmo corte de 30 dias do grupo (`created_from` = hoje - 29)."""
    return lambda m: ListFilters(**flags, created_from=m.recent_from)


def _unassigned_visit_filters(m: Moment) -> ListFilters:
    return ListFilters(
        unassigned=True, open_only=True, scheduled_from=m.today, scheduled_to=m.tomorrow
    )


def _missed_filters(m: Moment) -> ListFilters:
    return ListFilters(
        status=list(NOT_STARTED),
        scheduled_from=m.today - timedelta(days=MISSED_DAYS),
        scheduled_to=m.today - timedelta(days=1),
    )


GROUPS: dict[str, GroupSpec] = {
    spec.key: spec
    for spec in (
        # Pedem ação agora (entram no número do topo).
        GroupSpec(
            "sla_breached",
            "SLA estourado",
            "critical",
            "Abertas nos últimos 30 dias com prazo de SLA vencido.",
            tier="now",
            make_filters=_recent_filters(sla_breached=True),
        ),
        GroupSpec(
            "late_arrival",
            "Chegada atrasada",
            "high",
            "O prazo de chegada passou e o técnico ainda não chegou ao local.",
            tier="now",
        ),
        GroupSpec(
            "today_not_started",
            "Visitas de hoje sem início",
            "high",
            "Agendadas para hoje, 30 min ou mais depois do horário e sem saída ou início.",
            # Sem "Ver todas": a lista filtra por dia, não pela tolerância de 30 min, e mostraria
            # também as visitas que ainda estão no horário (o número não bateria).
            tier="now",
        ),
        GroupSpec(
            "field_stuck",
            "Em campo há mais de 12 h",
            "high",
            "A caminho ou em atendimento há mais de 12 h.",
            tier="now",
        ),
        GroupSpec(
            "due_soon",
            "Prazo vence em 24 h",
            "high",
            "Abertas nos últimos 30 dias com prazo de solução nas próximas 24 h.",
            tier="now",
        ),
        GroupSpec(
            "unassigned_visit",
            "Sem técnico com visita até amanhã",
            "high",
            "Visita hoje ou amanhã e ninguém para atender.",
            tier="now",
            make_filters=_unassigned_visit_filters,
        ),
        # Rotina: o que foi aberto nos últimos 30 dias (o resto fica na "Fila antiga").
        GroupSpec(
            "missed_visits",
            "Visitas que passaram sem baixa",
            "medium",
            "Agendadas nos 7 dias anteriores e ainda sem início.",
            make_filters=_missed_filters,
        ),
        GroupSpec(
            "unassigned",
            "Sem técnico",
            "medium",
            "Abertas nos últimos 30 dias, sem técnico.",
            make_filters=_recent_filters(unassigned=True, open_only=True),
        ),
        GroupSpec(
            "unproductive_pending",
            "Improdutivas sem reagendar",
            "medium",
            "Improdutiva nos últimos 30 dias e ainda sem data nova.",
        ),
        GroupSpec(
            "no_schedule",
            "Sem agenda",
            "medium",
            "Abertas nos últimos 30 dias, com técnico e sem data de visita.",
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
            "low",
            "Abertas nos últimos 30 dias e sem nenhuma atualização há 3 dias ou mais.",
        ),
        GroupSpec(
            "no_owner",
            "Sem analista responsável",
            "medium",
            "Abertas nos últimos 30 dias e fora da fila de qualquer analista.",
            make_filters=_recent_filters(no_owner=True, open_only=True),
        ),
        GroupSpec(
            "violation_pending",
            "Justificar SLA",
            "low",
            "Abertas nos últimos 30 dias, concluídas com SLA violado e sem o motivo informado.",
            make_filters=_recent_filters(violation_pending=True),
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


# --------------------------------------------------------------------------- contagens


def _week_bounds(start: date) -> tuple[datetime, datetime]:
    """Da segunda-feira 00:00 até a segunda seguinte, no fuso da operação."""
    return day_bounds(start)[0], day_bounds(start + timedelta(days=7))[0]


async def _ticket_counts(db: AsyncSession, m: Moment, onsite_hours: int) -> dict[str, Any]:
    """Indicadores, grupos de atenção e quase todos os sinais vitais numa varredura só das OS
    (COUNT ... FILTER), com os limites de tempo como parâmetros. Sem COUNT(DISTINCT), que obriga o
    banco a ordenar a tabela inteira: os técnicos distintos saem de _visit_technicians."""
    today = and_(
        Ticket.scheduled_start >= m.day_start,
        Ticket.scheduled_start < m.day_end,
        Ticket.status != S.CANCELLED,
    )
    tomorrow = and_(
        Ticket.scheduled_start >= m.day_end,
        Ticket.scheduled_start < m.tomorrow_end,
        Ticket.status.not_in(FINISHED),
    )
    in_window = recent(m)
    old = and_(_open(), Ticket.created_at < m.recent_start)
    arrivals = on_time_base(m)
    sla = and_(
        Ticket.resolved_at >= m.recent_start,
        Ticket.resolution_due_at.is_not(None),
        Ticket.status != S.CANCELLED,
    )
    onsite = and_(Ticket.resolved_at >= m.recent_start, Ticket.work_seconds > 0)
    columns: dict[str, ColumnElement[bool]] = {
        # Indicadores (kpis): os de sempre, sem o corte de 30 dias.
        "open": _open(),
        "scheduled_today": today,
        "in_field_now": Ticket.status.in_(FIELD),
        "resolved_today": and_(Ticket.resolved_at >= m.day_start, Ticket.resolved_at < m.day_end),
        "late": breached_clause(m.now),
        "open_unassigned": and_(_open(), Ticket.assignee_id.is_(None)),
        # Grupos de atenção, com a condição do próprio grupo (a do portal é a do menu).
        **{key: group.cond(m) for key, group in TICKET_GROUPS.items() if key != "portal_requests"},
        # O número do topo: cada OS uma vez, mesmo com dois motivos.
        "now_total": or_(*(TICKET_GROUPS[key].cond(m) for key in NOW_KEYS)),
        # Hoje e amanhã.
        "today_done": and_(today, Ticket.status.in_(DONE)),
        "today_in_field": and_(today, Ticket.status.in_(FIELD)),
        "today_on_hold": and_(today, Ticket.status.in_(ON_HOLD)),
        "today_upcoming": and_(
            today,
            Ticket.status.in_(NOT_STARTED),
            Ticket.scheduled_start > m.now - START_TOLERANCE,
        ),
        "today_unassigned": and_(
            today, Ticket.assignee_id.is_(None), Ticket.status.not_in(FINISHED)
        ),
        "tomorrow_planned": tomorrow,
        "tomorrow_unassigned": and_(tomorrow, Ticket.assignee_id.is_(None)),
        # Fila em aberto: recentes x antigas, idade e o fluxo de 30 dias.
        "open_recent": and_(_open(), in_window),
        "age_d7": and_(_open(), Ticket.created_at >= m.days_ago(6)),
        "age_d30": and_(_open(), in_window, Ticket.created_at < m.days_ago(6)),
        "age_d90": and_(old, Ticket.created_at >= m.days_ago(89)),
        "age_older": and_(_open(), Ticket.created_at < m.days_ago(89)),
        "entered_30d": in_window,
        "resolved_30d": Ticket.resolved_at >= m.recent_start,
        "cancelled_30d": Ticket.cancelled_at >= m.recent_start,
        "old_no_owner": and_(old, no_owner_clause()),
        "old_unassigned": and_(old, Ticket.assignee_id.is_(None)),
        "old_overdue_visit": and_(
            old, Ticket.status.in_(NOT_STARTED), Ticket.scheduled_start < m.day_start
        ),
        "old_sla_breached": and_(old, breached_clause(m.now)),
        "old_unproductive": and_(old, unproductive_pending_clause()),
        # Atendimento ao cliente e equipe de campo (30 dias).
        "on_time_base": arrivals,
        "on_time_ok": and_(arrivals, Ticket.arrived_at <= arrival_limit()),
        "arrivals_30d": Ticket.arrived_at >= m.recent_start,
        "sla_base": sla,
        "sla_ok": and_(sla, Ticket.resolved_at <= Ticket.resolution_due_at),
        "sla_imported": and_(sla, Ticket.legacy.is_not(None)),
        "onsite_base": onsite,
        "onsite_over": and_(onsite, Ticket.work_seconds > onsite_hours * 3600),
    }
    for i, start in enumerate(m.week_starts):
        week_start, week_end = _week_bounds(start)
        columns[f"week_created_{i}"] = and_(
            Ticket.created_at >= week_start, Ticket.created_at < week_end
        )
        columns[f"week_resolved_{i}"] = and_(
            Ticket.resolved_at >= week_start, Ticket.resolved_at < week_end
        )
    now = literal(m.now, DateTime(timezone=True))
    age = cast(func.extract("epoch", now - Ticket.created_at), Float)
    next_visit = and_(
        Ticket.status.in_(NOT_STARTED),
        Ticket.scheduled_start > m.now,
        Ticket.scheduled_start < m.day_end,
    )
    stmt = select(
        *(func.count().filter(cond).label(name) for name, cond in columns.items()),
        func.min(Ticket.scheduled_start).filter(next_visit).label("next_visit_at"),
        func.percentile_cont(0.5).within_group(age).filter(_open()).label("median_age_s"),
        func.percentile_cont(0.5)
        .within_group(Ticket.work_seconds)
        .filter(onsite)
        .label("onsite_median_s"),
    ).select_from(Ticket)
    row = (await db.execute(stmt)).one()
    counts: dict[str, Any] = {name: int(getattr(row, name) or 0) for name in columns}
    counts["next_visit_at"] = row.next_visit_at
    counts["median_age_s"] = row.median_age_s
    counts["onsite_median_s"] = row.onsite_median_s
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


@dataclass(frozen=True)
class TicketGroup:
    """Grupo que vem das OS: a condição (a mesma da contagem), a ordem dos exemplos (o mais
    urgente primeiro), o motivo e as colunas a mais que o motivo lê."""

    cond: Callable[[Moment], ColumnElement[bool]]
    order: Callable[[Moment], list[Any]]
    reason: Reason
    extra: Callable[[], list[Any]] | None = None


TICKET_GROUPS: dict[str, TicketGroup] = {
    "sla_breached": TicketGroup(
        lambda m: and_(breached_clause(m.now), recent(m)),
        lambda m: [
            Ticket.resolution_due_at.asc().nulls_last(),
            Ticket.response_due_at.asc().nulls_last(),
        ],
        _sla_reason,
    ),
    "late_arrival": TicketGroup(
        late_arrival_clause, lambda m: [Ticket.arrival_due_at.asc()], _late_arrival_reason
    ),
    "today_not_started": TicketGroup(
        today_not_started_clause, lambda m: [Ticket.scheduled_start.asc()], _not_started_reason
    ),
    "field_stuck": TicketGroup(
        field_stuck_clause,
        lambda m: [field_since().asc()],
        _field_stuck_reason,
        extra=lambda: [field_since().label("field_since")],
    ),
    # Com o mesmo corte de 30 dias do "SLA estourado": a OS antiga que volta de uma pausa não entra no
    # topo para sumir dele na hora em que o prazo estoura (ela fica só na "Fila antiga").
    "due_soon": TicketGroup(
        lambda m: and_(due_soon_clause(m), recent(m)),
        lambda m: [Ticket.resolution_due_at.asc()],
        _due_soon_reason,
    ),
    "unassigned_visit": TicketGroup(
        unassigned_visit_clause, lambda m: [Ticket.scheduled_start.asc()], _unassigned_reason
    ),
    "missed_visits": TicketGroup(
        missed_visits_clause, lambda m: [Ticket.scheduled_start.asc()], _missed_reason
    ),
    "unassigned": TicketGroup(
        lambda m: and_(_open(), Ticket.assignee_id.is_(None), recent(m)),
        lambda m: [Ticket.scheduled_start.asc().nulls_last(), Ticket.created_at.asc()],
        _unassigned_reason,
    ),
    "unproductive_pending": TicketGroup(
        lambda m: and_(
            unproductive_pending_clause(), Ticket.last_unproductive_at >= m.recent_start
        ),
        lambda m: [Ticket.last_unproductive_at.asc()],
        _unproductive_reason,
    ),
    "no_schedule": TicketGroup(
        lambda m: and_(no_schedule_clause(), recent(m)),
        lambda m: [Ticket.created_at.asc()],
        _no_schedule_reason,
    ),
    "no_owner": TicketGroup(
        lambda m: and_(no_owner_clause(), recent(m)),
        lambda m: [Ticket.created_at.asc()],
        _no_owner_reason,
    ),
    "portal_requests": TicketGroup(
        lambda m: portal_clause(), lambda m: [Ticket.created_at.asc()], _portal_reason
    ),
    "stale": TicketGroup(
        lambda m: and_(stale_clause(m), recent(m)),
        lambda m: [Ticket.updated_at.asc()],
        _stale_reason,
    ),
    # As mais recentes primeiro: são as que a equipe ainda lembra o motivo.
    "violation_pending": TicketGroup(
        lambda m: and_(violation_pending_clause(m.now), recent(m)),
        lambda m: [Ticket.resolved_at.desc().nulls_last()],
        _violation_reason,
    ),
}

OtherGroup = Callable[[AsyncSession, Moment], Awaitable[tuple[int, list[AttentionItem]]]]
OTHER_GROUPS: dict[str, OtherGroup] = {
    "part_requests_open": _part_requests,
    "costs_pending": _costs,
    "payouts_pending": _payouts,
    "quotes_waiting": _quotes,
}


async def _attention(db: AsyncSession, m: Moment, counts: dict[str, Any]) -> list[AttentionGroup]:
    groups: list[AttentionGroup] = []
    for key, group in TICKET_GROUPS.items():
        count = counts[key]
        if count:
            extra = group.extra() if group.extra else ()
            items = await _ticket_items(db, m, group.cond(m), group.order(m), group.reason, extra)
            groups.append(_group(key, count, items, m))
    for key, load in OTHER_GROUPS.items():
        count, items = await load(db, m)
        if count:
            groups.append(_group(key, count, items, m))
    # Agora antes da rotina; depois o mais grave e o maior número (empate: a ordem dos grupos).
    groups.sort(key=lambda g: (TIER_RANK[g.tier], SEVERITY_RANK[g.severity], -g.count))
    return groups


def _group(key: str, count: int, items: list[AttentionItem], m: Moment) -> AttentionGroup:
    spec = GROUPS[key]
    return AttentionGroup(
        key=key,
        title=spec.title,
        severity=spec.severity,  # type: ignore[arg-type]
        tier=spec.tier,  # type: ignore[arg-type]
        count=count,
        hint=spec.hint,
        filters=spec.make_filters(m) if spec.make_filters else spec.filters,
        link=spec.link,
        items=items,
    )


# --------------------------------------------------------------------------- semana e sugestões


async def _recent_rows(db: AsyncSession, m: Moment) -> list[Any]:
    """OS dos últimos 30 dias (abertura, chegada ou prazo de chegada) e as concluídas na semana."""
    since = m.days_ago(RECENT_DAYS - 1)
    week_start = m.days_ago(WEEK_DAYS - 1)
    stmt = select(
        Ticket.created_at,
        Ticket.resolved_at,
        Ticket.location_id,
        Ticket.assignee_id,
        Ticket.arrival_due_at,
        Ticket.arrived_at,
        Ticket.scheduled_start,
        Ticket.status,
    ).where(
        or_(
            Ticket.created_at >= since,
            Ticket.resolved_at >= week_start,
            Ticket.arrival_due_at >= since,
            Ticket.arrived_at >= since,
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
    """Com prazo de chegada: chegou depois dele (ou ainda não chegou). Sem prazo (OS importada):
    chegou mais de 30 min depois do horário agendado (field.SCHEDULE_TOLERANCE)."""
    if row.assignee_id is None:
        return False
    due = row.arrival_due_at
    if due is not None:
        if not since <= due <= m.now:
            return False
        if row.arrived_at is not None:
            return row.arrived_at > due
        return row.status not in FINISHED
    arrived, start = row.arrived_at, row.scheduled_start
    if arrived is None or start is None or not since <= arrived <= m.now:
        return False
    return arrived > start + SCHEDULE_TOLERANCE


async def _suggest_tomorrow(m: Moment, counts: dict[str, Any]) -> Suggestion | None:
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


async def _suggest_top_customer(db: AsyncSession, counts: dict[str, Any]) -> Suggestion | None:
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
    db: AsyncSession, m: Moment, counts: dict[str, Any], rows: list[Any]
) -> list[Suggestion]:
    found = [
        await _suggest_tomorrow(m, counts),
        await _suggest_late_technician(db, m, rows),
        await _suggest_recurrence(db, m, rows),
        await _suggest_top_customer(db, counts),
        await _suggest_slow_service(db),
    ]
    return [s for s in found if s is not None][:MAX_SUGGESTIONS]


# --------------------------------------------------------------------------- sinais vitais


async def _visit_technicians(db: AsyncSession, m: Moment) -> tuple[int, int]:
    """Técnicos distintos com visita hoje e amanhã. Consulta pequena (só a agenda dos 2 dias),
    para o COUNT(DISTINCT) ficar fora da varredura grande."""
    technicians = Ticket.assignee_id.distinct()
    today = and_(Ticket.scheduled_start < m.day_end, Ticket.status != S.CANCELLED)
    tomorrow = and_(Ticket.scheduled_start >= m.day_end, Ticket.status.not_in(FINISHED))
    window = and_(Ticket.scheduled_start >= m.day_start, Ticket.scheduled_start < m.tomorrow_end)
    stmt = select(
        func.count(technicians).filter(today), func.count(technicians).filter(tomorrow)
    ).where(window)
    today_n, tomorrow_n = (await db.execute(stmt)).one()
    return today_n or 0, tomorrow_n or 0


async def _store_return(db: AsyncSession, m: Moment) -> Ratio:
    """Concluídas numa loja entre 37 e 7 dias atrás (os 7 dias de acompanhamento completos) e
    quantas tiveram nova corretiva na mesma loja em até 7 dias (cancelada não conta)."""
    later = aliased(Ticket, name="return_ticket")
    came_back = (
        select(later.id)
        .where(
            later.location_id == Ticket.location_id,
            later.id != Ticket.id,
            later.type == TicketType.INCIDENT,
            later.status != S.CANCELLED,
            later.created_at > Ticket.resolved_at,
            later.created_at <= Ticket.resolved_at + timedelta(days=RETURN_DAYS),
        )
        .correlate(Ticket)
        .exists()
    )
    followed_until = m.now - timedelta(days=RETURN_DAYS)
    stmt = (
        select(func.count().label("base"), func.count().filter(came_back).label("returned"))
        .select_from(Ticket)
        .where(
            Ticket.status.in_(DONE),
            Ticket.location_id.is_not(None),
            Ticket.resolved_at >= followed_until - timedelta(days=RETURN_BASE_DAYS),
            Ticket.resolved_at < followed_until,
        )
    )
    row = (await db.execute(stmt)).one()
    return Ratio(count=row.returned or 0, base=row.base or 0)


async def _unproductive_events(db: AsyncSession, m: Moment) -> int:
    """Visitas improdutivas na janela (o evento da OS, não um status)."""
    stmt = (
        select(func.count())
        .select_from(TicketEvent)
        .where(
            TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
            TicketEvent.created_at >= m.recent_start,
        )
    )
    return await db.scalar(stmt) or 0


async def _team_rows(db: AsyncSession, m: Moment) -> list[Any]:
    """OS resolvidas na janela por técnico (users.role = technician) e se ele já entrou no app."""
    stmt = (
        select(Ticket.assignee_id, User.last_login_at, func.count().label("resolved"))
        .select_from(Ticket)
        .join(User, User.id == Ticket.assignee_id)
        .where(User.role == UserRole.TECHNICIAN, Ticket.resolved_at >= m.recent_start)
        .group_by(Ticket.assignee_id, User.last_login_at)
    )
    return list((await db.execute(stmt)).all())


async def _customers(db: AsyncSession, m: Moment, entered: int) -> HomeCustomers:
    """Clientes com OS abertas na janela: os 5 maiores, cada um com a chegada no horário (a regra
    do atendimento ao cliente) e o prazo estourado."""
    created = recent(m)
    arrivals = on_time_base(m)
    on_time = and_(arrivals, Ticket.arrived_at <= arrival_limit())
    stmt = (
        select(
            Ticket.customer_id,
            Customer.name,
            func.count().filter(created).label("created"),
            func.count().filter(arrivals).label("on_time_base"),
            func.count().filter(on_time).label("on_time_ok"),
            func.count().filter(created, breached_clause(m.now)).label("breached"),
        )
        .select_from(Ticket)
        .join(Customer, Customer.id == Ticket.customer_id)
        .where(or_(created, Ticket.arrived_at >= m.recent_start))
        .group_by(Ticket.customer_id, Customer.name)
    )
    rows = [row for row in (await db.execute(stmt)).all() if row.created]
    rows.sort(key=lambda row: (-row.created, row.name))
    top = [
        CustomerPulse(
            id=row.customer_id,
            name=row.name,
            created=row.created,
            on_time=Ratio(count=row.on_time_ok, base=row.on_time_base),
            breached=row.breached,
            filters=ListFilters(customer_id=row.customer_id, created_from=m.recent_from),
            breached_filters=(
                ListFilters(
                    customer_id=row.customer_id, sla_breached=True, created_from=m.recent_from
                )
                if row.breached
                else None
            ),
        )
        for row in rows[:TOP_CUSTOMERS]
    ]
    return HomeCustomers(active=len(rows), entered=entered, top=top)


def _money(value: Any) -> Decimal:
    return Decimal(value or 0).quantize(Decimal("0.01"))


async def _finance(db: AsyncSession, m: Moment) -> HomeFinance:
    """Pagamentos dos técnicos, a etiqueta de pagamento pendente, orçamentos e custos extras.
    Sem lançamento o valor sai 0: a tela decide "sem valores" pela contagem."""
    done = Ticket.status.in_(DONE)
    late = and_(done, Ticket.resolved_at < m.now - PAYOUT_LATE)
    payouts = (
        await db.execute(
            select(
                func.sum(TicketPayout.amount).filter(done).label("to_pay"),
                func.count().filter(done).label("to_pay_count"),
                func.count(TicketPayout.technician_id.distinct()).filter(done).label("payees"),
                func.count().filter(late).label("late"),
                func.sum(TicketPayout.amount)
                .filter(Ticket.status.not_in(FINISHED))
                .label("expected"),
            )
            .select_from(TicketPayout)
            .join(Ticket, Ticket.id == TicketPayout.ticket_id)
            .where(TicketPayout.status == PayoutStatus.PENDING)
        )
    ).one()

    # A etiqueta que sai quando os técnicos da OS são pagos ("Pendente Envio PGTO"): enquanto os
    # valores não são lançados, ela é o sinal do que falta pagar.
    rules = await tag_rules.get_rules(db)
    names = [name for name in rules.remove_on_payout_paid if tag_rules.tag_key(name)]
    tag_tickets = tag_technicians = tag_old = 0
    if names:
        keys = {tag_rules.tag_key(name) for name in names}
        stmt = (
            select(
                func.count(),
                func.count(Ticket.assignee_id.distinct()),
                func.count().filter(Ticket.resolved_at < m.now - TAG_OLD),
            )
            .select_from(Ticket)
            .where(done, has_any_tag(keys))
        )
        tag_tickets, tag_technicians, tag_old = (await db.execute(stmt)).one()

    # Aguardando: a validade de _quotes, sem o mínimo de 3 dias do ponto de atenção.
    waiting = and_(
        Quote.status == QuoteStatus.SENT,
        or_(Quote.valid_until.is_(None), Quote.valid_until >= m.today),
    )
    month_start = month_bounds(m.today.year, m.today.month)[0]
    approved = and_(Quote.status == QuoteStatus.APPROVED, Quote.decided_at >= month_start)
    quotes = (
        await db.execute(
            select(
                func.count().filter(waiting).label("waiting"),
                func.sum(Quote.total).filter(waiting).label("waiting_total"),
                func.count().filter(approved).label("approved"),
                func.sum(Quote.total).filter(approved).label("approved_total"),
            ).select_from(Quote)
        )
    ).one()
    costs = (
        await db.execute(
            select(func.count().label("pending"), func.sum(TicketExpense.total).label("total"))
            .select_from(TicketExpense)
            .where(TicketExpense.status == ExpenseStatus.PENDING)
        )
    ).one()
    return HomeFinance(
        payouts_to_pay=_money(payouts.to_pay),
        payouts_to_pay_count=payouts.to_pay_count,
        payouts_technicians=payouts.payees,
        payouts_late=payouts.late,
        payouts_expected=_money(payouts.expected),
        payout_tag=names[0] if names else None,
        payout_tag_tickets=tag_tickets,
        payout_tag_technicians=tag_technicians,
        payout_tag_over_30d=tag_old,
        payout_tag_filters=ListFilters(status=list(DONE), tag=names) if names else None,
        quotes_waiting=quotes.waiting,
        quotes_waiting_total=_money(quotes.waiting_total),
        quotes_approved_month=quotes.approved,
        quotes_approved_month_total=_money(quotes.approved_total),
        costs_pending=costs.pending,
        costs_pending_total=_money(costs.total),
    )


def _focus(counts: dict[str, Any]) -> HomeFocus:
    return HomeFocus(total=counts["now_total"], next_visit_at=counts["next_visit_at"])


def _today(m: Moment, counts: dict[str, Any], technicians: int) -> HomeToday:
    return HomeToday(
        planned=counts["scheduled_today"],
        done=counts["today_done"],
        in_field=counts["today_in_field"],
        not_started=counts["today_not_started"],
        on_hold=counts["today_on_hold"],
        upcoming=counts["today_upcoming"],
        unassigned=counts["today_unassigned"],
        unassigned_filters=ListFilters(
            unassigned=True, open_only=True, scheduled_from=m.today, scheduled_to=m.today
        ),
        technicians=technicians,
        resolved=counts["resolved_today"],
    )


def _tomorrow(m: Moment, counts: dict[str, Any], technicians: int) -> HomeTomorrow:
    return HomeTomorrow(
        day=m.tomorrow,
        planned=counts["tomorrow_planned"],
        technicians=technicians,
        unassigned=counts["tomorrow_unassigned"],
        unassigned_filters=ListFilters(
            unassigned=True, open_only=True, scheduled_from=m.tomorrow, scheduled_to=m.tomorrow
        ),
    )


def _backlog(m: Moment, counts: dict[str, Any]) -> HomeBacklog:
    oldest_first = "created_at"
    ages = [
        AgeBucket(
            key="d7",
            count=counts["age_d7"],
            filters=ListFilters(
                open_only=True, created_from=m.today - timedelta(days=6), order_by=oldest_first
            ),
        ),
        AgeBucket(
            key="d30",
            count=counts["age_d30"],
            filters=ListFilters(
                open_only=True,
                created_from=m.recent_from,
                created_to=m.today - timedelta(days=7),
                order_by=oldest_first,
            ),
        ),
        AgeBucket(
            key="d90",
            count=counts["age_d90"],
            filters=ListFilters(
                open_only=True,
                created_from=m.today - timedelta(days=89),
                created_to=m.old_to,
                order_by=oldest_first,
            ),
        ),
        AgeBucket(
            key="older",
            count=counts["age_older"],
            filters=ListFilters(
                open_only=True, created_to=m.today - timedelta(days=90), order_by=oldest_first
            ),
        ),
    ]
    reasons = [
        OldReason(
            key="no_owner",
            label="Sem analista responsável",
            count=counts["old_no_owner"],
            filters=ListFilters(no_owner=True, open_only=True, created_to=m.old_to),
        ),
        OldReason(
            key="unassigned",
            label="Sem técnico",
            count=counts["old_unassigned"],
            filters=ListFilters(unassigned=True, open_only=True, created_to=m.old_to),
        ),
        OldReason(
            key="overdue_visit",
            label="Visita passou sem baixa",
            count=counts["old_overdue_visit"],
            filters=ListFilters(
                status=list(NOT_STARTED),
                scheduled_to=m.today - timedelta(days=1),
                created_to=m.old_to,
            ),
        ),
        OldReason(
            key="sla_breached",
            label="SLA estourado",
            count=counts["old_sla_breached"],
            filters=ListFilters(sla_breached=True, created_to=m.old_to),
        ),
        # A lista não filtra improdutivas: sem filtro, a tela não mostra "Ver todas".
        OldReason(
            key="unproductive", label="Improdutiva sem reagendar", count=counts["old_unproductive"]
        ),
    ]
    median = counts["median_age_s"]
    return HomeBacklog(
        open=counts["open"],
        recent=counts["open_recent"],
        old=counts["open"] - counts["open_recent"],
        median_age_days=round(median / 86400, 1) if median is not None else None,
        ages=ages,
        entered_30d=counts["entered_30d"],
        resolved_30d=counts["resolved_30d"],
        cancelled_30d=counts["cancelled_30d"],
        # Maior primeiro; no empate, a ordem acima (o sort é estável).
        old_reasons=sorted((r for r in reasons if r.count), key=lambda r: -r.count),
        old_filters=ListFilters(open_only=True, created_to=m.old_to, order_by=oldest_first),
    )


def _quality(counts: dict[str, Any], store_return: Ratio, unproductive: int) -> HomeQuality:
    return HomeQuality(
        on_time=Ratio(count=counts["on_time_ok"], base=counts["on_time_base"]),
        resolution_sla=Ratio(count=counts["sla_ok"], base=counts["sla_base"]),
        resolution_sla_imported=counts["sla_imported"],
        store_return=store_return,
        return_days=RETURN_DAYS,
        unproductive=unproductive,
        visits=counts["arrivals_30d"] + unproductive,
    )


def _team(rows: list[Any], counts: dict[str, Any], onsite_hours: int) -> HomeTeam:
    per_technician = sorted((row.resolved for row in rows), reverse=True)
    median = counts["onsite_median_s"]
    return HomeTeam(
        worked=len(per_technician),
        resolved=sum(per_technician),
        top3_resolved=sum(per_technician[:3]),
        in_app=sum(1 for row in rows if row.last_login_at is not None),
        onsite_median_minutes=round(median / 60) if median is not None else None,
        onsite_over=Ratio(count=counts["onsite_over"], base=counts["onsite_base"]),
        onsite_limit_hours=onsite_hours,
    )


def _weeks(m: Moment, counts: dict[str, Any]) -> list[WeekFlow]:
    return [
        WeekFlow(
            start=start,
            created=counts[f"week_created_{i}"],
            resolved=counts[f"week_resolved_{i}"],
        )
        for i, start in enumerate(m.week_starts)
    ]


async def _pulse(
    db: AsyncSession, m: Moment, counts: dict[str, Any], onsite_hours: int
) -> HomePulse:
    today_technicians, tomorrow_technicians = await _visit_technicians(db, m)
    store_return = await _store_return(db, m)
    unproductive = await _unproductive_events(db, m)
    team_rows = await _team_rows(db, m)
    return HomePulse(
        window_from=m.recent_from,
        today=_today(m, counts, today_technicians),
        tomorrow=_tomorrow(m, counts, tomorrow_technicians),
        backlog=_backlog(m, counts),
        quality=_quality(counts, store_return, unproductive),
        team=_team(team_rows, counts, onsite_hours),
        customers=await _customers(db, m, counts["entered_30d"]),
        # Todos que abrem a tela (TicketManagerUser) veem os valores.
        finance=await _finance(db, m),
        weeks=_weeks(m, counts),
    )


# --------------------------------------------------------------------------- tela


async def overview(db: AsyncSession) -> HomeOverview:
    m = _moment()
    # A varredura tem cerca de 80 expressões e o custo estimado passa do jit_above_cost: o
    # PostgreSQL gastava ~0,9 s compilando (JIT) consultas que rodam em ~0,2 s. Desligado só até o
    # fim da transação deste pedido (o SET LOCAL de set_config com is_local; a tela só lê).
    await db.execute(select(func.set_config("jit", "off", True)))
    rules = await field_svc.rules(db)
    counts = await _ticket_counts(db, m, rules.onsite_hours)
    attention = await _attention(db, m, counts)
    rows = await _recent_rows(db, m)
    suggestions = await _suggestions(db, m, counts, rows)
    return HomeOverview(
        generated_at=m.now,
        kpis=HomeKpis(
            open=counts["open"],
            scheduled_today=counts["scheduled_today"],
            in_field_now=counts["in_field_now"],
            resolved_today=counts["resolved_today"],
            late=counts["late"],
            unassigned=counts["open_unassigned"],
        ),
        attention=attention,
        suggestions=suggestions,
        week=_week(rows, m),
        focus=_focus(counts),
        pulse=await _pulse(db, m, counts, rules.onsite_hours),
    )

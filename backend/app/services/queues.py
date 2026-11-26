"""Fila do analista: as OS de que ele é responsável (ou que ele mesmo executa), organizadas.

Cada OS cai numa seção (precisa de atenção, em campo, hoje, aguardando, próximas, sem agenda,
concluídas no dia) e traz os motivos de atenção (SLA, sem técnico, atrasada, improdutiva...).

Os números saem de uma contagem só (queue_counts), sem limite e sempre pelo analista
responsável: os cartões da Minha fila e a linha do analista em "Filas da equipe" dão o mesmo
número. As OS que ele só executa ficam na lista e num número à parte (executing_only).
"""

import uuid
from collections import defaultdict
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import ColumnElement, and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.enums import (
    OperationalStatus,
    PartRequestStatus,
    SlaStatus,
    TicketEventType,
    TicketStatus,
    UserRole,
)
from app.db.base import utcnow
from app.models import Ticket, TicketEvent, User
from app.models.part_request import TicketPartRequest
from app.models.user import TICKET_MANAGER_ROLES
from app.schemas.queues import (
    MyQueue,
    MyQueueCounts,
    QueueCounts,
    QueueItem,
    QueueReason,
    TeamQueue,
    TeamQueues,
)
from app.schemas.user import UserRef
from app.services import field as field_rules
from app.services import sla
from app.services.activities import day_bounds, local_today
from app.services.technician_regions import km_text
from app.services.tickets import LIST_NOLOAD, recurrence_counts, visibility_clause
from app.services.workflow import OPEN_STATUSES

S = TicketStatus
FIELD = field_rules.FIELD
WAITING = (S.ON_HOLD_CUSTOMER, S.ON_HOLD_VENDOR)
DONE = (S.RESOLVED, S.CLOSED)
LATE_FROM = (S.ASSIGNED, S.SCHEDULED)
SECTION_ORDER = ("attention", "in_field", "today", "waiting", "upcoming", "unscheduled", "done")
TONE_RANK = {"danger": 0, "warning": 1, "info": 2}
LIMIT = 500
# Check-in (início do atendimento) registrado mais longe que isto da loja: a central confere.
CHECKIN_FAR_M = 1000
# Em campo há mais de 12 h (services/field.py): dado parado, vai para "precisa de atenção".
FIELD_STUCK = "field_stuck"
# Técnico responsável fora de Ativo na operação (services/technician_status.py): code, texto e
# tom. "inactive_technician" é outro motivo, o de antes: sem acesso ao app.
NOT_ACTIVE_REASON = {
    OperationalStatus.INACTIVE: ("technician_inactive", "Técnico inativo: troque", "warning"),
    OperationalStatus.BLOCKED: ("technician_blocked", "Técnico bloqueado: troque", "danger"),
}

# Colunas que os motivos e as seções leem (a contagem não carrega a OS inteira).
_COUNT_COLUMNS = (
    Ticket.id,
    Ticket.owner_id,
    Ticket.status,
    Ticket.arrival_due_at,
    Ticket.arrived_at,
    Ticket.onsite_due_at,
    Ticket.onsite_warning_at,
    Ticket.scheduled_start,
    Ticket.created_at,
    Ticket.response_due_at,
    Ticket.resolution_due_at,
    Ticket.first_response_at,
    Ticket.resolved_at,
    Ticket.resolution_sla_met_at,
    Ticket.sla_paused_at,
    Ticket.sla_paused_seconds,
    Ticket.last_unproductive_at,
)


def _since_text(delta: timedelta) -> str:
    """ "13 h", "1 dia", "5 dias" (a regra só vale depois de 12 h)."""
    hours = max(0, int(delta.total_seconds() // 3600))
    if hours < 24:
        return f"{hours} h"
    days = hours // 24
    return "1 dia" if days == 1 else f"{days} dias"


def _field_reasons(
    t: Any,
    now: datetime,
    part_request_open: bool,
    checkin_far_m: int | None = None,
    *,
    clocks: bool = True,
) -> list[QueueReason]:
    """Regras de campo: os dois relógios de 4h, o check-in longe da loja e pedido de peça. Sem
    `clocks` (OS parada em campo), os relógios da visita ficam de fora: ela não está acontecendo.
    Esperando data nova depois da improdutiva, não há chegada a cobrar (o técnico foi): o motivo
    é o "Improdutiva: reagendar", como na Início."""
    reasons: list[QueueReason] = []
    if clocks:
        new_date = field_rules.awaiting_new_visit(t)
        arrival = None if new_date else field_rules.arrival_status(t, now)
        if arrival == "late" and t.arrived_at is None:
            reasons.append(
                QueueReason(code="arrival_late", label="Chegada atrasada", tone="danger")
            )
        elif arrival == "at_risk":
            reasons.append(
                QueueReason(code="arrival_at_risk", label="Chegada em risco", tone="warning")
            )
        onsite = field_rules.onsite_status(t, now)
        if onsite == "over":
            reasons.append(
                QueueReason(code="onsite_over", label="Passou do tempo na loja", tone="danger")
            )
        elif onsite == "warning":
            reasons.append(
                QueueReason(code="onsite_warning", label="Perto do limite na loja", tone="warning")
            )
    if t.status == S.IN_PROGRESS and checkin_far_m is not None and checkin_far_m > CHECKIN_FAR_M:
        reasons.append(
            QueueReason(
                code="checkin_far",
                label=f"Check-in a {km_text(checkin_far_m / 1000)} km da loja",
                tone="warning",
            )
        )
    if part_request_open:
        reasons.append(QueueReason(code="part_request", label="Técnico pediu peça", tone="warning"))
    return reasons


def reasons_for(
    t: Any,
    now: datetime,
    assignee_role: UserRole | None,
    *,
    part_request_open: bool = False,
    assignee_active: bool | None = None,
    assignee_status: str | None = None,
    checkin_far_m: int | None = None,
    field_since: datetime | None = None,
) -> list[QueueReason]:
    """Motivos de atenção da OS (serve para a OS do ORM e para linhas de consulta). `field_since`
    é desde quando ela está em campo (services/field.py), para a regra das 12 h;
    `assignee_active` e `assignee_status`, o acesso ao app e a situação na operação do técnico
    responsável."""
    reasons: list[QueueReason] = []
    is_open = t.status in OPEN_STATUSES
    if is_open:
        stuck = field_rules.field_stuck(t, field_since, now)
        if stuck and field_since is not None:
            reasons.append(
                QueueReason(
                    code=FIELD_STUCK,
                    label=f"Em campo há {_since_text(now - field_since)}: conclua ou corrija",
                    tone="danger",
                )
            )
        reasons.extend(_field_reasons(t, now, part_request_open, checkin_far_m, clocks=not stuck))
        status = sla.compute_sla_status(t, now)
        if status == SlaStatus.BREACHED:
            reasons.append(QueueReason(code="sla_violated", label="SLA violado", tone="danger"))
        elif status == SlaStatus.AT_RISK:
            reasons.append(QueueReason(code="sla_at_risk", label="SLA em risco", tone="warning"))
        # "Atrasada": 30 min depois do horário e sem improdutiva no horário ou depois (a mesma
        # regra das Atividades do dia e do "sem início" da Início, services/field.py).
        if (
            t.status in LATE_FROM
            and field_rules.late_to_start(t.scheduled_start, now)
            and not field_rules.bounced_after_schedule(t)
        ):
            reasons.append(QueueReason(code="late_start", label="Atrasada", tone="danger"))
        if t.status not in WAITING and assignee_role != UserRole.TECHNICIAN:
            reasons.append(QueueReason(code="no_technician", label="Sem técnico", tone="warning"))
        if assignee_role == UserRole.TECHNICIAN:
            status = OperationalStatus(assignee_status or OperationalStatus.ACTIVE)
            if status != OperationalStatus.ACTIVE:
                # Fora de Ativo na operação: a OS que ele já tem fica com ele, mas a central troca
                # (liberar o acesso não resolve, então o "sem acesso" não entra junto).
                code, label, tone = NOT_ACTIVE_REASON[status]
                reasons.append(QueueReason(code=code, label=label, tone=tone))
            elif assignee_active is False:
                # Sem acesso ao app (no Field Control, "inativo" é só sem licença, e ele continua
                # atendendo): a OS não chega ao app até alguém liberar o acesso (Técnicos) ou
                # trocar o técnico.
                reasons.append(
                    QueueReason(
                        code="inactive_technician",
                        label="Técnico sem acesso: libere ou troque",
                        tone="warning",
                    )
                )
        # Esperando data nova depois da improdutiva (em campo de novo, não: a visita está
        # acontecendo), como o grupo "Improdutivas sem reagendar" da Início.
        if t.status not in FIELD and field_rules.awaiting_new_visit(t):
            reasons.append(
                QueueReason(code="unproductive", label="Improdutiva: reagendar", tone="warning")
            )
    elif t.status in DONE:
        pending = (sla.response_breached(t, now) and t.response_violation_reason_id is None) or (
            sla.resolution_breached(t, now) and t.resolution_violation_reason_id is None
        )
        if pending:
            reasons.append(
                QueueReason(code="violation_pending", label="Justificar SLA", tone="info")
            )
    reasons.sort(key=lambda r: TONE_RANK[r.tone])
    return reasons


def section_for(t: Any, reasons: list[QueueReason], day_start: datetime, day_end: datetime) -> str:
    if t.status in FIELD:
        # Parada em campo há mais de 12 h: ninguém está lá agora, precisa de alguém.
        return "attention" if any(r.code == FIELD_STUCK for r in reasons) else "in_field"
    if t.status in DONE:
        return "done"
    if any(r.tone in ("danger", "warning") for r in reasons):
        return "attention"
    start = t.scheduled_start
    if start is not None and day_start <= start < day_end:
        return "today"
    if t.status in WAITING:
        return "waiting"
    if start is not None and start >= day_end:
        return "upcoming"
    return "unscheduled"


def _sort_key(item: QueueItem) -> tuple[Any, ...]:
    far = float("inf")
    due = item.resolution_due_at.timestamp() if item.resolution_due_at else far
    section = SECTION_ORDER.index(item.section)
    if item.section == "attention":
        worst = min((TONE_RANK[r.tone] for r in item.reasons), default=3)
        return (section, worst, due)
    if item.section == "in_field":
        return (section, -item.updated_at.timestamp())
    if item.section in ("today", "upcoming"):
        start = item.scheduled_start.timestamp() if item.scheduled_start else far
        return (section, start, due)
    if item.section == "done":
        finished = item.resolved_at.timestamp() if item.resolved_at else 0
        return (section, -finished)
    return (section, due)


async def far_checkins(db: AsyncSession, ticket_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """OS em atendimento cuja chegada (a última entrada em "Em atendimento") foi registrada
    longe da loja: a distância em metros. Uma consulta para a fila inteira."""
    if not ticket_ids:
        return {}
    rows = await db.execute(
        select(TicketEvent.ticket_id, TicketEvent.data)
        .where(
            TicketEvent.ticket_id.in_(ticket_ids),
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            TicketEvent.to_value == S.IN_PROGRESS.value,
        )
        .distinct(TicketEvent.ticket_id)
        .order_by(TicketEvent.ticket_id, TicketEvent.created_at.desc())
    )
    out: dict[uuid.UUID, int] = {}
    for ticket_id, data in rows.all():
        distance = (data or {}).get("distance_m")
        if isinstance(distance, int | float) and distance > CHECKIN_FAR_M:
            out[ticket_id] = int(distance)
    return out


def needs_attention(section: str, reasons: list[QueueReason]) -> bool:
    """Seção "atenção" ou em campo com alerta (ex.: passou de 4h)."""
    if section == "attention":
        return True
    return section == "in_field" and any(r.tone in ("danger", "warning") for r in reasons)


def _finished_in(day_start: datetime, day_end: datetime) -> ColumnElement[bool]:
    """Concluída no dia: resolvida nele (como a Início). O fechamento automático, dias depois,
    não conta de novo."""
    return and_(
        Ticket.status.in_(DONE), Ticket.resolved_at >= day_start, Ticket.resolved_at < day_end
    )


def _scope(viewer: User | None) -> tuple[ColumnElement[bool], ...]:
    vis = visibility_clause(viewer) if viewer is not None else None
    return (vis,) if vis is not None else ()


async def queue_counts(
    db: AsyncSession,
    *conds: ColumnElement[bool],
    now: datetime,
    day_start: datetime,
    day_end: datetime,
    bucket: Callable[[uuid.UUID | None], uuid.UUID | None] = lambda owner_id: owner_id,
    with_done: bool = False,
) -> dict[uuid.UUID | None, MyQueueCounts]:
    """Os números de cada fila, pelo analista responsável (`bucket` agrupa o dono) e sem limite:
    - open: em aberto;
    - attention: precisam de atenção (needs_attention: a seção "atenção" e a OS em campo com
      alerta; a parada em campo há mais de 12 h entra aqui);
    - today: em aberto agendadas para o dia;
    - in_field: em campo agora (a caminho ou em atendimento há até 12 h);
    - waiting, upcoming e unscheduled: o tamanho dessas seções;
    - done (com `with_done`): resolvidas no dia.
    A mesma conta serve aos cartões da Minha fila e ao painel "Filas da equipe"."""
    opened = Ticket.status.in_(OPEN_STATUSES)
    which = or_(opened, _finished_in(day_start, day_end)) if with_done else opened
    rows = (
        await db.execute(
            select(
                *_COUNT_COLUMNS,
                field_rules.field_since().label("field_since"),
                User.role.label("assignee_role"),
                User.is_active.label("assignee_active"),
                User.operational_status.label("assignee_status"),
            )
            .outerjoin(User, User.id == Ticket.assignee_id)
            .where(which, *conds)
        )
    ).all()
    asking = await open_part_requests(db)
    far = await far_checkins(db, [row.id for row in rows if row.status == S.IN_PROGRESS])
    counts: dict[uuid.UUID | None, MyQueueCounts] = defaultdict(MyQueueCounts)
    for row in rows:
        c = counts[bucket(row.owner_id)]
        if row.status not in OPEN_STATUSES:
            c.done += 1
            continue
        reasons = reasons_for(
            row,
            now,
            row.assignee_role,
            part_request_open=row.id in asking,
            assignee_active=row.assignee_active,
            assignee_status=row.assignee_status,
            checkin_far_m=far.get(row.id),
            field_since=row.field_since,
        )
        section = section_for(row, reasons, day_start, day_end)
        c.open += 1
        if needs_attention(section, reasons):
            c.attention += 1
        if section == "in_field":
            c.in_field += 1
        if row.scheduled_start is not None and day_start <= row.scheduled_start < day_end:
            c.today += 1
        if section in ("waiting", "upcoming", "unscheduled"):
            setattr(c, section, getattr(c, section) + 1)
    return counts


async def my_queue(
    db: AsyncSession, target: User, day: date | None = None, viewer: User | None = None
) -> MyQueue:
    """A fila de `target`: as OS de que ele é o responsável ou o executor. Os números (`counts`)
    contam só as de que ele é o responsável, como o painel da equipe; as que ele só executa vêm
    em `executing_only`. `viewer` (quem pede) limita ao que ele vê."""
    now = utcnow()
    day = day or local_today()
    day_start, day_end = day_bounds(day)
    scope = _scope(viewer)
    in_queue = (
        or_(Ticket.owner_id == target.id, Ticket.assignee_id == target.id),
        or_(Ticket.status.in_(OPEN_STATUSES), _finished_in(day_start, day_end)),
        *scope,
    )
    # Fila muito grande: ficam as em aberto de prazo mais apertado (as paradas há mais tempo,
    # que mais precisam de alguém), e a resposta avisa que cortou.
    tickets = list(
        await db.scalars(
            select(Ticket)
            .options(*LIST_NOLOAD)
            .where(*in_queue)
            .order_by(
                case((Ticket.status.in_(OPEN_STATUSES), 0), else_=1),
                Ticket.resolution_due_at.asc().nulls_last(),
                Ticket.updated_at.desc(),
            )
            .limit(LIMIT)
        )
    )
    total, executing_only = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(
                    Ticket.status.in_(OPEN_STATUSES), Ticket.owner_id.is_distinct_from(target.id)
                ),
            ).where(*in_queue)
        )
    ).one()
    by_owner = await queue_counts(
        db,
        Ticket.owner_id == target.id,
        *scope,
        now=now,
        day_start=day_start,
        day_end=day_end,
        with_done=True,
    )
    asking = await open_part_requests(db, [t.id for t in tickets])
    far = await far_checkins(db, [t.id for t in tickets if t.status == S.IN_PROGRESS])
    since = await field_rules.field_since_of(db, [t.id for t in tickets if t.status in FIELD])
    recurrence = await recurrence_counts(db, tickets, now, user=viewer)
    items: list[QueueItem] = []
    for t in tickets:
        reasons = reasons_for(
            t,
            now,
            t.assignee.role if t.assignee else None,
            part_request_open=t.id in asking,
            assignee_active=t.assignee.is_active if t.assignee else None,
            assignee_status=t.assignee.operational_status if t.assignee else None,
            checkin_far_m=far.get(t.id),
            field_since=since.get(t.id),
        )
        item = QueueItem.model_validate(t)
        item.reasons = reasons
        item.section = section_for(t, reasons, day_start, day_end)  # type: ignore[assignment]
        item.recurrence_30d = recurrence.get(t.id, 0)
        items.append(item)
    items.sort(key=_sort_key)
    return MyQueue(
        user=UserRef.model_validate(target),
        date=day,
        generated_at=now,
        counts=by_owner.get(target.id, MyQueueCounts()),
        items=items,
        total=total,
        truncated=total > len(items),
        executing_only=executing_only,
    )


async def open_part_requests(
    db: AsyncSession, ticket_ids: list[uuid.UUID] | None = None
) -> set[uuid.UUID]:
    """OS com pedido de peça do técnico ainda sem orçamento (aberto)."""
    query = select(TicketPartRequest.ticket_id).where(
        TicketPartRequest.status == PartRequestStatus.OPEN
    )
    if ticket_ids is not None:
        if not ticket_ids:
            return set()
        query = query.where(TicketPartRequest.ticket_id.in_(ticket_ids))
    return set(await db.scalars(query.distinct()))


async def team_queues(db: AsyncSession, viewer: User | None = None) -> TeamQueues:
    """Tamanho da fila de cada analista/gestor (e das OS sem analista) para hoje, com a mesma
    contagem dos cartões da Minha fila (queue_counts). OS de um analista que saiu da gestão
    (desativado ou com outro papel) contam como sem analista.

    `viewer` (quem pede) limita ao que ele vê: com "Somente a própria fila", só a linha dele e,
    com a opção, a sem analista. A divisão por fila usa todos os gestores ativos; só a saída é
    filtrada."""
    acc = permissions.of(viewer) if viewer is not None else None
    own = acc is not None and not acc.all_queues
    day_start, day_end = day_bounds(local_today())
    managers = list(
        await db.scalars(
            select(User)
            .where(User.is_active.is_(True), User.role.in_(TICKET_MANAGER_ROLES))
            .order_by(User.name)
        )
    )
    manager_ids = {u.id for u in managers}
    by_owner = await queue_counts(
        db,
        *_scope(viewer),
        now=utcnow(),
        day_start=day_start,
        day_end=day_end,
        bucket=lambda owner_id: owner_id if owner_id in manager_ids else None,
    )

    def panel(key: uuid.UUID | None) -> QueueCounts:
        found = by_owner.get(key)
        if found is None:
            return QueueCounts()
        return QueueCounts(**found.model_dump(include=set(QueueCounts.model_fields)))

    queues = [
        TeamQueue(user=UserRef.model_validate(u), role=u.role, **panel(u.id).model_dump())
        for u in managers
        if not own or (viewer is not None and u.id == viewer.id)
    ]
    unowned = panel(None) if not own or (acc and acc.queue_unowned) else None
    total = QueueCounts()
    for part in [*queues, *([unowned] if unowned is not None else [])]:
        for key in QueueCounts.model_fields:
            setattr(total, key, getattr(total, key) + getattr(part, key))
    return TeamQueues(
        queues=queues,
        unowned=unowned,
        scope=acc.queue_scope if acc is not None else "all",
        total=total,
    )

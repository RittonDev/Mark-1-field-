"""Fila do analista: as OS de que ele é responsável (ou que ele mesmo executa), organizadas.

Cada OS cai numa seção (em campo, precisa de atenção, hoje, aguardando, próximas, sem agenda,
concluídas no dia) e traz os motivos de atenção (SLA, sem técnico, atrasada, improdutiva...).
"""

import uuid
from collections import Counter, defaultdict
from datetime import date, datetime
from typing import Any

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import PartRequestStatus, SlaStatus, TicketEventType, TicketStatus, UserRole
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
from app.services.tickets import LIST_NOLOAD, recurrence_counts
from app.services.workflow import OPEN_STATUSES

S = TicketStatus
FIELD = (S.EN_ROUTE, S.IN_PROGRESS)
WAITING = (S.ON_HOLD_CUSTOMER, S.ON_HOLD_VENDOR)
DONE = (S.RESOLVED, S.CLOSED)
LATE_FROM = (S.ASSIGNED, S.SCHEDULED)
SECTION_ORDER = ("attention", "in_field", "today", "waiting", "upcoming", "unscheduled", "done")
TONE_RANK = {"danger": 0, "warning": 1, "info": 2}
LIMIT = 500
# Check-in (início do atendimento) registrado mais longe que isto da loja: a central confere.
CHECKIN_FAR_M = 1000


def _field_reasons(
    t: Any, now: datetime, part_request_open: bool, checkin_far_m: int | None = None
) -> list[QueueReason]:
    """Regras de campo: os dois relógios de 4h, o check-in longe da loja e pedido de peça."""
    reasons: list[QueueReason] = []
    arrival = field_rules.arrival_status(t, now)
    if arrival == "late" and t.arrived_at is None:
        reasons.append(QueueReason(code="arrival_late", label="Chegada atrasada", tone="danger"))
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
    checkin_far_m: int | None = None,
) -> list[QueueReason]:
    """Motivos de atenção da OS (serve para a OS do ORM e para linhas de consulta)."""
    reasons: list[QueueReason] = []
    is_open = t.status in OPEN_STATUSES
    if is_open:
        reasons.extend(_field_reasons(t, now, part_request_open, checkin_far_m))
        status = sla.compute_sla_status(t, now)
        if status == SlaStatus.BREACHED:
            reasons.append(QueueReason(code="sla_violated", label="SLA violado", tone="danger"))
        elif status == SlaStatus.AT_RISK:
            reasons.append(QueueReason(code="sla_at_risk", label="SLA em risco", tone="warning"))
        if t.status in LATE_FROM and t.scheduled_start is not None and t.scheduled_start < now:
            reasons.append(QueueReason(code="late_start", label="Atrasada", tone="danger"))
        if t.status not in WAITING and assignee_role != UserRole.TECHNICIAN:
            reasons.append(QueueReason(code="no_technician", label="Sem técnico", tone="warning"))
        # Técnico desativado não entra no app: a OS fica parada até alguém reatribuir.
        if assignee_role == UserRole.TECHNICIAN and assignee_active is False:
            reasons.append(
                QueueReason(
                    code="inactive_technician", label="Técnico inativo: reatribua", tone="danger"
                )
            )
        if t.last_unproductive_at is not None and (
            t.scheduled_start is None or t.scheduled_start < t.last_unproductive_at
        ):
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
        return "in_field"
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


async def my_queue(db: AsyncSession, target: User, day: date | None = None) -> MyQueue:
    now = utcnow()
    day = day or local_today()
    day_start, day_end = day_bounds(day)
    finished_in_day = or_(
        and_(Ticket.resolved_at >= day_start, Ticket.resolved_at < day_end),
        and_(Ticket.closed_at >= day_start, Ticket.closed_at < day_end),
    )
    in_queue = (
        or_(Ticket.owner_id == target.id, Ticket.assignee_id == target.id),
        or_(
            Ticket.status.in_(OPEN_STATUSES),
            and_(Ticket.status.in_(DONE), finished_in_day),
        ),
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
    total, open_total = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(Ticket.status.in_(OPEN_STATUSES)),
            ).where(*in_queue)
        )
    ).one()
    asking = await open_part_requests(db, [t.id for t in tickets])
    far = await far_checkins(db, [t.id for t in tickets if t.status == S.IN_PROGRESS])
    recurrence = await recurrence_counts(db, tickets, now)
    items: list[QueueItem] = []
    for t in tickets:
        reasons = reasons_for(
            t,
            now,
            t.assignee.role if t.assignee else None,
            part_request_open=t.id in asking,
            assignee_active=t.assignee.is_active if t.assignee else None,
            checkin_far_m=far.get(t.id),
        )
        item = QueueItem.model_validate(t)
        item.reasons = reasons
        item.section = section_for(t, reasons, day_start, day_end)  # type: ignore[assignment]
        item.recurrence_30d = recurrence.get(t.id, 0)
        items.append(item)
    items.sort(key=_sort_key)
    sections = Counter(i.section for i in items)
    counts = MyQueueCounts(
        open=open_total,
        **{name: sections[name] for name in SECTION_ORDER},
    )
    return MyQueue(
        user=UserRef.model_validate(target),
        date=day,
        generated_at=now,
        counts=counts,
        items=items,
        total=total,
        truncated=total > len(items),
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


def needs_attention(section: str, reasons: list[QueueReason]) -> bool:
    """Para as filas da equipe: seção "atenção" ou em campo com alerta (ex.: passou de 4h)."""
    if section == "attention":
        return True
    return section == "in_field" and any(r.tone in ("danger", "warning") for r in reasons)


async def team_queues(db: AsyncSession) -> TeamQueues:
    """Tamanho da fila de cada analista/gestor (e das OS sem analista) para hoje. OS de um
    analista que saiu da gestão (desativado ou com outro papel) contam como sem analista."""
    now = utcnow()
    day_start, day_end = day_bounds(local_today())
    asking = await open_part_requests(db)
    managers = list(
        await db.scalars(
            select(User)
            .where(User.is_active.is_(True), User.role.in_(TICKET_MANAGER_ROLES))
            .order_by(User.name)
        )
    )
    manager_ids = {u.id for u in managers}
    rows = (
        await db.execute(
            select(
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
                Ticket.sla_paused_at,
                Ticket.sla_paused_seconds,
                Ticket.last_unproductive_at,
                User.role.label("assignee_role"),
                User.is_active.label("assignee_active"),
            )
            .outerjoin(User, User.id == Ticket.assignee_id)
            .where(Ticket.status.in_(OPEN_STATUSES))
        )
    ).all()
    far = await far_checkins(db, [row.id for row in rows if row.status == S.IN_PROGRESS])
    counts: dict[uuid.UUID | None, QueueCounts] = defaultdict(QueueCounts)
    for row in rows:
        c = counts[row.owner_id if row.owner_id in manager_ids else None]
        c.open += 1
        if row.status in FIELD:
            c.in_field += 1
        if row.scheduled_start is not None and day_start <= row.scheduled_start < day_end:
            c.today += 1
        reasons = reasons_for(
            row,
            now,
            row.assignee_role,
            part_request_open=row.id in asking,
            assignee_active=row.assignee_active,
            checkin_far_m=far.get(row.id),
        )
        if needs_attention(section_for(row, reasons, day_start, day_end), reasons):
            c.attention += 1
    return TeamQueues(
        queues=[
            TeamQueue(
                user=UserRef.model_validate(u),
                role=u.role,
                **counts.get(u.id, QueueCounts()).model_dump(),
            )
            for u in managers
        ],
        unowned=counts.get(None, QueueCounts()),
    )

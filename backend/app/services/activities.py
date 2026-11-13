"""Atividades do dia: a visão de quem opera o campo (tela própria no Field Control).

Entram no dia D, no fuso de settings.TIMEZONE:
- OS agendadas para D;
- OS que tiveram deslocamento, atendimento ou conclusão em D (pelo histórico);
- se D é hoje, as OS que estão em campo agora (em deslocamento ou em atendimento).

Os horários reais vêm do histórico de status, então o agendado e o realizado ficam lado a lado.
"""

import uuid
from collections import Counter
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import TicketEventType, TicketStatus
from app.db.base import utcnow
from app.models import Ticket, TicketEvent, User
from app.schemas.activities import Activity, ActivityState, DayActivities, DaySummary
from app.schemas.ticket import TicketListItem
from app.services.durations import actual_seconds
from app.services.schedule import works_on
from app.services.tickets import visibility_clause
from app.services.workflow import SLA_PAUSED_STATUSES

S = TicketStatus
FIELD_NOW = (S.EN_ROUTE, S.IN_PROGRESS)
WORK_TARGETS = (S.EN_ROUTE.value, S.IN_PROGRESS.value, S.RESOLVED.value)


def day_bounds(day: date) -> tuple[datetime, datetime]:
    tz = ZoneInfo(settings.TIMEZONE)
    start = datetime.combine(day, time.min, tzinfo=tz)
    return start, start + timedelta(days=1)


def local_today() -> date:
    return datetime.now(ZoneInfo(settings.TIMEZONE)).date()


def _in_day(value: datetime | None, start: datetime, end: datetime) -> bool:
    return value is not None and start <= value < end


def _state(
    ticket: Ticket,
    *,
    started: datetime | None,
    finished: datetime | None,
    day_start: datetime,
    day_end: datetime,
    now: datetime,
) -> ActivityState:
    if finished is not None or (
        ticket.status in (S.RESOLVED, S.CLOSED) and _in_day(ticket.resolved_at, day_start, day_end)
    ):
        return "done"
    if ticket.status == S.IN_PROGRESS:
        return "in_progress"
    if ticket.status == S.EN_ROUTE:
        return "en_route"
    if ticket.status in SLA_PAUSED_STATUSES:
        return "on_hold"
    if ticket.status in (S.RESOLVED, S.CLOSED):
        return "done"
    if ticket.status == S.SCHEDULED and not _in_day(ticket.scheduled_start, day_start, day_end):
        return "rescheduled"
    if _in_day(ticket.scheduled_start, day_start, day_end):
        if started is None and ticket.scheduled_start < now:  # type: ignore[operator]
            return "late"
        return "scheduled"
    return "pending"


async def day_activities(
    db: AsyncSession,
    user: User,
    day: date | None = None,
    *,
    assignee_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> DayActivities:
    now = utcnow()
    today = local_today()
    day = day or today
    day_start, day_end = day_bounds(day)

    worked_in_day = select(TicketEvent.ticket_id).where(
        TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
        TicketEvent.to_value.in_(WORK_TARGETS),
        TicketEvent.created_at >= day_start,
        TicketEvent.created_at < day_end,
    )
    belongs = [
        and_(Ticket.scheduled_start >= day_start, Ticket.scheduled_start < day_end),
        Ticket.id.in_(worked_in_day),
    ]
    if day == today:
        belongs.append(Ticket.status.in_(FIELD_NOW))
    conds = [or_(*belongs), Ticket.status != S.CANCELLED]
    vis = visibility_clause(user)
    if vis is not None:
        conds.append(vis)
    if assignee_id is not None:
        # O dia do técnico inclui as visitas em que ele vai junto.
        conds.append(works_on(assignee_id))
    if team_id is not None:
        conds.append(Ticket.team_id == team_id)
    tickets = list(await db.scalars(select(Ticket).where(*conds)))

    events: dict[uuid.UUID, list[TicketEvent]] = {t.id: [] for t in tickets}
    if tickets:
        rows = await db.scalars(
            select(TicketEvent)
            .where(
                TicketEvent.ticket_id.in_(events.keys()),
                TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
                TicketEvent.created_at >= day_start,
                TicketEvent.created_at < day_end,
            )
            .order_by(TicketEvent.created_at)
        )
        for ev in rows:
            events[ev.ticket_id].append(ev)

    # OS em campo desde antes do dia: quando a etapa atual começou (para não ficar sem início).
    carried: dict[uuid.UUID, datetime] = {}
    missing = [
        t.id
        for t in tickets
        if t.status in FIELD_NOW
        and not any(e.to_value in (S.EN_ROUTE.value, S.IN_PROGRESS.value) for e in events[t.id])
    ]
    if missing:
        rows = await db.execute(
            select(TicketEvent.ticket_id, func.max(TicketEvent.created_at))
            .where(
                TicketEvent.ticket_id.in_(missing),
                TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
                TicketEvent.to_value.in_((S.EN_ROUTE.value, S.IN_PROGRESS.value)),
            )
            .group_by(TicketEvent.ticket_id)
        )
        carried = dict(rows.all())

    activities: list[Activity] = []
    for t in tickets:
        evs = events[t.id]
        start_ev = next(
            (e for e in evs if e.to_value in (S.EN_ROUTE.value, S.IN_PROGRESS.value)), None
        )
        arrive_ev = next((e for e in evs if e.to_value == S.IN_PROGRESS.value), None)
        finish_ev = next((e for e in reversed(evs) if e.to_value == S.RESOLVED.value), None)
        started = start_ev.created_at if start_ev else carried.get(t.id)
        delay = None
        if started is not None and _in_day(t.scheduled_start, day_start, day_end):
            delay = int((started - t.scheduled_start).total_seconds() // 60)  # type: ignore[operator]
        activities.append(
            Activity(
                ticket=TicketListItem.model_validate(t),
                state=_state(
                    t,
                    started=started,
                    finished=finish_ev.created_at if finish_ev else None,
                    day_start=day_start,
                    day_end=day_end,
                    now=now,
                ),
                scheduled_start=t.scheduled_start,
                scheduled_end=t.scheduled_end,
                started_at=started,
                arrived_at=arrive_ev.created_at if arrive_ev else None,
                finished_at=finish_ev.created_at if finish_ev else None,
                start_delay_minutes=delay,
                start_has_gps=any(
                    e is not None and "latitude" in (e.data or {}) for e in (start_ev, arrive_ev)
                ),
                service_type_name=t.service_type.name if t.service_type else None,
                description=(t.description or "")[:500],
                estimated_minutes=t.estimated_minutes,
                actual_minutes=actual_seconds(t.work_seconds, t.work_started_at, now) // 60,
            )
        )

    # Pela hora de atuação (a manhã primeiro): a prevista ou, sem agenda, a realizada; as sem hora
    # vão por último. A tela agrupa por técnico na ordem em que aparecem, então quem começa mais
    # cedo vem em cima e, dentro do técnico, as OS seguem o relógio.
    far = datetime.max.replace(tzinfo=day_start.tzinfo)
    activities.sort(
        key=lambda a: (
            a.scheduled_start or a.started_at or far,
            a.ticket.assignee is None,
            a.ticket.assignee.name if a.ticket.assignee else "",
        )
    )
    counts = Counter(a.state for a in activities)
    summary = DaySummary(
        total=len(activities),
        scheduled=counts["scheduled"],
        late=counts["late"],
        en_route=counts["en_route"],
        in_progress=counts["in_progress"],
        on_hold=counts["on_hold"],
        rescheduled=counts["rescheduled"],
        done=counts["done"],
        pending=counts["pending"],
        unassigned=sum(1 for a in activities if a.ticket.assignee is None),
    )
    return DayActivities(
        date=day,
        timezone=settings.TIMEZONE,
        is_today=day == today,
        summary=summary,
        activities=activities,
    )

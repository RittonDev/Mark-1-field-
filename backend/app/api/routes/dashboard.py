from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
from app.core.config import settings
from app.core.enums import SlaStatus, TicketPriority, TicketStatus
from app.db.base import utcnow
from app.models import Ticket, User
from app.schemas.dashboard import AssigneeLoad, DashboardSummary
from app.services.sla import compute_sla_status
from app.services.tickets import visibility_clause
from app.services.workflow import OPEN_STATUSES

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard/summary", response_model=DashboardSummary)
async def summary(db: DB, user: CurrentUser) -> DashboardSummary:
    now = utcnow()
    today = datetime.now(ZoneInfo(settings.TIMEZONE)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    vis = visibility_clause(user)
    scope = [vis] if vis is not None else []

    by_status = {s.value: 0 for s in TicketStatus}
    for status, n in await db.execute(
        select(Ticket.status, func.count()).where(*scope).group_by(Ticket.status)
    ):
        by_status[status.value] = n

    by_priority = {p.value: 0 for p in TicketPriority}
    for priority, n in await db.execute(
        select(Ticket.priority, func.count())
        .where(*scope, Ticket.status.in_(OPEN_STATUSES))
        .group_by(Ticket.priority)
    ):
        by_priority[priority.value] = n

    open_rows = (
        await db.execute(
            select(
                Ticket.status,
                Ticket.assignee_id,
                Ticket.created_at,
                Ticket.response_due_at,
                Ticket.resolution_due_at,
                Ticket.first_response_at,
                Ticket.resolved_at,
                Ticket.sla_paused_at,
                Ticket.sla_paused_seconds,
            ).where(*scope, Ticket.status.in_(OPEN_STATUSES))
        )
    ).all()

    breached = at_risk = unassigned = 0
    load: dict = defaultdict(lambda: {"open": 0, "in_progress": 0, "breached": 0})
    for row in open_rows:
        sla_status = compute_sla_status(row, now)  # type: ignore[arg-type]
        if sla_status == SlaStatus.BREACHED:
            breached += 1
        elif sla_status == SlaStatus.AT_RISK:
            at_risk += 1
        if row.assignee_id is None:
            unassigned += 1
            continue
        entry = load[row.assignee_id]
        entry["open"] += 1
        if row.status in (TicketStatus.EN_ROUTE, TicketStatus.IN_PROGRESS):
            entry["in_progress"] += 1
        if sla_status == SlaStatus.BREACHED:
            entry["breached"] += 1

    names = {}
    if load:
        names = dict(
            (await db.execute(select(User.id, User.name).where(User.id.in_(load.keys())))).all()
        )
    by_assignee = sorted(
        (
            AssigneeLoad(user_id=uid, name=names.get(uid, "—"), **counts)
            for uid, counts in load.items()
        ),
        key=lambda a: (-a.open, a.name),
    )

    created_today = await db.scalar(
        select(func.count()).select_from(Ticket).where(*scope, Ticket.created_at >= today)
    )
    resolved_today = await db.scalar(
        select(func.count()).select_from(Ticket).where(*scope, Ticket.resolved_at >= today)
    )

    since = now - timedelta(days=30)
    resolution_seconds = (
        func.extract("epoch", Ticket.resolved_at - Ticket.created_at) - Ticket.sla_paused_seconds
    )
    avg_seconds, resolved_30d, within_30d = (
        await db.execute(
            select(
                func.avg(resolution_seconds),
                func.count(),
                func.count().filter(Ticket.resolved_at <= Ticket.resolution_due_at),
            ).where(*scope, Ticket.resolved_at.is_not(None), Ticket.resolved_at >= since)
        )
    ).one()

    return DashboardSummary(
        by_status=by_status,
        by_priority=by_priority,
        open_total=len(open_rows),
        unassigned=unassigned,
        sla_breached=breached,
        sla_at_risk=at_risk,
        created_today=created_today or 0,
        resolved_today=resolved_today or 0,
        avg_resolution_minutes_30d=round(float(avg_seconds) / 60, 1) if avg_seconds else None,
        sla_compliance_30d=round(100 * within_30d / resolved_30d, 1) if resolved_30d else None,
        by_assignee=by_assignee,
    )

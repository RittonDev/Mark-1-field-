"""Fechamento diário (o dia fecha à meia-noite, no fuso da operação) e relatório mensal.

Tudo sai da trilha de eventos das OS: assim "quantos ficaram agendados" é o estado de cada OS
no fim do período, e não o de agora.
"""

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    ExpenseStatus,
    QuoteStatus,
    TicketEventType,
    TicketStatus,
)
from app.models import Customer, Quote, Ticket, TicketEvent, TicketExpense, User
from app.schemas.reports import CountRef, DailyReport, DayNumbers, DayPoint, MonthlyReport
from app.services.activities import day_bounds, local_today
from app.services.workflow import OPEN_STATUSES

STATUS_EVENTS = (TicketEventType.CREATED, TicketEventType.STATUS_CHANGED)


async def _status_counts_at(db: AsyncSession, moment: datetime) -> dict[str, int]:
    """Status de cada OS num instante (último evento de criação/mudança antes dele)."""
    last = (
        select(TicketEvent.ticket_id, TicketEvent.to_value)
        .where(TicketEvent.event_type.in_(STATUS_EVENTS), TicketEvent.created_at < moment)
        .distinct(TicketEvent.ticket_id)
        .order_by(TicketEvent.ticket_id, TicketEvent.created_at.desc())
        .subquery()
    )
    rows = await db.execute(select(last.c.to_value, func.count()).group_by(last.c.to_value))
    return {status: count for status, count in rows if status}


async def _status_changes(
    db: AsyncSession, start: datetime, end: datetime, to: TicketStatus
) -> int:
    return (
        await db.scalar(
            select(func.count(func.distinct(TicketEvent.ticket_id))).where(
                TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
                TicketEvent.to_value == to.value,
                TicketEvent.created_at >= start,
                TicketEvent.created_at < end,
            )
        )
        or 0
    )


async def _field_numbers(db: AsyncSession, start: datetime, end: datetime) -> dict[str, Any]:
    """Chegadas no período (prazo de 4h nas capitais) e tempo médio de técnico na loja."""
    arrived = and_(Ticket.arrived_at >= start, Ticket.arrived_at < end)
    clock_start = func.coalesce(Ticket.authorized_at, Ticket.created_at)
    row = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(Ticket.arrival_due_at.is_not(None)),
                func.count().filter(Ticket.arrived_at <= Ticket.arrival_due_at),
                func.avg(func.extract("epoch", Ticket.arrived_at - clock_start)),
            ).where(arrived)
        )
    ).one()
    arrivals, with_due, on_time, avg_arrival = row
    avg_onsite = await db.scalar(
        select(func.avg(Ticket.work_seconds)).where(
            Ticket.resolved_at >= start, Ticket.resolved_at < end, Ticket.work_seconds > 0
        )
    )
    return {
        "arrivals": arrivals or 0,
        "arrivals_on_time": on_time or 0,
        "arrival_on_time_pct": round(on_time * 100 / with_due, 1) if with_due else None,
        "avg_arrival_minutes": round(float(avg_arrival) / 60) if avg_arrival is not None else None,
        "avg_onsite_minutes": round(float(avg_onsite) / 60) if avg_onsite is not None else None,
    }


async def numbers(db: AsyncSession, start: datetime, end: datetime) -> DayNumbers:
    opened = await db.scalar(
        select(func.count()).where(Ticket.created_at >= start, Ticket.created_at < end)
    )
    unproductive = await db.scalar(
        select(func.count()).where(
            TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
            TicketEvent.created_at >= start,
            TicketEvent.created_at < end,
        )
    )
    in_sla = await db.scalar(
        select(func.count()).where(
            Ticket.resolved_at >= start,
            Ticket.resolved_at < end,
            Ticket.resolution_due_at.is_not(None),
            Ticket.resolved_at <= Ticket.resolution_due_at,
        )
    )
    at_end = await _status_counts_at(db, end)
    field = await _field_numbers(db, start, end)
    return DayNumbers(
        **field,
        opened=opened or 0,
        resolved=await _status_changes(db, start, end, TicketStatus.RESOLVED),
        cancelled=await _status_changes(db, start, end, TicketStatus.CANCELLED),
        unproductive=unproductive or 0,
        scheduled_end=at_end.get(TicketStatus.SCHEDULED.value, 0),
        backlog_end=sum(c for s, c in at_end.items() if s in {o.value for o in OPEN_STATUSES}),
        resolved_in_sla=in_sla or 0,
    )


async def _customers(
    db: AsyncSession, start: datetime, end: datetime, limit: int = 5
) -> list[CountRef]:
    rows = await db.execute(
        select(Customer.id, Customer.name, func.count(Ticket.id).label("n"))
        .join(Ticket, Ticket.customer_id == Customer.id)
        .where(Ticket.created_at >= start, Ticket.created_at < end)
        .group_by(Customer.id, Customer.name)
        .order_by(func.count(Ticket.id).desc(), Customer.name)
        .limit(limit)
    )
    return [CountRef(id=i, name=n, count=c) for i, n, c in rows]


async def _technicians(
    db: AsyncSession, start: datetime, end: datetime, limit: int = 10
) -> list[CountRef]:
    rows = await db.execute(
        select(User.id, User.name, func.count(func.distinct(TicketEvent.ticket_id)))
        .join(TicketEvent, TicketEvent.actor_id == User.id)
        .where(
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            TicketEvent.to_value == TicketStatus.RESOLVED.value,
            TicketEvent.created_at >= start,
            TicketEvent.created_at < end,
        )
        .group_by(User.id, User.name)
        .order_by(func.count(func.distinct(TicketEvent.ticket_id)).desc(), User.name)
        .limit(limit)
    )
    return [CountRef(id=i, name=n, count=c) for i, n, c in rows]


async def _unproductive_reasons(db: AsyncSession, start: datetime, end: datetime) -> list[CountRef]:
    rows = await db.execute(
        select(TicketEvent.to_value, func.count())
        .where(
            TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
            TicketEvent.created_at >= start,
            TicketEvent.created_at < end,
        )
        .group_by(TicketEvent.to_value)
        .order_by(func.count().desc())
    )
    return [CountRef(id=None, name=reason or "Sem motivo", count=c) for reason, c in rows]


def default_report_day() -> date:
    """O painel diário mostra o dia anterior: o dia fecha à meia-noite."""
    return local_today() - timedelta(days=1)


async def daily(db: AsyncSession, day: date) -> DailyReport:
    start, end = day_bounds(day)
    prev_start, prev_end = day_bounds(day - timedelta(days=1))
    customers = await _customers(db, start, end)
    return DailyReport(
        date=day,
        closed=day < local_today(),
        numbers=await numbers(db, start, end),
        previous=await numbers(db, prev_start, prev_end),
        top_customer=customers[0] if customers else None,
        customers=customers,
        technicians=await _technicians(db, start, end),
        unproductive_reasons=await _unproductive_reasons(db, start, end),
    )


def month_bounds(year: int, month: int) -> tuple[datetime, datetime, date, date]:
    first = date(year, month, 1)
    next_first = date(year + (month == 12), month % 12 + 1, 1)
    return day_bounds(first)[0], day_bounds(next_first)[0], first, next_first


async def _series(db: AsyncSession, first: date, next_first: date) -> list[DayPoint]:
    """Um ponto por dia do mês (até hoje, se for o mês corrente)."""
    last = min(next_first, local_today() + timedelta(days=1))
    out = []
    day = first
    while day < last:
        start, end = day_bounds(day)
        opened = await db.scalar(
            select(func.count()).where(Ticket.created_at >= start, Ticket.created_at < end)
        )
        unproductive = await db.scalar(
            select(func.count()).where(
                TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
                and_(TicketEvent.created_at >= start, TicketEvent.created_at < end),
            )
        )
        out.append(
            DayPoint(
                date=day,
                opened=opened or 0,
                resolved=await _status_changes(db, start, end, TicketStatus.RESOLVED),
                cancelled=await _status_changes(db, start, end, TicketStatus.CANCELLED),
                unproductive=unproductive or 0,
            )
        )
        day += timedelta(days=1)
    return out


async def monthly(db: AsyncSession, year: int, month: int) -> MonthlyReport:
    start, end, first, next_first = month_bounds(year, month)
    prev_year, prev_month = (year - 1, 12) if month == 1 else (year, month - 1)
    p_start, p_end, _, _ = month_bounds(prev_year, prev_month)
    customers = await _customers(db, start, end, limit=10)
    expenses = await db.scalar(
        select(func.coalesce(func.sum(TicketExpense.total), 0)).where(
            TicketExpense.created_at >= start,
            TicketExpense.created_at < end,
            TicketExpense.status != ExpenseStatus.REJECTED,
        )
    )
    quotes = await db.scalar(
        select(func.coalesce(func.sum(Quote.total), 0)).where(
            Quote.status == QuoteStatus.APPROVED,
            Quote.decided_at >= start,
            Quote.decided_at < end,
        )
    )
    return MonthlyReport(
        month=f"{year:04d}-{month:02d}",
        closed=next_first <= local_today(),
        numbers=await numbers(db, start, end),
        previous=await numbers(db, p_start, p_end),
        days=await _series(db, first, next_first),
        top_customer=customers[0] if customers else None,
        customers=customers,
        technicians=await _technicians(db, start, end),
        unproductive_reasons=await _unproductive_reasons(db, start, end),
        expenses_total=Decimal(expenses or 0),
        quotes_approved_total=Decimal(quotes or 0),
    )

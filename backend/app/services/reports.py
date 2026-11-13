"""Fechamento diário (o dia fecha à meia-noite, no fuso da operação) e relatório mensal.

Tudo sai da trilha de eventos das OS: assim "quantos ficaram agendados" é o estado de cada OS
no fim do período, e não o de agora. Com `customer_id`, tudo é recortado para um cliente (a
prestação de contas dos clientes grandes).
"""

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import (
    ExpenseStatus,
    QuoteStatus,
    TicketEventType,
    TicketStatus,
    UserRole,
)
from app.models import Customer, Quote, Ticket, TicketEvent, TicketExpense, User
from app.schemas.reports import CountRef, DailyReport, DayNumbers, DayPoint, MonthlyReport
from app.services.activities import day_bounds, local_today
from app.services.workflow import OPEN_STATUSES

STATUS_EVENTS = (TicketEventType.CREATED, TicketEventType.STATUS_CHANGED)
CustomerId = uuid.UUID | None


def _of_customer(stmt: Any, customer_id: CustomerId, *, join_from: Any = None) -> Any:
    """Recorta a consulta para um cliente (eventos, custos e orçamentos: pela OS)."""
    if customer_id is None:
        return stmt
    if join_from is not None:
        stmt = stmt.join(Ticket, Ticket.id == join_from)
    return stmt.where(Ticket.customer_id == customer_id)


def _local_day(column: Any) -> Any:
    """Dia no fuso da operação (às 23h30 de São Paulo, em UTC, já é o dia seguinte)."""
    return func.date(func.timezone(settings.TIMEZONE, column))


async def _status_counts_at(
    db: AsyncSession, moment: datetime, customer_id: CustomerId = None
) -> dict[str, int]:
    """Status de cada OS num instante (último evento de criação/mudança antes dele)."""
    last = _of_customer(
        select(TicketEvent.ticket_id, TicketEvent.to_value).where(
            TicketEvent.event_type.in_(STATUS_EVENTS), TicketEvent.created_at < moment
        ),
        customer_id,
        join_from=TicketEvent.ticket_id,
    )
    last = (
        last.distinct(TicketEvent.ticket_id)
        .order_by(TicketEvent.ticket_id, TicketEvent.created_at.desc())
        .subquery()
    )
    rows = await db.execute(select(last.c.to_value, func.count()).group_by(last.c.to_value))
    return {status: count for status, count in rows if status}


async def _status_changes(
    db: AsyncSession,
    start: datetime,
    end: datetime,
    to: TicketStatus,
    customer_id: CustomerId = None,
) -> int:
    stmt = select(func.count(func.distinct(TicketEvent.ticket_id))).where(
        TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
        TicketEvent.to_value == to.value,
        TicketEvent.created_at >= start,
        TicketEvent.created_at < end,
    )
    stmt = _of_customer(stmt, customer_id, join_from=TicketEvent.ticket_id)
    return await db.scalar(stmt) or 0


async def _field_numbers(
    db: AsyncSession, start: datetime, end: datetime, customer_id: CustomerId = None
) -> dict[str, Any]:
    """Chegadas no período (prazo de 4h nas capitais) e tempo médio de técnico na loja."""
    arrived = and_(Ticket.arrived_at >= start, Ticket.arrived_at < end)
    clock_start = func.coalesce(Ticket.authorized_at, Ticket.created_at)
    row = (
        await db.execute(
            _of_customer(
                select(
                    func.count(),
                    func.count().filter(Ticket.arrival_due_at.is_not(None)),
                    func.count().filter(Ticket.arrived_at <= Ticket.arrival_due_at),
                    func.avg(func.extract("epoch", Ticket.arrived_at - clock_start)),
                ).where(arrived),
                customer_id,
            )
        )
    ).one()
    arrivals, with_due, on_time, avg_arrival = row
    avg_onsite = await db.scalar(
        _of_customer(
            select(func.avg(Ticket.work_seconds)).where(
                Ticket.resolved_at >= start, Ticket.resolved_at < end, Ticket.work_seconds > 0
            ),
            customer_id,
        )
    )
    return {
        "arrivals": arrivals or 0,
        "arrivals_on_time": on_time or 0,
        "arrival_on_time_pct": round(on_time * 100 / with_due, 1) if with_due else None,
        "avg_arrival_minutes": round(float(avg_arrival) / 60) if avg_arrival is not None else None,
        "avg_onsite_minutes": round(float(avg_onsite) / 60) if avg_onsite is not None else None,
    }


async def numbers(
    db: AsyncSession, start: datetime, end: datetime, customer_id: CustomerId = None
) -> DayNumbers:
    opened = await db.scalar(
        _of_customer(
            select(func.count()).where(Ticket.created_at >= start, Ticket.created_at < end),
            customer_id,
        )
    )
    unproductive = await db.scalar(
        _of_customer(
            select(func.count())
            .select_from(TicketEvent)
            .where(
                TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
                TicketEvent.created_at >= start,
                TicketEvent.created_at < end,
            ),
            customer_id,
            join_from=TicketEvent.ticket_id,
        )
    )
    in_sla = await db.scalar(
        _of_customer(
            select(func.count()).where(
                Ticket.resolved_at >= start,
                Ticket.resolved_at < end,
                Ticket.resolution_due_at.is_not(None),
                Ticket.resolved_at <= Ticket.resolution_due_at,
            ),
            customer_id,
        )
    )
    at_end = await _status_counts_at(db, end, customer_id)
    field = await _field_numbers(db, start, end, customer_id)
    return DayNumbers(
        **field,
        opened=opened or 0,
        resolved=await _status_changes(db, start, end, TicketStatus.RESOLVED, customer_id),
        cancelled=await _status_changes(db, start, end, TicketStatus.CANCELLED, customer_id),
        unproductive=unproductive or 0,
        scheduled_end=at_end.get(TicketStatus.SCHEDULED.value, 0),
        backlog_end=sum(c for s, c in at_end.items() if s in {o.value for o in OPEN_STATUSES}),
        resolved_in_sla=in_sla or 0,
    )


async def _customers(
    db: AsyncSession,
    start: datetime,
    end: datetime,
    limit: int = 5,
    customer_id: CustomerId = None,
) -> list[CountRef]:
    stmt = (
        select(Customer.id, Customer.name, func.count(Ticket.id).label("n"))
        .join(Ticket, Ticket.customer_id == Customer.id)
        .where(Ticket.created_at >= start, Ticket.created_at < end)
        .group_by(Customer.id, Customer.name)
        .order_by(func.count(Ticket.id).desc(), Customer.name)
        .limit(limit)
    )
    rows = await db.execute(_of_customer(stmt, customer_id))
    return [CountRef(id=i, name=n, count=c) for i, n, c in rows]


async def _technicians(
    db: AsyncSession,
    start: datetime,
    end: datetime,
    limit: int = 10,
    customer_id: CustomerId = None,
) -> list[CountRef]:
    """Técnicos que mais resolveram: conta para o técnico da OS, mesmo quando a central é que
    marcou como resolvida (o técnico esqueceu de concluir no app)."""
    resolved = func.count(func.distinct(TicketEvent.ticket_id))
    stmt = (
        select(User.id, User.name, resolved)
        .select_from(TicketEvent)
        .join(Ticket, Ticket.id == TicketEvent.ticket_id)
        .join(User, User.id == Ticket.assignee_id)
        .where(
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            TicketEvent.to_value == TicketStatus.RESOLVED.value,
            TicketEvent.created_at >= start,
            TicketEvent.created_at < end,
            User.role == UserRole.TECHNICIAN,
        )
        .group_by(User.id, User.name)
        .order_by(resolved.desc(), User.name)
        .limit(limit)
    )
    rows = await db.execute(_of_customer(stmt, customer_id))
    return [CountRef(id=i, name=n, count=c) for i, n, c in rows]


async def _unproductive_reasons(
    db: AsyncSession, start: datetime, end: datetime, customer_id: CustomerId = None
) -> list[CountRef]:
    stmt = (
        select(TicketEvent.to_value, func.count())
        .where(
            TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
            TicketEvent.created_at >= start,
            TicketEvent.created_at < end,
        )
        .group_by(TicketEvent.to_value)
        .order_by(func.count().desc())
    )
    rows = await db.execute(_of_customer(stmt, customer_id, join_from=TicketEvent.ticket_id))
    return [CountRef(id=None, name=reason or "Sem motivo", count=c) for reason, c in rows]


def default_report_day() -> date:
    """O painel diário mostra o dia anterior: o dia fecha à meia-noite."""
    return local_today() - timedelta(days=1)


async def daily(db: AsyncSession, day: date, customer_id: CustomerId = None) -> DailyReport:
    start, end = day_bounds(day)
    prev_start, prev_end = day_bounds(day - timedelta(days=1))
    customers = await _customers(db, start, end, customer_id=customer_id)
    return DailyReport(
        date=day,
        closed=day < local_today(),
        numbers=await numbers(db, start, end, customer_id),
        previous=await numbers(db, prev_start, prev_end, customer_id),
        top_customer=customers[0] if customers else None,
        customers=customers,
        technicians=await _technicians(db, start, end, customer_id=customer_id),
        unproductive_reasons=await _unproductive_reasons(db, start, end, customer_id),
    )


def month_bounds(year: int, month: int) -> tuple[datetime, datetime, date, date]:
    first = date(year, month, 1)
    next_first = date(year + (month == 12), month % 12 + 1, 1)
    return day_bounds(first)[0], day_bounds(next_first)[0], first, next_first


async def _per_day(db: AsyncSession, stmt: Any) -> dict[date, int]:
    return {day: count for day, count in await db.execute(stmt) if day is not None}


async def _series(
    db: AsyncSession, first: date, next_first: date, customer_id: CustomerId = None
) -> list[DayPoint]:
    """Um ponto por dia do mês (até hoje, se for o mês corrente), com 0 nos dias sem movimento.
    Quatro consultas agrupadas pelo dia local (e não quatro por dia do mês)."""
    last = min(next_first, local_today() + timedelta(days=1))
    if last <= first:
        return []
    start, end = day_bounds(first)[0], day_bounds(last)[0]
    created_day = _local_day(Ticket.created_at)
    opened = await _per_day(
        db,
        _of_customer(
            select(created_day, func.count())
            .where(Ticket.created_at >= start, Ticket.created_at < end)
            .group_by(created_day),
            customer_id,
        ),
    )
    event_day = _local_day(TicketEvent.created_at)
    in_period = and_(TicketEvent.created_at >= start, TicketEvent.created_at < end)
    unproductive = await _per_day(
        db,
        _of_customer(
            select(event_day, func.count())
            .select_from(TicketEvent)
            .where(TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT, in_period)
            .group_by(event_day),
            customer_id,
            join_from=TicketEvent.ticket_id,
        ),
    )

    async def changed_to(status: TicketStatus) -> dict[date, int]:
        return await _per_day(
            db,
            _of_customer(
                select(event_day, func.count(func.distinct(TicketEvent.ticket_id)))
                .select_from(TicketEvent)
                .where(
                    TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
                    TicketEvent.to_value == status.value,
                    in_period,
                )
                .group_by(event_day),
                customer_id,
                join_from=TicketEvent.ticket_id,
            ),
        )

    resolved = await changed_to(TicketStatus.RESOLVED)
    cancelled = await changed_to(TicketStatus.CANCELLED)
    out = []
    day = first
    while day < last:
        out.append(
            DayPoint(
                date=day,
                opened=opened.get(day, 0),
                resolved=resolved.get(day, 0),
                cancelled=cancelled.get(day, 0),
                unproductive=unproductive.get(day, 0),
            )
        )
        day += timedelta(days=1)
    return out


async def monthly(
    db: AsyncSession, year: int, month: int, customer_id: CustomerId = None
) -> MonthlyReport:
    start, end, first, next_first = month_bounds(year, month)
    prev_year, prev_month = (year - 1, 12) if month == 1 else (year, month - 1)
    p_start, p_end, _, _ = month_bounds(prev_year, prev_month)
    customers = await _customers(db, start, end, limit=10, customer_id=customer_id)
    expenses = await db.scalar(
        _of_customer(
            select(func.coalesce(func.sum(TicketExpense.total), 0)).where(
                TicketExpense.created_at >= start,
                TicketExpense.created_at < end,
                TicketExpense.status != ExpenseStatus.REJECTED,
            ),
            customer_id,
            join_from=TicketExpense.ticket_id,
        )
    )
    quotes = await db.scalar(
        _of_customer(
            select(func.coalesce(func.sum(Quote.total), 0)).where(
                Quote.status == QuoteStatus.APPROVED,
                Quote.decided_at >= start,
                Quote.decided_at < end,
            ),
            customer_id,
            join_from=Quote.ticket_id,
        )
    )
    return MonthlyReport(
        month=f"{year:04d}-{month:02d}",
        closed=next_first <= local_today(),
        numbers=await numbers(db, start, end, customer_id),
        previous=await numbers(db, p_start, p_end, customer_id),
        days=await _series(db, first, next_first, customer_id),
        top_customer=customers[0] if customers else None,
        customers=customers,
        technicians=await _technicians(db, start, end, customer_id=customer_id),
        unproductive_reasons=await _unproductive_reasons(db, start, end, customer_id),
        expenses_total=Decimal(expenses or 0),
        quotes_approved_total=Decimal(quotes or 0),
    )

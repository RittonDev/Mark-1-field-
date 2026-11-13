"""Valor de cada técnico por OS e o fechamento dos pagamentos.

Os técnicos são parceiros sem vínculo: pegam a demanda e recebem por chamado. A central define o
valor ao colocar o técnico na OS (o padrão vem do tipo de serviço), paga na web ("Pagamentos") e o
técnico acompanha no app ("Meus ganhos"). Reembolsos (km, material) seguem nos custos extras.
"""

import uuid
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import ExpenseStatus, PayoutStatus, TicketEventType, TicketStatus
from app.db.base import utcnow
from app.models.catalog import ServiceType
from app.models.customer import Customer, Location
from app.models.expense import TicketExpense
from app.models.payout import TicketPayout
from app.models.ticket import Ticket, TicketEvent
from app.models.user import User
from app.schemas.common import Ref
from app.schemas.payout import (
    MyEarnings,
    MyPayout,
    PayoutIn,
    PayoutLine,
    PayoutList,
    PayoutSummary,
    PayoutTicketRef,
)
from app.schemas.ticket import format_ticket_code
from app.services.errors import WorkflowError

CONCLUDED = (TicketStatus.RESOLVED, TicketStatus.CLOSED)
PAID_LOCKED = "Este valor já foi pago: desfaça o pagamento antes de mudar"
NOT_ON_TICKET = "Coloque o técnico na OS antes de definir o valor dele"


def _money(value: Decimal | None) -> str:
    return f"R$ {value or 0:.2f}".replace(".", ",")


def _event(
    db: AsyncSession,
    ticket: Ticket,
    actor: User,
    event_type: TicketEventType,
    *,
    from_value: str | None = None,
    to_value: str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Histórico da OS (evento interno: o cliente e o técnico não veem)."""
    db.add(
        TicketEvent(
            ticket_id=ticket.id,
            actor_id=actor.id,
            event_type=event_type,
            from_value=from_value,
            to_value=to_value,
            data=data,
            created_at=utcnow(),
        )
    )


def _bounds(date_from: date | None, date_to: date | None) -> tuple[datetime | None, datetime | None]:
    """Dias no fuso da operação (a conclusão às 22h do dia 30 conta no dia 30)."""
    tz = ZoneInfo(settings.TIMEZONE)
    start = datetime.combine(date_from, time.min, tzinfo=tz) if date_from else None
    end = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=tz) if date_to else None
    return start, end


def works_on(ticket: Ticket, technician_id: uuid.UUID) -> bool:
    return ticket.assignee_id == technician_id or any(h.id == technician_id for h in ticket.helpers)


async def _find(db: AsyncSession, ticket_id: uuid.UUID, technician_id: uuid.UUID) -> TicketPayout | None:
    return await db.scalar(
        select(TicketPayout).where(
            TicketPayout.ticket_id == ticket_id, TicketPayout.technician_id == technician_id
        )
    )


async def default_fee(db: AsyncSession, ticket: Ticket) -> Decimal | None:
    if ticket.service_type_id is None:
        return None
    service_type = await db.get(ServiceType, ticket.service_type_id)
    return service_type.technician_fee if service_type else None


async def set_payout(
    db: AsyncSession, ticket: Ticket, technician_id: uuid.UUID, data: PayoutIn, actor: User
) -> TicketPayout:
    if not works_on(ticket, technician_id):
        raise WorkflowError(NOT_ON_TICKET)
    payout = await _find(db, ticket.id, technician_id)
    before = payout.amount if payout else None
    note = (data.note or "").strip() or None
    if payout is None:
        payout = TicketPayout(
            id=uuid.uuid4(),
            ticket_id=ticket.id,
            technician_id=technician_id,
            amount=data.amount,
            note=note,
            status=PayoutStatus.PENDING,
            created_by_id=actor.id,
        )
        db.add(payout)
    else:
        if payout.status == PayoutStatus.PAID:
            raise WorkflowError(PAID_LOCKED)
        payout.amount = data.amount
        payout.note = note
    technician = await db.get(User, technician_id)
    _event(
        db,
        ticket,
        actor,
        TicketEventType.PAYOUT_SET,
        from_value=None if before is None else str(before),
        to_value=str(data.amount),
        data={"technician": technician.name if technician else None, "amount": _money(data.amount)},
    )
    await db.flush()
    return payout


async def remove_payout(db: AsyncSession, ticket: Ticket, technician_id: uuid.UUID, actor: User) -> None:
    payout = await _find(db, ticket.id, technician_id)
    if payout is None:
        return
    if payout.status == PayoutStatus.PAID:
        raise WorkflowError(PAID_LOCKED)
    technician = await db.get(User, technician_id)
    await db.delete(payout)
    _event(
        db,
        ticket,
        actor,
        TicketEventType.PAYOUT_REMOVED,
        from_value=str(payout.amount),
        data={"technician": technician.name if technician else None, "amount": _money(payout.amount)},
    )
    await db.flush()


async def on_assignee_changed(
    db: AsyncSession,
    ticket: Ticket,
    previous_id: uuid.UUID | None,
    new_id: uuid.UUID | None,
    actor: User,
) -> None:
    """Troca de responsável: o valor ainda não pago acompanha o novo técnico; sem valor nenhum,
    entra o padrão do tipo de serviço. Quem saiu da OS deixa de ter valor a receber (o já pago fica).
    """
    previous = await _find(db, ticket.id, previous_id) if previous_id else None
    if previous is not None and previous.status == PayoutStatus.PAID:
        previous = None
    current = await _find(db, ticket.id, new_id) if new_id else None
    still_helper = previous_id is not None and any(h.id == previous_id for h in ticket.helpers)
    if previous is not None and not still_helper:
        if new_id is not None and current is None:
            previous.technician_id = new_id
            await db.flush()
            return
        await db.delete(previous)
        await db.flush()
    if new_id is not None and current is None:
        fee = await default_fee(db, ticket)
        if fee is not None:
            db.add(
                TicketPayout(
                    id=uuid.uuid4(),
                    ticket_id=ticket.id,
                    technician_id=new_id,
                    amount=fee,
                    status=PayoutStatus.PENDING,
                    created_by_id=actor.id,
                )
            )
            await db.flush()


async def on_helpers_removed(db: AsyncSession, ticket: Ticket, removed_ids: list[uuid.UUID]) -> None:
    """Quem deixou de ir junto perde o valor ainda não pago (o pago fica registrado)."""
    for technician_id in removed_ids:
        if technician_id == ticket.assignee_id:
            continue
        payout = await _find(db, ticket.id, technician_id)
        if payout is not None and payout.status == PayoutStatus.PENDING:
            await db.delete(payout)
    await db.flush()


def my_payout(ticket: Ticket, user: User) -> MyPayout | None:
    for payout in ticket.payouts:
        if payout.technician_id == user.id:
            return MyPayout(amount=payout.amount, status=payout.status, paid_at=payout.paid_at)
    return None


# --------------------------------------------------------------------------- fechamento


def _line(payout: TicketPayout, ticket: Ticket, customer: str | None, location: Location | None) -> PayoutLine:
    return PayoutLine(
        id=payout.id,
        technician=Ref(id=payout.technician.id, name=payout.technician.name),
        amount=payout.amount,
        status=payout.status,
        note=payout.note,
        paid_at=payout.paid_at,
        concluded=ticket.status in CONCLUDED,
        ticket=PayoutTicketRef(
            id=ticket.id,
            code=format_ticket_code(ticket.number),
            title=ticket.title,
            status=ticket.status,
            customer=customer,
            location=location.name if location else None,
            city=location.city if location else None,
            resolved_at=ticket.resolved_at,
        ),
    )


def _summary(lines: list[PayoutLine]) -> PayoutSummary:
    summary = PayoutSummary()
    for line in lines:
        if line.status == PayoutStatus.PAID:
            summary.paid += line.amount
        elif line.concluded:
            summary.to_pay += line.amount
        else:
            summary.expected += line.amount
    return summary


async def list_payouts(
    db: AsyncSession,
    *,
    technician_id: uuid.UUID | None = None,
    status: PayoutStatus | None = None,
    concluded: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 1000,
) -> PayoutList:
    """Pagamentos para a gestão. O período vale pela conclusão da OS (ou pelo lançamento, se aberta)."""
    when = func.coalesce(Ticket.resolved_at, TicketPayout.created_at)
    stmt = (
        select(TicketPayout, Ticket, Customer.name, Location)
        .join(Ticket, Ticket.id == TicketPayout.ticket_id)
        .outerjoin(Customer, Customer.id == Ticket.customer_id)
        .outerjoin(Location, Location.id == Ticket.location_id)
        .order_by(when.desc())
        .limit(limit)
    )
    if technician_id is not None:
        stmt = stmt.where(TicketPayout.technician_id == technician_id)
    if status is not None:
        stmt = stmt.where(TicketPayout.status == status)
    if concluded is True:
        stmt = stmt.where(Ticket.status.in_(CONCLUDED))
    elif concluded is False:
        stmt = stmt.where(Ticket.status.not_in(CONCLUDED))
    start, end = _bounds(date_from, date_to)
    if start is not None:
        stmt = stmt.where(when >= start)
    if end is not None:
        stmt = stmt.where(when < end)
    rows = (await db.execute(stmt)).all()
    lines = [_line(p, t, customer, location) for p, t, customer, location in rows]
    return PayoutList(items=lines, summary=_summary(lines))


async def mark_paid(db: AsyncSession, ids: list[uuid.UUID], actor: User, *, paid: bool) -> int:
    """Marca como pago (ou desfaz). Devolve quantos mudaram."""
    payouts = list(await db.scalars(select(TicketPayout).where(TicketPayout.id.in_(ids))))
    now = utcnow()
    changed = 0
    for payout in payouts:
        if paid and payout.status == PayoutStatus.PENDING:
            payout.status = PayoutStatus.PAID
            payout.paid_at = now
            payout.paid_by_id = actor.id
            changed += 1
        elif not paid and payout.status == PayoutStatus.PAID:
            payout.status = PayoutStatus.PENDING
            payout.paid_at = None
            payout.paid_by_id = None
            changed += 1
    await db.flush()
    return changed


async def my_earnings(db: AsyncSession, user: User, month: date | None = None) -> MyEarnings:
    """Meus ganhos do técnico: os chamados dele (a receber, previsto, recebido) e os reembolsos."""
    date_from = date_to = None
    if month is not None:
        date_from = month.replace(day=1)
        next_month = (date_from + timedelta(days=32)).replace(day=1)
        date_to = next_month - timedelta(days=1)
    base = await list_payouts(db, technician_id=user.id, date_from=date_from, date_to=date_to)
    # Reembolso aprovado e ainda não pago: a receber (independe do mês). Pago: no mês escolhido.
    to_receive = await db.scalar(
        select(func.coalesce(func.sum(TicketExpense.total), 0)).where(
            TicketExpense.technician_id == user.id, TicketExpense.status == ExpenseStatus.APPROVED
        )
    )
    paid_stmt = select(func.coalesce(func.sum(TicketExpense.total), 0)).where(
        TicketExpense.technician_id == user.id, TicketExpense.status == ExpenseStatus.PAID
    )
    start, end = _bounds(date_from, date_to)
    if start is not None and end is not None:
        paid_stmt = paid_stmt.where(TicketExpense.paid_at >= start, TicketExpense.paid_at < end)
    paid = await db.scalar(paid_stmt)
    return MyEarnings(
        items=base.items,
        summary=base.summary,
        reimbursement_to_receive=Decimal(to_receive or 0),
        reimbursement_paid=Decimal(paid or 0),
    )

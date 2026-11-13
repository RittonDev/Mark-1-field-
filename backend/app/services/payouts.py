"""Valor de cada técnico por OS e o fechamento dos pagamentos.

Os técnicos são parceiros sem vínculo: pegam a demanda e recebem por chamado. A central define o
valor ao colocar o técnico na OS (o padrão vem do tipo de serviço), paga na web ("Pagamentos") e o
técnico acompanha no app ("Meus ganhos"). Reembolsos (km, material) seguem nos custos extras.
"""

import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, not_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import raiseload

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
from app.services.realtime import queue_event

CONCLUDED = (TicketStatus.RESOLVED, TicketStatus.CLOSED)
# Valor pendente de OS cancelada não é "previsto": a OS não vai acontecer. Ainda dá para pagar
# (ex.: o técnico foi até a loja e a central decide pagar o deslocamento).
CANCELLED = TicketStatus.CANCELLED
PAID_LOCKED = "Este valor já foi pago: desfaça o pagamento antes de mudar"
NOT_ON_TICKET = "Coloque o técnico na OS antes de definir o valor dele"


def _money(value: Decimal | None) -> str:
    return f"R$ {value or 0:.2f}".replace(".", ",")


def _event(
    db: AsyncSession,
    ticket_id: uuid.UUID,
    actor: User | None,
    event_type: TicketEventType,
    *,
    from_value: str | None = None,
    to_value: str | None = None,
    note: str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Histórico da OS (evento interno: o cliente e o técnico não veem)."""
    db.add(
        TicketEvent(
            ticket_id=ticket_id,
            actor_id=actor.id if actor else None,
            event_type=event_type,
            from_value=from_value,
            to_value=to_value,
            note=note,
            data=data,
            created_at=utcnow(),
        )
    )


def _changed(db: AsyncSession, ticket: Ticket, actor: User | None) -> None:
    """Avisa a gestão em tempo real (quem está com a OS aberta vê o valor novo)."""
    queue_event(
        db, "updated", ticket, actor, {"fields": ["payouts"]}, internal=True, managers_only=True
    )


async def _touch(db: AsyncSession, ticket_ids: list[uuid.UUID]) -> None:
    """Marca a OS como alterada (o app do técnico baixa de novo), sem mexer na versão."""
    if ticket_ids:
        await db.execute(
            update(Ticket)
            .where(Ticket.id.in_(ticket_ids))
            .values(updated_at=utcnow())
            .execution_options(synchronize_session=False)
        )


def _bounds(
    date_from: date | None, date_to: date | None
) -> tuple[datetime | None, datetime | None]:
    """Dias no fuso da operação (a conclusão às 22h do dia 30 conta no dia 30)."""
    tz = ZoneInfo(settings.TIMEZONE)
    start = datetime.combine(date_from, time.min, tzinfo=tz) if date_from else None
    end = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=tz) if date_to else None
    return start, end


def works_on(ticket: Ticket, technician_id: uuid.UUID) -> bool:
    return ticket.assignee_id == technician_id or any(h.id == technician_id for h in ticket.helpers)


async def _find(
    db: AsyncSession, ticket_id: uuid.UUID, technician_id: uuid.UUID
) -> TicketPayout | None:
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
        ticket.id,
        actor,
        TicketEventType.PAYOUT_SET,
        from_value=None if before is None else str(before),
        to_value=str(data.amount),
        data={"technician": technician.name if technician else None, "amount": _money(data.amount)},
    )
    await _touch(db, [ticket.id])
    _changed(db, ticket, actor)
    await db.flush()
    return payout


async def remove_payout(
    db: AsyncSession, ticket: Ticket, technician_id: uuid.UUID, actor: User
) -> None:
    payout = await _find(db, ticket.id, technician_id)
    if payout is None:
        return
    if payout.status == PayoutStatus.PAID:
        raise WorkflowError(PAID_LOCKED)
    technician = await db.get(User, technician_id)
    await db.delete(payout)
    _event(
        db,
        ticket.id,
        actor,
        TicketEventType.PAYOUT_REMOVED,
        from_value=str(payout.amount),
        data={
            "technician": technician.name if technician else None,
            "amount": _money(payout.amount),
        },
    )
    await _touch(db, [ticket.id])
    _changed(db, ticket, actor)
    await db.flush()


async def _name(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    user = await db.get(User, user_id) if user_id else None
    return user.name if user else None


async def on_assignee_changed(
    db: AsyncSession,
    ticket: Ticket,
    previous_id: uuid.UUID | None,
    new_id: uuid.UUID | None,
    actor: User,
) -> None:
    """Troca de responsável: o valor ainda não pago acompanha o novo técnico; sem valor nenhum,
    entra o padrão do tipo de serviço. Quem saiu da OS deixa de ter valor a receber (o pago fica).
    Tudo fica no histórico da OS (quem fez a visita improdutiva vê para onde foi o valor).
    """
    previous = await _find(db, ticket.id, previous_id) if previous_id else None
    if previous is not None and previous.status == PayoutStatus.PAID:
        previous = None
    current = await _find(db, ticket.id, new_id) if new_id else None
    still_helper = previous_id is not None and any(h.id == previous_id for h in ticket.helpers)
    if previous is not None and not still_helper:
        before = await _name(db, previous_id)
        if new_id is not None and current is None:
            after = await _name(db, new_id)
            previous.technician_id = new_id
            _event(
                db,
                ticket.id,
                actor,
                TicketEventType.PAYOUT_SET,
                from_value=str(previous.amount),
                to_value=str(previous.amount),
                note=f"Valor transferido de {before or 'técnico removido'} para {after}",
                data={
                    "technician": after,
                    "amount": _money(previous.amount),
                    "action": "transferred",
                    "from_technician": before,
                },
            )
            await db.flush()
            return
        await db.delete(previous)
        _event(
            db,
            ticket.id,
            actor,
            TicketEventType.PAYOUT_REMOVED,
            from_value=str(previous.amount),
            note="Saiu da OS: o valor não pago foi retirado",
            data={"technician": before, "amount": _money(previous.amount)},
        )
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
            _event(
                db,
                ticket.id,
                actor,
                TicketEventType.PAYOUT_SET,
                to_value=str(fee),
                note="Valor padrão do tipo de serviço",
                data={"technician": await _name(db, new_id), "amount": _money(fee)},
            )
            await db.flush()


async def on_helpers_removed(
    db: AsyncSession,
    ticket: Ticket,
    removed_ids: list[uuid.UUID],
    actor: User | None = None,
) -> None:
    """Quem deixou de ir junto perde o valor ainda não pago (o pago fica registrado)."""
    for technician_id in removed_ids:
        if technician_id == ticket.assignee_id:
            continue
        payout = await _find(db, ticket.id, technician_id)
        if payout is not None and payout.status == PayoutStatus.PENDING:
            name = await _name(db, technician_id)
            await db.delete(payout)
            _event(
                db,
                ticket.id,
                actor,
                TicketEventType.PAYOUT_REMOVED,
                from_value=str(payout.amount),
                note="Saiu da visita: o valor não pago foi retirado",
                data={"technician": name, "amount": _money(payout.amount)},
            )
    await db.flush()


def my_payout(ticket: Ticket, user: User) -> MyPayout | None:
    for payout in ticket.payouts:
        if payout.technician_id == user.id:
            return MyPayout(amount=payout.amount, status=payout.status, paid_at=payout.paid_at)
    return None


# --------------------------------------------------------------------------- fechamento


def _line(row: Any) -> PayoutLine:
    payout: TicketPayout = row[0]
    _, ticket_id, number, title, status, resolved_at, customer, location, city = row
    return PayoutLine(
        id=payout.id,
        technician=Ref(id=payout.technician.id, name=payout.technician.name),
        amount=payout.amount,
        status=payout.status,
        note=payout.note,
        paid_at=payout.paid_at,
        concluded=status in CONCLUDED,
        cancelled=status == CANCELLED,
        ticket=PayoutTicketRef(
            id=ticket_id,
            code=format_ticket_code(number),
            title=title,
            status=status,
            customer=customer,
            location=location,
            city=city,
            resolved_at=resolved_at,
        ),
    )


async def list_payouts(
    db: AsyncSession,
    *,
    technician_id: uuid.UUID | None = None,
    status: PayoutStatus | None = None,
    concluded: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 1000,
    hide_cancelled_pending: bool = False,
) -> PayoutList:
    """Pagamentos para a gestão. O período vale pela conclusão da OS (aberta: pelo lançamento).

    `concluded`: OS resolvida ou fechada (a pagar) ou ainda em andamento (previsto); OS
    cancelada não entra em nenhuma das duas. O resumo e o total são somados no banco sobre todos
    os valores do filtro, não só sobre as linhas que couberam no limite.
    """
    when = func.coalesce(Ticket.resolved_at, TicketPayout.created_at)
    conds: list[Any] = []
    if technician_id is not None:
        conds.append(TicketPayout.technician_id == technician_id)
    if status is not None:
        conds.append(TicketPayout.status == status)
    if concluded is True:
        conds.append(Ticket.status.in_(CONCLUDED))
    elif concluded is False:
        conds.append(Ticket.status.not_in((*CONCLUDED, CANCELLED)))
    if hide_cancelled_pending:
        conds.append(
            not_(and_(TicketPayout.status == PayoutStatus.PENDING, Ticket.status == CANCELLED))
        )
    start, end = _bounds(date_from, date_to)
    if start is not None:
        conds.append(when >= start)
    if end is not None:
        conds.append(when < end)
    # Só as colunas da OS que a linha mostra (a OS inteira traria as ~19 relações dela).
    stmt = (
        select(
            TicketPayout,
            Ticket.id,
            Ticket.number,
            Ticket.title,
            Ticket.status,
            Ticket.resolved_at,
            Customer.name,
            Location.name,
            Location.city,
        )
        .join(Ticket, Ticket.id == TicketPayout.ticket_id)
        .outerjoin(Customer, Customer.id == Ticket.customer_id)
        .outerjoin(Location, Location.id == Ticket.location_id)
        .where(*conds)
        .order_by(when.desc(), TicketPayout.id)
        .limit(limit)
    )
    lines = [_line(row) for row in (await db.execute(stmt)).all()]
    pending = TicketPayout.status == PayoutStatus.PENDING
    total_count, paid, to_pay, expected, cancelled = (
        await db.execute(
            select(
                func.count(),
                func.coalesce(
                    func.sum(TicketPayout.amount).filter(
                        TicketPayout.status == PayoutStatus.PAID
                    ),
                    0,
                ),
                func.coalesce(
                    func.sum(TicketPayout.amount).filter(pending, Ticket.status.in_(CONCLUDED)), 0
                ),
                func.coalesce(
                    func.sum(TicketPayout.amount).filter(
                        pending, Ticket.status.not_in((*CONCLUDED, CANCELLED))
                    ),
                    0,
                ),
                func.coalesce(
                    func.sum(TicketPayout.amount).filter(pending, Ticket.status == CANCELLED), 0
                ),
            )
            .select_from(TicketPayout)
            .join(Ticket, Ticket.id == TicketPayout.ticket_id)
            .where(*conds)
        )
    ).one()
    summary = PayoutSummary(
        to_pay=Decimal(to_pay),
        expected=Decimal(expected),
        paid=Decimal(paid),
        cancelled=Decimal(cancelled),
    )
    return PayoutList(items=lines, summary=summary, total_count=total_count)


async def mark_paid(db: AsyncSession, ids: list[uuid.UUID], actor: User, *, paid: bool) -> int:
    """Marca como pago (ou desfaz). Devolve quantos mudaram. Cada mudança fica no histórico da
    OS (quem pagou, quando e quanto) e a gestão vê na hora."""
    payouts = list(await db.scalars(select(TicketPayout).where(TicketPayout.id.in_(ids))))
    now = utcnow()
    changed: list[TicketPayout] = []
    for payout in payouts:
        before = payout.status
        if paid and payout.status == PayoutStatus.PENDING:
            payout.status = PayoutStatus.PAID
            payout.paid_at = now
            payout.paid_by_id = actor.id
        elif not paid and payout.status == PayoutStatus.PAID:
            payout.status = PayoutStatus.PENDING
            payout.paid_at = None
            payout.paid_by_id = None
        else:
            continue
        changed.append(payout)
        _event(
            db,
            payout.ticket_id,
            actor,
            TicketEventType.PAYOUT_SET,
            from_value=before.value,
            to_value=payout.status.value,
            note="Pagamento registrado" if paid else "Pagamento desfeito",
            data={
                "technician": payout.technician.name if payout.technician else None,
                "amount": _money(payout.amount),
                "action": "paid" if paid else "unpaid",
            },
        )
    ticket_ids = list({p.ticket_id for p in changed})
    await _touch(db, ticket_ids)
    if ticket_ids:
        tickets = await db.scalars(
            select(Ticket).where(Ticket.id.in_(ticket_ids)).options(raiseload("*"))
        )
        for ticket in tickets:
            _changed(db, ticket, actor)
    await db.flush()
    return len(changed)


async def my_earnings(db: AsyncSession, user: User, month: date | None = None) -> MyEarnings:
    """Meus ganhos do técnico: os chamados dele (a receber, previsto, recebido) e os reembolsos.
    Valor pendente de OS cancelada não aparece (ele não vai receber, salvo se a central pagar)."""
    date_from = date_to = None
    if month is not None:
        date_from = month.replace(day=1)
        next_month = (date_from + timedelta(days=32)).replace(day=1)
        date_to = next_month - timedelta(days=1)
    base = await list_payouts(
        db,
        technician_id=user.id,
        date_from=date_from,
        date_to=date_to,
        hide_cancelled_pending=True,
    )
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

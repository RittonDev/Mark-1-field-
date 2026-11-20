"""Valor de cada técnico por OS e o fechamento dos pagamentos.

Os técnicos são parceiros sem vínculo: pegam a demanda e recebem por chamado. A central define o
valor ao colocar o técnico na OS (o padrão vem do tipo de serviço), paga na web ("Pagamentos") e o
técnico acompanha no app (aba "Faturamento": os meses em my_earnings_months, o mês em
my_earnings). Reembolsos (km, material) seguem nos custos extras. Com todos os técnicos da OS
pagos, saem as etiquetas de pagamento pendente (services/tag_rules).
"""

import uuid
from collections.abc import Sequence
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, not_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import raiseload

from app.core import pix
from app.core.config import settings
from app.core.enums import (
    ExpenseStatus,
    InvoiceStatus,
    PayoutStatus,
    TicketEventType,
    TicketStatus,
    UserRole,
)
from app.db.base import utcnow
from app.models.catalog import ServiceType
from app.models.customer import Customer, Location
from app.models.expense import TicketExpense
from app.models.invoice import TechnicianInvoice
from app.models.payout import TicketPayout
from app.models.ticket import Ticket, TicketEvent
from app.models.user import User
from app.schemas.common import Ref
from app.schemas.my_profile import PixInfo
from app.schemas.payout import (
    EarningsBucket,
    EarningsMonth,
    EarningsMonths,
    EarningsMonthState,
    EarningsRejection,
    EarningsTotals,
    MyEarnings,
    MyPayout,
    PayoutIn,
    PayoutInvoiceRef,
    PayoutLine,
    PayoutList,
    PayoutSummary,
    PayoutTicketRef,
)
from app.schemas.ticket import format_ticket_code
from app.services import tag_rules
from app.services.errors import WorkflowError
from app.services.realtime import queue_event

CONCLUDED = (TicketStatus.RESOLVED, TicketStatus.CLOSED)
# Valor pendente de OS cancelada não é "previsto": a OS não vai acontecer. Ainda dá para pagar
# (ex.: o técnico foi até a loja e a central decide pagar o deslocamento).
CANCELLED = TicketStatus.CANCELLED
PAID_LOCKED = "Este valor já foi pago: desfaça o pagamento antes de mudar"
NOT_ON_TICKET = "Coloque o técnico na OS antes de definir o valor dele"


def money_text(value: Decimal | None) -> str:
    """ "R$ 90,00": o valor como o histórico da OS mostra (pagamentos e ofertas)."""
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
    db: AsyncSession, ticket_id: uuid.UUID, technician_id: uuid.UUID, *, lock: bool = False
) -> TicketPayout | None:
    """O valor do técnico na OS. Com `lock`, travado (FOR UPDATE) e lido de novo do banco: a OS
    carregada já traz os valores (Ticket.payouts é selectin), e o objeto da sessão pode estar
    desatualizado."""
    stmt = select(TicketPayout).where(
        TicketPayout.ticket_id == ticket_id, TicketPayout.technician_id == technician_id
    )
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return await db.scalar(stmt)


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
        data={
            "technician": technician.name if technician else None,
            "amount": money_text(data.amount),
        },
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
            "amount": money_text(payout.amount),
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

    Só o técnico parceiro recebe por chamado: o analista ou supervisor que assume a OS (equipe
    interna) não ganha o valor padrão nem herda o do técnico que saiu, que é retirado como em
    "saiu da OS". O "Definir valor" da gestão continua valendo para qualquer um na OS.
    """
    newcomer = await db.get(User, new_id) if new_id else None
    paid_per_ticket = newcomer is not None and newcomer.role == UserRole.TECHNICIAN
    previous: TicketPayout | None = None
    if previous_id is not None:
        # A OS antes do valor (a ordem de close_pending_offers e do "Definir valor"): sem impasse
        # com quem mexe no valor agora.
        await db.execute(select(Ticket.id).where(Ticket.id == ticket.id).with_for_update())
        # O valor de quem sai, travado e relido: o envio de uma nota dele pode ter ligado o valor
        # depois de a OS ser carregada (ou estar ligando agora). Sem isso, "invoice_id = None" não
        # mudaria nada para o ORM e o valor passaria ao novo técnico ligado à nota do anterior.
        previous = await _find(db, ticket.id, previous_id, lock=True)
    if previous is not None and previous.status == PayoutStatus.PAID:
        previous = None
    current = await _find(db, ticket.id, new_id) if new_id and paid_per_ticket else None
    still_helper = previous_id is not None and any(h.id == previous_id for h in ticket.helpers)
    if previous is not None and not still_helper:
        before = await _name(db, previous_id)
        if new_id is not None and paid_per_ticket and current is None:
            after = await _name(db, new_id)
            previous.technician_id = new_id
            # A nota fiscal era de quem saiu: o valor chega ao novo técnico sem nota.
            previous.invoice_id = None
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
                    "amount": money_text(previous.amount),
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
            data={"technician": before, "amount": money_text(previous.amount)},
        )
        await db.flush()
    if new_id is not None and paid_per_ticket and current is None:
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
                data={"technician": await _name(db, new_id), "amount": money_text(fee)},
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
                data={"technician": name, "amount": money_text(payout.amount)},
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
    (
        _,
        ticket_id,
        number,
        title,
        status,
        resolved_at,
        customer,
        location,
        city,
        invoice_id,
        invoice_number,
        invoice_status,
    ) = row
    invoice = None
    if invoice_id is not None:
        invoice = PayoutInvoiceRef(id=invoice_id, number=invoice_number, status=invoice_status)
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
        invoice=invoice,
    )


def _visibility(viewer: User | None) -> Any:
    """A visibilidade das OS de quem pede (fila). Import aqui: services.tickets usa este módulo."""
    if viewer is None:
        return None
    from app.services.tickets import visibility_clause

    return visibility_clause(viewer)


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
    viewer: User | None = None,
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
    vis = _visibility(viewer)
    if vis is not None:
        # Só os das OS da fila que quem pede vê.
        conds.append(vis)
    start, end = _bounds(date_from, date_to)
    if start is not None:
        conds.append(when >= start)
    if end is not None:
        conds.append(when < end)
    # Só as colunas da OS que a linha mostra (a OS inteira traria as ~19 relações dela). A nota
    # fiscal só vale se for do técnico do valor (a transferência já solta a ligação).
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
            TechnicianInvoice.id,
            TechnicianInvoice.number,
            TechnicianInvoice.status,
        )
        .join(Ticket, Ticket.id == TicketPayout.ticket_id)
        .outerjoin(Customer, Customer.id == Ticket.customer_id)
        .outerjoin(Location, Location.id == Ticket.location_id)
        .outerjoin(
            TechnicianInvoice,
            and_(
                TechnicianInvoice.id == TicketPayout.invoice_id,
                TechnicianInvoice.technician_id == TicketPayout.technician_id,
            ),
        )
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
                    func.sum(TicketPayout.amount).filter(TicketPayout.status == PayoutStatus.PAID),
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


async def pix_map(
    db: AsyncSession, technician_ids: set[uuid.UUID] | list[uuid.UUID]
) -> dict[uuid.UUID, PixInfo]:
    """A chave PIX de cada técnico que tem chave (Pagamentos: para onde pagar). Ele cadastra no
    app; a central só vê e remove."""
    ids = {i for i in technician_ids if i is not None}
    if not ids:
        return {}
    rows = await db.execute(
        select(
            User.id, User.pix_key_type, User.pix_key, User.pix_holder_name, User.pix_updated_at
        ).where(User.id.in_(ids), User.pix_key.is_not(None), User.pix_key_type.is_not(None))
    )
    return {
        user_id: PixInfo(key_type=key_type, key=key, holder_name=holder, updated_at=updated_at)
        for user_id, key_type, key, holder, updated_at in rows
    }


async def mark_paid(db: AsyncSession, ids: list[uuid.UUID], actor: User, *, paid: bool) -> int:
    """Marca como pago (ou desfaz). Devolve quantos mudaram. Cada mudança fica no histórico da
    OS (quem pagou, quando e quanto) e a gestão vê na hora. Só os das OS que quem marca vê (os
    de outra fila ficam como estão)."""
    stmt = select(TicketPayout).where(TicketPayout.id.in_(ids))
    vis = _visibility(actor)
    if vis is not None:
        stmt = stmt.join(Ticket, Ticket.id == TicketPayout.ticket_id).where(vis)
    payouts = list(await db.scalars(stmt))
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
        technician = payout.technician
        data: dict[str, Any] = {
            "technician": technician.name if technician else None,
            "amount": money_text(payout.amount),
            "action": "paid" if paid else "unpaid",
        }
        if paid and technician is not None and technician.pix_key_type and technician.pix_key:
            # A chave daquele momento, mascarada (o histórico da OS não guarda a chave inteira).
            data["pix"] = pix.describe(technician.pix_key_type, technician.pix_key)
        _event(
            db,
            payout.ticket_id,
            actor,
            TicketEventType.PAYOUT_SET,
            from_value=before.value,
            to_value=payout.status.value,
            note="Pagamento registrado" if paid else "Pagamento desfeito",
            data=data,
        )
    ticket_ids = list({p.ticket_id for p in changed})
    await _touch(db, ticket_ids)
    if ticket_ids:
        tickets = list(
            await db.scalars(
                select(Ticket).where(Ticket.id.in_(ticket_ids)).options(raiseload("*"))
            )
        )
        for ticket in tickets:
            _changed(db, ticket, actor)
        if paid:
            await _drop_paid_tags(db, tickets, actor)
    await db.flush()
    return len(changed)


async def _drop_paid_tags(db: AsyncSession, tickets: list[Ticket], actor: User) -> None:
    """OS com todos os técnicos pagos: saem as etiquetas de pagamento pendente (ex.: "Pendente
    Envio PGTO"). Valor pendente de OS cancelada conta como cancelado (não vai ser pago, como na
    lista de pagamentos): pago o deslocamento de um técnico, a etiqueta sai mesmo com o valor do
    outro ainda pendente. Desfazer o pagamento não traz a etiqueta de volta."""
    from app.services.tickets import change_tags  # tickets usa este módulo: import tardio

    await db.flush()  # a conta abaixo precisa ver os pagamentos de agora
    pending = set(
        await db.scalars(
            select(TicketPayout.ticket_id).where(
                TicketPayout.ticket_id.in_([t.id for t in tickets]),
                TicketPayout.status == PayoutStatus.PENDING,
            )
        )
    )
    rules = await tag_rules.get_rules(db)
    await change_tags(
        db,
        [t for t in tickets if t.id not in pending or t.status == CANCELLED],
        actor,
        reason="Todos os técnicos pagos",
        remove=rules.remove_on_payout_paid,
    )


async def my_earnings(db: AsyncSession, user: User, month: date | None = None) -> MyEarnings:
    """Os ganhos do técnico (o mês do Faturamento do app): os chamados dele (a receber, previsto,
    recebido) e os reembolsos. Valor pendente de OS cancelada não aparece (ele não vai receber,
    salvo se a central pagar)."""
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
        total_count=base.total_count,
        reimbursement_to_receive=Decimal(to_receive or 0),
        reimbursement_paid=Decimal(paid or 0),
    )


# --------------------------------------------------------------------------- faturamento do app

# GET /me/earnings/months: quantos meses (até o atual) a aba Faturamento recebe.
MONTHS_DEFAULT, MONTHS_MAX = 12, 24


def shift_month(month: date, delta: int) -> date:
    """O dia 1 do mês `delta` meses depois de `month` (antes, com `delta` negativo)."""
    index = month.year * 12 + month.month - 1 + delta
    return date(index // 12, index % 12 + 1, 1)


def month_state(
    *,
    to_pay: int,
    expected: int,
    paid: int,
    due_without_invoice: int,
    due_in_review: int,
    paid_without_invoice: int,
    rejection_open: bool,
) -> EarningsMonthState:
    """Situação do mês pelas contagens de valores (R$ 0,00 também conta); a ordem é a prioridade.
    A recusa em aberto só marca o mês enquanto alguma OS dele está sem nota (ou ele não tem OS). A
    nota nunca trava o pagamento: "no_invoice" é só informativo."""
    count = to_pay + expected + paid
    if rejection_open and (count == 0 or due_without_invoice + paid_without_invoice > 0):
        return "rejected"
    if count == 0:
        return "empty"
    if to_pay == 0 and paid == 0:
        return "in_progress"
    if paid > 0 and (to_pay > 0 or expected > 0):
        return "partial"
    if to_pay > 0:
        if due_without_invoice > 0:
            return "no_invoice"
        return "in_review" if due_in_review > 0 else "to_pay"
    return "paid_no_invoice" if paid_without_invoice > 0 else "paid"


def _open_rejections(invoices: Sequence[Any]) -> dict[str, EarningsRejection]:
    """A recusa que ainda vale em cada competência ("AAAA-MM"): a nota recusada mais recente (pela
    hora da recusa; sem ela, pelo envio), se nenhuma nota não recusada da mesma competência foi
    enviada depois da recusa. A recusada que o técnico apagou não existe mais."""
    by_month: dict[str, list[Any]] = {}
    for invoice in invoices:
        by_month.setdefault(f"{invoice.competence:%Y-%m}", []).append(invoice)
    found: dict[str, EarningsRejection] = {}
    for key, group in by_month.items():
        rejected = [i for i in group if i.status == InvoiceStatus.REJECTED]
        if not rejected:
            continue
        latest = max(rejected, key=lambda i: (i.reviewed_at or i.created_at, i.created_at))
        at = latest.reviewed_at or latest.created_at
        if any(i.status != InvoiceStatus.REJECTED and i.created_at > at for i in group):
            continue
        found[key] = EarningsRejection(
            invoice_id=latest.id,
            number=latest.number,
            reason=latest.reject_reason,
            rejected_at=latest.reviewed_at,
        )
    return found


async def my_earnings_months(
    db: AsyncSession, user: User, months: int = MONTHS_DEFAULT, now: datetime | None = None
) -> EarningsMonths:
    """Faturamento do app: os `months` meses até o atual (fuso da operação), o mais novo primeiro
    (também os sem valor), com a situação de cada um, e os totais da vida toda.

    As regras de my_earnings: o mês do valor é o da conclusão da OS (aberta: o do lançamento); o
    pendente de OS cancelada não conta (o pago, sim); só vale a nota do próprio técnico. Três
    consultas, todas pelo técnico: os valores agrupados por mês, as notas da janela (a recusa em
    aberto de cada competência) e os reembolsos. Só leitura. `now` é para os testes."""
    until = (now or utcnow()).astimezone(ZoneInfo(settings.TIMEZONE)).date().replace(day=1)
    since = shift_month(until, 1 - months)
    until_key, since_key = f"{until:%Y-%m}", f"{since:%Y-%m}"

    pending = TicketPayout.status == PayoutStatus.PENDING
    is_paid = TicketPayout.status == PayoutStatus.PAID
    due = and_(pending, Ticket.status.in_(CONCLUDED))
    without_invoice = TechnicianInvoice.id.is_(None)
    # Os baldes de EarningsMonth (contagem e soma de cada um), nesta ordem nas colunas.
    buckets = {
        "to_pay": due,
        "expected": and_(pending, Ticket.status.not_in((*CONCLUDED, CANCELLED))),
        "paid": is_paid,
        "due_without_invoice": and_(due, without_invoice),
        "due_in_review": and_(due, TechnicianInvoice.status == InvoiceStatus.PENDING),
        "due_checked": and_(due, TechnicianInvoice.status == InvoiceStatus.CHECKED),
        "paid_without_invoice": and_(is_paid, without_invoice),
    }
    sums = [
        column
        for condition in buckets.values()
        for column in (
            func.count().filter(condition),
            func.coalesce(func.sum(TicketPayout.amount).filter(condition), 0),
        )
    ]
    when = func.coalesce(Ticket.resolved_at, TicketPayout.created_at)
    # O mesmo objeto no SELECT e no GROUP BY (os parâmetros saem iguais). Horário corrigido para o
    # futuro conta no mês atual.
    month_key = func.least(
        func.to_char(func.timezone(settings.TIMEZONE, when), "YYYY-MM"), until_key
    )
    rows = (
        await db.execute(
            select(month_key, func.max(TicketPayout.paid_at).filter(is_paid), *sums)
            .select_from(TicketPayout)
            .join(Ticket, Ticket.id == TicketPayout.ticket_id)
            .outerjoin(
                TechnicianInvoice,
                and_(
                    TechnicianInvoice.id == TicketPayout.invoice_id,
                    TechnicianInvoice.technician_id == TicketPayout.technician_id,
                    # A recusa solta as OS: ligada a uma recusada, a OS está sem nota.
                    TechnicianInvoice.status != InvoiceStatus.REJECTED,
                ),
            )
            .where(
                TicketPayout.technician_id == user.id,
                not_(and_(pending, Ticket.status == CANCELLED)),
            )
            .group_by(month_key)
        )
    ).all()
    invoices = (
        await db.execute(
            select(
                TechnicianInvoice.id,
                TechnicianInvoice.number,
                TechnicianInvoice.status,
                TechnicianInvoice.competence,
                TechnicianInvoice.reject_reason,
                TechnicianInvoice.reviewed_at,
                TechnicianInvoice.created_at,
            ).where(
                TechnicianInvoice.technician_id == user.id,
                TechnicianInvoice.competence >= since,
                TechnicianInvoice.competence <= until,
            )
        )
    ).all()
    # Reembolsos (custos extras): aprovados e ainda não pagos; pagos (todos os meses).
    refund = func.sum(TicketExpense.total)
    to_receive, reimbursed = (
        await db.execute(
            select(
                func.coalesce(refund.filter(TicketExpense.status == ExpenseStatus.APPROVED), 0),
                func.coalesce(refund.filter(TicketExpense.status == ExpenseStatus.PAID), 0),
            ).where(TicketExpense.technician_id == user.id)
        )
    ).one()

    # "AAAA-MM" → (último pagamento, baldes), só os meses com valor (a vida toda).
    found: dict[str, tuple[datetime | None, dict[str, EarningsBucket]]] = {}
    for key, last_paid_at, *numbers in rows:
        found[key] = (
            last_paid_at,
            {
                name: EarningsBucket(count=numbers[2 * i], amount=Decimal(numbers[2 * i + 1]))
                for i, name in enumerate(buckets)
            },
        )

    def lifetime(name: str, *, older: bool = False) -> Decimal:
        """A soma do balde em todos os meses (`older`: só nos de antes da janela)."""
        return sum(
            (b[name].amount for key, (_, b) in found.items() if not older or key < since_key),
            Decimal("0"),
        )

    rejections = _open_rejections(invoices)
    blank = {name: EarningsBucket() for name in buckets}
    window: list[EarningsMonth] = []
    for back in range(months):
        key = f"{shift_month(until, -back):%Y-%m}"
        last_paid_at, values = found.get(key, (None, blank))
        n = {name: bucket.count for name, bucket in values.items()}
        rejection = rejections.get(key)
        window.append(
            EarningsMonth(
                month=key,
                state=month_state(
                    to_pay=n["to_pay"],
                    expected=n["expected"],
                    paid=n["paid"],
                    due_without_invoice=n["due_without_invoice"],
                    due_in_review=n["due_in_review"],
                    paid_without_invoice=n["paid_without_invoice"],
                    rejection_open=rejection is not None,
                ),
                count=n["to_pay"] + n["expected"] + n["paid"],
                total=values["to_pay"].amount + values["expected"].amount + values["paid"].amount,
                **values,
                last_paid_at=last_paid_at,
                rejection=rejection,
            )
        )
    return EarningsMonths(
        since=since_key,
        until=until_key,
        totals=EarningsTotals(
            paid=lifetime("paid"),
            to_pay=lifetime("to_pay"),
            expected=lifetime("expected"),
            to_pay_older=lifetime("to_pay", older=True),
            last_paid_at=max((p for p, _ in found.values() if p is not None), default=None),
            reimbursement_to_receive=Decimal(to_receive or 0),
            reimbursement_paid=Decimal(reimbursed or 0),
        ),
        months=window,
    )

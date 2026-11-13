"""Custos extras da OS e o relatório de reembolso dos técnicos.

Só a gestão lança, altera e remove. O técnico vê os custos da OS dele (somente leitura).

Situação: pendente, aprovado e recusado mudam livremente; "reembolsado" só vem de aprovado
(o dinheiro saiu) e só volta para aprovado (estorno). Reembolsado não muda de valor, técnico ou
comprovante nem é excluído: primeiro volta para aprovado (fica no histórico da OS).
"""

import uuid
from collections import defaultdict
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import raiseload

from app.core.enums import ExpenseKind, ExpenseStatus, TicketEventType
from app.db.base import utcnow
from app.models import Customer, SystemSetting, Ticket, TicketAttachment, TicketExpense, User
from app.models.user import STAFF_ROLES
from app.schemas.expense import (
    EXPENSE_KIND_LABEL,
    ExpenseIn,
    ExpenseOut,
    ExpenseReport,
    ExpenseReportRow,
    ExpenseTicketRef,
    ExpenseUpdate,
    TechnicianTotal,
)
from app.schemas.ticket import format_ticket_code
from app.services.errors import NotFound, PermissionDenied, WorkflowError
from app.services.realtime import queue_event
from app.services.tickets import _touch, record_event

KM_RATE_KEY = "expenses.km_rate"
DEFAULT_KM_RATE = Decimal("1.20")
CENT = Decimal("0.01")

E = ExpenseStatus
# Para onde cada situação pode ir (reembolsado só a partir de aprovado; volta só para aprovado).
TRANSITIONS: dict[ExpenseStatus, frozenset[ExpenseStatus]] = {
    E.PENDING: frozenset({E.APPROVED, E.REJECTED}),
    E.APPROVED: frozenset({E.PENDING, E.REJECTED, E.PAID}),
    E.REJECTED: frozenset({E.PENDING, E.APPROVED}),
    E.PAID: frozenset({E.APPROVED}),
}
# O que não muda enquanto o custo está reembolsado.
LOCKED_WHEN_PAID = (
    "kind",
    "description",
    "quantity",
    "unit_value",
    "technician_id",
    "receipt_attachment_id",
)
PAID_LOCKED = "Custo já reembolsado: volte para Aprovado antes de alterar"
PAID_NOT_REMOVABLE = "Custo já reembolsado: volte para Aprovado antes de excluir"
ONLY_APPROVED_PAID = "Só custo aprovado pode ser marcado como reembolsado"
PAID_BACK = "Custo reembolsado só volta para Aprovado (estorno)"


async def km_rate(db: AsyncSession) -> Decimal:
    setting = await db.get(SystemSetting, KM_RATE_KEY)
    return Decimal(str(setting.value)) if setting else DEFAULT_KM_RATE


async def set_km_rate(db: AsyncSession, value: Decimal, actor: User) -> Decimal:
    setting = await db.get(SystemSetting, KM_RATE_KEY)
    if setting is None:
        setting = SystemSetting(key=KM_RATE_KEY)
        db.add(setting)
    setting.value = str(value.quantize(CENT))
    setting.updated_by_id = actor.id
    await db.flush()
    return value.quantize(CENT)


def _require_manager(actor: User) -> None:
    if not actor.can_manage_tickets:
        raise PermissionDenied("Custos extras só são lançados e alterados por analistas e gestores")


def _total(quantity: Decimal, unit_value: Decimal) -> Decimal:
    return (quantity * unit_value).quantize(CENT, rounding=ROUND_HALF_UP)


def _summary(expense: TicketExpense) -> dict[str, Any]:
    return {
        "expense_id": str(expense.id),
        "kind": expense.kind.value,
        "description": expense.description,
        "total": str(expense.total),
        "status": expense.status.value,
    }


async def _check_refs(
    db: AsyncSession, ticket: Ticket, technician_id: uuid.UUID | None, receipt_id: uuid.UUID | None
) -> None:
    if technician_id is not None:
        technician = await db.get(User, technician_id)
        # Reembolso é para alguém da equipe (nunca para um usuário do cliente).
        if technician is None or technician.role not in STAFF_ROLES:
            raise WorkflowError("Escolha um técnico ou alguém da equipe para o reembolso")
    if receipt_id is not None:
        receipt = await db.get(TicketAttachment, receipt_id)
        if receipt is None or receipt.ticket_id != ticket.id:
            raise WorkflowError("O comprovante precisa ser um anexo desta OS")


def _differs(expense: TicketExpense, key: str, value: Any) -> bool:
    current = getattr(expense, key)
    if value is None:
        return current is not None and key in ("technician_id", "receipt_attachment_id")
    if key == "description":
        return value.strip() != current
    if isinstance(current, Decimal):
        return Decimal(str(value)) != current
    return value != current


def _check_transition(current: ExpenseStatus, wanted: ExpenseStatus) -> None:
    if wanted == current or wanted in TRANSITIONS[current]:
        return
    raise WorkflowError(PAID_BACK if current == E.PAID else ONLY_APPROVED_PAID)


def _changed(db: AsyncSession, ticket: Ticket, actor: User) -> None:
    # Custo é interno: o solicitante não recebe o evento (nem vê no histórico).
    queue_event(db, "updated", ticket, actor, {"fields": ["expenses"]}, internal=True)


async def create(db: AsyncSession, ticket: Ticket, data: ExpenseIn, actor: User) -> TicketExpense:
    _require_manager(actor)
    unit_value = data.unit_value
    if unit_value is None:
        if data.kind != ExpenseKind.KM:
            raise WorkflowError("Informe o valor unitário")
        unit_value = await km_rate(db)
    technician_id = data.technician_id or ticket.assignee_id
    await _check_refs(db, ticket, technician_id, data.receipt_attachment_id)
    expense = TicketExpense(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        kind=data.kind,
        description=data.description.strip(),
        quantity=data.quantity,
        unit_value=unit_value,
        total=_total(data.quantity, unit_value),
        technician_id=technician_id,
        status=data.status,
        paid_at=utcnow() if data.status == ExpenseStatus.PAID else None,
        receipt_attachment_id=data.receipt_attachment_id,
        notes=(data.notes or "").strip() or None,
        created_by_id=actor.id,
    )
    db.add(expense)
    record_event(db, ticket, actor, TicketEventType.EXPENSE_ADDED, data=_summary(expense))
    await _touch(db, ticket, utcnow())
    _changed(db, ticket, actor)
    await db.flush()
    await db.refresh(expense, ["technician", "created_by"])
    return expense


async def get(db: AsyncSession, expense_id: uuid.UUID) -> TicketExpense:
    expense = await db.get(TicketExpense, expense_id)
    if expense is None:
        raise NotFound("Custo não encontrado")
    return expense


async def update(
    db: AsyncSession, ticket: Ticket, expense: TicketExpense, data: ExpenseUpdate, actor: User
) -> TicketExpense:
    _require_manager(actor)
    fields = data.model_dump(exclude_unset=True)
    # null nos campos obrigatórios (o formulário manda tudo): fica como está.
    for key in ("kind", "description", "quantity", "unit_value", "status"):
        if key in fields and fields[key] is None:
            fields.pop(key)
    previous = expense.status
    wanted = fields.get("status", previous)
    _check_transition(previous, wanted)
    if (
        previous == E.PAID
        and wanted == E.PAID
        and any(_differs(expense, key, fields[key]) for key in LOCKED_WHEN_PAID if key in fields)
    ):
        raise WorkflowError(PAID_LOCKED)
    technician_id = fields.get("technician_id")
    await _check_refs(
        db,
        ticket,
        technician_id if technician_id != expense.technician_id else None,
        fields.get("receipt_attachment_id"),
    )
    for key, value in fields.items():
        if key == "description":
            value = value.strip()
        if key == "notes":
            value = (value or "").strip() or None
        setattr(expense, key, value)
    if wanted != previous:
        # Reembolsado agora: a data do reembolso; estorno (volta para aprovado): sem data.
        expense.paid_at = utcnow() if wanted == E.PAID else None
    expense.total = _total(expense.quantity, expense.unit_value)
    record_event(db, ticket, actor, TicketEventType.EXPENSE_UPDATED, data=_summary(expense))
    await _touch(db, ticket, utcnow())
    _changed(db, ticket, actor)
    await db.flush()
    await db.refresh(expense, ["technician", "created_by"])
    return expense


async def remove(db: AsyncSession, ticket: Ticket, expense: TicketExpense, actor: User) -> None:
    _require_manager(actor)
    if expense.status == E.PAID:
        raise WorkflowError(PAID_NOT_REMOVABLE)
    record_event(db, ticket, actor, TicketEventType.EXPENSE_REMOVED, data=_summary(expense))
    await db.delete(expense)
    await _touch(db, ticket, utcnow())
    _changed(db, ticket, actor)
    await db.flush()


async def mark_paid(db: AsyncSession, ids: list[uuid.UUID], actor: User) -> int:
    """Reembolsa só os custos aprovados; os demais ids (lista desatualizada) ficam como estão.

    Cada reembolso fica no histórico da OS, a OS volta a descer para o app do técnico (que passa
    a ver "Reembolsado") e a gestão vê na hora. Devolve quantos foram marcados.
    """
    _require_manager(actor)
    expenses = list(
        await db.scalars(
            select(TicketExpense).where(
                TicketExpense.id.in_(ids), TicketExpense.status == ExpenseStatus.APPROVED
            )
        )
    )
    if not expenses:
        return 0
    now = utcnow()
    ticket_ids = list({e.ticket_id for e in expenses})
    tickets = {
        t.id: t
        for t in await db.scalars(
            select(Ticket).where(Ticket.id.in_(ticket_ids)).options(raiseload("*"))
        )
    }
    for expense in expenses:
        expense.status = ExpenseStatus.PAID
        expense.paid_at = now
        record_event(
            db,
            tickets[expense.ticket_id],
            actor,
            TicketEventType.EXPENSE_UPDATED,
            data=_summary(expense),
            now=now,
        )
    # O sync do app baixa as OS pelo "atualizado em" (sem mexer na versão).
    await db.execute(
        sql_update(Ticket)
        .where(Ticket.id.in_(ticket_ids))
        .values(updated_at=now)
        .execution_options(synchronize_session=False)
    )
    for ticket in tickets.values():
        _changed(db, ticket, actor)
    await db.flush()
    return len(expenses)


async def report(
    db: AsyncSession,
    start: datetime,
    end: datetime,
    technician_id: uuid.UUID | None = None,
    status: ExpenseStatus | None = None,
    customer_id: uuid.UUID | None = None,
) -> ExpenseReport:
    # Só as colunas da OS que a linha mostra (a OS inteira traria as ~19 relações dela).
    stmt = (
        select(
            TicketExpense, Ticket.id, Ticket.number, Ticket.title, Customer.id, Customer.name
        )
        .join(Ticket, Ticket.id == TicketExpense.ticket_id)
        .outerjoin(Customer, Customer.id == Ticket.customer_id)
        .where(TicketExpense.created_at >= start, TicketExpense.created_at < end)
        .order_by(TicketExpense.created_at.desc())
    )
    if technician_id is not None:
        stmt = stmt.where(TicketExpense.technician_id == technician_id)
    if status is not None:
        stmt = stmt.where(TicketExpense.status == status)
    if customer_id is not None:
        stmt = stmt.where(Ticket.customer_id == customer_id)
    rows = (await db.execute(stmt)).all()

    items: list[ExpenseReportRow] = []
    total = Decimal("0")
    per_tech: dict[uuid.UUID | None, dict[str, Any]] = {}
    by_kind: dict[str, Decimal] = defaultdict(Decimal)
    for expense, ticket_id, number, title, customer_id_, customer_name in rows:
        row = ExpenseReportRow(
            **ExpenseOut.model_validate(expense).model_dump(),
            ticket=ExpenseTicketRef(
                id=ticket_id,
                code=format_ticket_code(number),
                title=title,
                customer={"id": customer_id_, "name": customer_name} if customer_id_ else None,
            ),
        )
        items.append(row)
        if expense.status == ExpenseStatus.REJECTED:
            continue
        total += expense.total
        by_kind[EXPENSE_KIND_LABEL[expense.kind.value]] += expense.total
        bucket = per_tech.setdefault(
            expense.technician_id,
            {
                "technician": expense.technician,
                "count": 0,
                "total": Decimal("0"),
                "to_pay": Decimal("0"),
            },
        )
        bucket["count"] += 1
        bucket["total"] += expense.total
        if expense.status == ExpenseStatus.APPROVED:
            bucket["to_pay"] += expense.total
    by_technician = [
        TechnicianTotal(
            technician={"id": b["technician"].id, "name": b["technician"].name}
            if b["technician"]
            else None,
            count=b["count"],
            total=b["total"],
            to_pay=b["to_pay"],
        )
        for b in sorted(per_tech.values(), key=lambda b: b["total"], reverse=True)
    ]
    return ExpenseReport(
        items=items, total=total, by_technician=by_technician, by_kind=dict(by_kind)
    )

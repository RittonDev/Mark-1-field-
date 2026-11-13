"""Custos extras da OS e o relatório de reembolso dos técnicos.

Só a gestão lança, altera e remove. O técnico vê os custos da OS dele (somente leitura).
"""

import uuid
from collections import defaultdict
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import ExpenseKind, ExpenseStatus, TicketEventType
from app.db.base import utcnow
from app.models import SystemSetting, Ticket, TicketAttachment, TicketExpense, User
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
    if technician_id is not None and await db.get(User, technician_id) is None:
        raise WorkflowError("Técnico não encontrado")
    if receipt_id is not None:
        receipt = await db.get(TicketAttachment, receipt_id)
        if receipt is None or receipt.ticket_id != ticket.id:
            raise WorkflowError("O comprovante precisa ser um anexo desta OS")


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
    await _check_refs(db, ticket, fields.get("technician_id"), fields.get("receipt_attachment_id"))
    for key, value in fields.items():
        if value is None and key in ("kind", "description", "quantity", "unit_value", "status"):
            continue
        if key == "description":
            value = value.strip()
        if key == "notes":
            value = (value or "").strip() or None
        setattr(expense, key, value)
    if "status" in fields and fields["status"] is not None:
        expense.paid_at = utcnow() if expense.status == ExpenseStatus.PAID else None
    expense.total = _total(expense.quantity, expense.unit_value)
    record_event(db, ticket, actor, TicketEventType.EXPENSE_UPDATED, data=_summary(expense))
    await _touch(db, ticket, utcnow())
    _changed(db, ticket, actor)
    await db.flush()
    await db.refresh(expense, ["technician", "created_by"])
    return expense


async def remove(db: AsyncSession, ticket: Ticket, expense: TicketExpense, actor: User) -> None:
    _require_manager(actor)
    record_event(db, ticket, actor, TicketEventType.EXPENSE_REMOVED, data=_summary(expense))
    await db.delete(expense)
    await _touch(db, ticket, utcnow())
    _changed(db, ticket, actor)
    await db.flush()


async def mark_paid(db: AsyncSession, ids: list[uuid.UUID], actor: User) -> int:
    """Reembolsa só os custos aprovados; os demais ids (lista desatualizada) ficam como estão.

    Devolve quantos foram marcados.
    """
    _require_manager(actor)
    expenses = list(
        await db.scalars(
            select(TicketExpense).where(
                TicketExpense.id.in_(ids), TicketExpense.status == ExpenseStatus.APPROVED
            )
        )
    )
    now = utcnow()
    for expense in expenses:
        expense.status = ExpenseStatus.PAID
        expense.paid_at = now
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
    stmt = (
        select(TicketExpense, Ticket)
        .join(Ticket, Ticket.id == TicketExpense.ticket_id)
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
    for expense, ticket in rows:
        row = ExpenseReportRow(
            **ExpenseOut.model_validate(expense).model_dump(),
            ticket=ExpenseTicketRef(
                id=ticket.id,
                code=format_ticket_code(ticket.number),
                title=ticket.title,
                customer={"id": ticket.customer.id, "name": ticket.customer.name}
                if ticket.customer
                else None,
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

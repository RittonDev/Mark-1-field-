import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import DB, CurrentUser, ManagerUser, TicketManagerUser
from app.core.enums import ExpenseStatus
from app.models import TicketExpense
from app.schemas.expense import (
    ExpenseIn,
    ExpenseOut,
    ExpenseReport,
    ExpenseSettings,
    ExpenseUpdate,
    MarkPaid,
)
from app.services import expenses as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["expenses"])


@router.get("/tickets/{ticket_id}/expenses", response_model=list[ExpenseOut])
async def list_expenses(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> list[TicketExpense]:
    """O técnico responsável vê (somente leitura); o solicitante não vê custo."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    if not user.is_staff:
        return []
    return list(ticket.expenses)


@router.post(
    "/tickets/{ticket_id}/expenses", response_model=ExpenseOut, status_code=status.HTTP_201_CREATED
)
async def create_expense(
    ticket_id: uuid.UUID, body: ExpenseIn, db: DB, user: TicketManagerUser
) -> TicketExpense:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    expense = await svc.create(db, ticket, body, user)
    await commit_and_publish(db)
    return expense


@router.patch("/expenses/{expense_id}", response_model=ExpenseOut)
async def update_expense(
    expense_id: uuid.UUID, body: ExpenseUpdate, db: DB, user: TicketManagerUser
) -> TicketExpense:
    expense = await svc.get(db, expense_id)
    ticket = await tickets_svc.get_ticket(db, expense.ticket_id)
    await svc.update(db, ticket, expense, body, user)
    await commit_and_publish(db)
    return expense


@router.delete("/expenses/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expense(expense_id: uuid.UUID, db: DB, user: TicketManagerUser) -> Response:
    expense = await svc.get(db, expense_id)
    ticket = await tickets_svc.get_ticket(db, expense.ticket_id)
    await svc.remove(db, ticket, expense, user)
    await commit_and_publish(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/expenses", response_model=ExpenseReport)
async def expense_report(
    db: DB,
    _: TicketManagerUser,
    start: datetime,
    end: datetime,
    technician_id: uuid.UUID | None = None,
    status_: Annotated[ExpenseStatus | None, Query(alias="status")] = None,
    customer_id: uuid.UUID | None = None,
) -> ExpenseReport:
    """Reembolso dos técnicos no período (lançamento), com totais por técnico e por tipo."""
    return await svc.report(db, start, end, technician_id, status_, customer_id)


@router.post("/expenses/mark-paid")
async def mark_paid(body: MarkPaid, db: DB, user: TicketManagerUser) -> dict[str, int]:
    count = await svc.mark_paid(db, body.ids, user)
    await db.commit()
    return {"updated": count}


@router.get("/settings/expenses", response_model=ExpenseSettings)
async def get_settings(db: DB, _: TicketManagerUser) -> ExpenseSettings:
    return ExpenseSettings(km_rate=await svc.km_rate(db))


@router.put("/settings/expenses", response_model=ExpenseSettings)
async def put_settings(body: ExpenseSettings, db: DB, user: ManagerUser) -> ExpenseSettings:
    """Valor do km rodado (supervisor ou admin)."""
    rate = await svc.set_km_rate(db, body.km_rate, user)
    await db.commit()
    return ExpenseSettings(km_rate=rate)

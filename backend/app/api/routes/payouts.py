"""Valor de cada técnico por OS, o fechamento dos pagamentos e os "Meus ganhos" do técnico."""

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel

from app.api.deps import DB, CurrentUser, TicketManagerUser
from app.core.enums import PayoutStatus, UserRole
from app.schemas.payout import MyEarnings, PayoutIds, PayoutIn, PayoutList, PayoutOut
from app.services import payouts as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["payouts"])


class PayoutChanged(BaseModel):
    changed: int


async def _ticket_payouts(db: DB, ticket_id: uuid.UUID) -> list[PayoutOut]:
    ticket = await tickets_svc.get_ticket(db, ticket_id)
    return [PayoutOut.model_validate(p) for p in ticket.payouts]


@router.put("/tickets/{ticket_id}/payouts/{technician_id}", response_model=list[PayoutOut])
async def set_payout(
    ticket_id: uuid.UUID, technician_id: uuid.UUID, body: PayoutIn, db: DB, user: TicketManagerUser
) -> list[PayoutOut]:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await svc.set_payout(db, ticket, technician_id, body, user)
    await commit_and_publish(db)
    return await _ticket_payouts(db, ticket_id)


@router.delete(
    "/tickets/{ticket_id}/payouts/{technician_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_payout(
    ticket_id: uuid.UUID, technician_id: uuid.UUID, db: DB, user: TicketManagerUser
) -> Response:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await svc.remove_payout(db, ticket, technician_id, user)
    await commit_and_publish(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/payouts", response_model=PayoutList)
async def list_payouts(
    db: DB,
    _: TicketManagerUser,
    technician_id: uuid.UUID | None = None,
    status_: Annotated[PayoutStatus | None, Query(alias="status")] = None,
    concluded: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> PayoutList:
    return await svc.list_payouts(
        db,
        technician_id=technician_id,
        status=status_,
        concluded=concluded,
        date_from=date_from,
        date_to=date_to,
    )


@router.post("/payouts/pay", response_model=PayoutChanged)
async def pay(body: PayoutIds, db: DB, user: TicketManagerUser) -> PayoutChanged:
    changed = await svc.mark_paid(db, body.ids, user, paid=True)
    await commit_and_publish(db)
    return PayoutChanged(changed=changed)


@router.post("/payouts/unpay", response_model=PayoutChanged)
async def unpay(body: PayoutIds, db: DB, user: TicketManagerUser) -> PayoutChanged:
    """Desfaz um pagamento marcado por engano (fica no histórico da OS)."""
    changed = await svc.mark_paid(db, body.ids, user, paid=False)
    await commit_and_publish(db)
    return PayoutChanged(changed=changed)


@router.get("/me/earnings", response_model=MyEarnings)
async def my_earnings(db: DB, user: CurrentUser, month: str | None = None) -> MyEarnings:
    """Meus ganhos (app do técnico). `month` no formato AAAA-MM; sem ele, tudo."""
    if user.role != UserRole.TECHNICIAN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Só para técnicos")
    when = None
    if month:
        try:
            year, mon = (int(part) for part in month.split("-", 1))
            when = date(year, mon, 1)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Mês inválido (use AAAA-MM)"
            ) from exc
    return await svc.my_earnings(db, user, when)

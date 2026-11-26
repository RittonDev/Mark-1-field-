"""Valor de cada técnico por OS, o fechamento dos pagamentos, as formas de recebimento dos técnicos
(a central vê e remove) e os ganhos do técnico (o mês e o Faturamento do app)."""

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel

from app.api.deps import DB, CurrentUser, access_user, require_roles
from app.core.enums import PayoutStatus, UserRole
from app.models import User
from app.models.user_change import VIA_CENTRAL
from app.schemas.payout import (
    EarningsMonths,
    MyEarnings,
    PayoutBoard,
    PayoutIds,
    PayoutIn,
    PayoutOut,
)
from app.schemas.payout_method import PayoutMethodAdmin
from app.services import payout_methods, user_history
from app.services import payouts as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["payouts"])

# Tela de Pagamentos (inclui o valor do técnico na OS). "Meus ganhos" e o Faturamento são do
# técnico.
PayoutsView = access_user("commercial.payouts")
PayoutsEdit = access_user("commercial.payouts", level="edit")
TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]

BAD_MONTH = "Mês inválido (use AAAA-MM)"
BAD_PERIOD = "Escolha datas entre 2000 e 2100"


class PayoutChanged(BaseModel):
    changed: int


async def _ticket_payouts(db: DB, ticket_id: uuid.UUID) -> list[PayoutOut]:
    ticket = await tickets_svc.get_ticket(db, ticket_id)
    return [PayoutOut.model_validate(p) for p in ticket.payouts]


@router.put("/tickets/{ticket_id}/payouts/{technician_id}", response_model=list[PayoutOut])
async def set_payout(
    ticket_id: uuid.UUID, technician_id: uuid.UUID, body: PayoutIn, db: DB, user: PayoutsEdit
) -> list[PayoutOut]:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await svc.set_payout(db, ticket, technician_id, body, user)
    await commit_and_publish(db)
    return await _ticket_payouts(db, ticket_id)


@router.delete(
    "/tickets/{ticket_id}/payouts/{technician_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_payout(
    ticket_id: uuid.UUID, technician_id: uuid.UUID, db: DB, user: PayoutsEdit
) -> Response:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await svc.remove_payout(db, ticket, technician_id, user)
    await commit_and_publish(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/payouts", response_model=PayoutBoard)
async def list_payouts(
    db: DB,
    user: PayoutsView,
    technician_id: uuid.UUID | None = None,
    status_: Annotated[PayoutStatus | None, Query(alias="status")] = None,
    concluded: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    with_payout_methods: bool = False,
) -> PayoutBoard:
    """`with_payout_methods=true`: `payout_methods` com a forma preferencial (inteira) e quantas
    formas têm os técnicos das linhas e do `technician_id` (o técnico sem forma fica fora); sem
    ele, `payout_methods` vem vazio (Relatórios não pede)."""
    if any(d is not None and not 2000 <= d.year <= 2100 for d in (date_from, date_to)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, BAD_PERIOD)
    listed = await svc.list_payouts(
        db,
        technician_id=technician_id,
        status=status_,
        concluded=concluded,
        date_from=date_from,
        date_to=date_to,
        viewer=user,
    )
    ids: set[uuid.UUID] = set()
    if with_payout_methods:
        ids = {line.technician.id for line in listed.items}
        if technician_id is not None:
            ids.add(technician_id)
    return PayoutBoard(
        items=listed.items,
        summary=listed.summary,
        total_count=listed.total_count,
        payout_methods=await payout_methods.summary_map(db, ids),
    )


@router.get("/technicians/{user_id}/payout-methods", response_model=list[PayoutMethodAdmin])
async def technician_payout_methods(
    user_id: uuid.UUID, db: DB, _: PayoutsView
) -> list[PayoutMethodAdmin]:
    """As formas de recebimento do técnico (a preferencial primeiro, depois as mais novas), com a
    chave e a conta inteiras para quem paga, "Titular diferente" (`holder_differs`) e o destino
    novo (`destination_changed_at`). Quem cadastra é o técnico, no app. 404 se não for técnico."""
    return await payout_methods.admin_list(db, user_id)


@router.delete(
    "/technicians/{user_id}/payout-methods/{method_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_technician_payout_method(
    user_id: uuid.UUID, method_id: uuid.UUID, db: DB, actor: PayoutsEdit
) -> Response:
    """A central remove uma forma (chave errada ou suspeita); quem cadastra uma nova é o técnico,
    no app. Era a preferencial: a mais nova das que ficam passa a ser. Histórico via "central" e
    aviso à gestão. 404 PAYOUT_METHOD_NOT_FOUND quando a forma não existe mais."""
    user, changes = await payout_methods.remove_by_central(db, user_id, method_id, actor)
    await db.commit()
    await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/payouts/pay", response_model=PayoutChanged)
async def pay(body: PayoutIds, db: DB, user: PayoutsEdit) -> PayoutChanged:
    changed = await svc.mark_paid(db, body.ids, user, paid=True)
    await commit_and_publish(db)
    return PayoutChanged(changed=changed)


@router.post("/payouts/unpay", response_model=PayoutChanged)
async def unpay(body: PayoutIds, db: DB, user: PayoutsEdit) -> PayoutChanged:
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
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, BAD_MONTH) from exc
        # Fora disso não há OS (e o ano 9999 estoura a conta do fim do mês).
        if not 2000 <= when.year <= 2100:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, BAD_MONTH)
    return await svc.my_earnings(db, user, when)


@router.get("/me/earnings/months", response_model=EarningsMonths)
async def my_earnings_months(
    db: DB,
    user: TechnicianUser,
    months: Annotated[int, Query(ge=1, le=svc.MONTHS_MAX)] = svc.MONTHS_DEFAULT,
) -> EarningsMonths:
    """Faturamento do app: os `months` meses até o atual (fuso da operação), o mais novo primeiro,
    com a situação de cada mês (calculada aqui: o app não repete a regra) e os totais. Só
    leitura."""
    return await svc.my_earnings_months(db, user, months)

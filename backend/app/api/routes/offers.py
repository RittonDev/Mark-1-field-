"""Oferta de OS com preço (services/offers.py).

Central: o preço é dado de Pagamentos. Ver as ofertas com os valores pede Pagamentos em
Visualizar; mandar e cancelar, em Editar (mandar também pede poder atribuir técnico). Sempre
dentro da fila de quem pede. Quem não tem a tela vê só o contador `open_offers` da OS.

Técnico (app): as ofertas dele, abrir (grava a leitura), aceitar pelo valor ou recusar. Ele vê a OS
da oferta antes de estar nela, só com o recorte do convite (sem cliente, loja, endereço e contato).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.api.deps import DB, access_user, require_roles
from app.api.routes.tickets import _detail
from app.core.enums import UserRole
from app.models import User
from app.schemas.offer import FieldOfferOut, OfferCreate, OfferDecline, TicketOfferOut
from app.schemas.ticket import TicketDetail
from app.services import offers as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["offers"])

# O valor oferecido ao técnico é de Pagamentos.
OffersView = access_user("commercial.payouts")
OffersEdit = access_user("commercial.payouts", level="edit")
TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]


# ------------------------------------------------------------------ central


@router.get("/tickets/{ticket_id}/offers", response_model=list[TicketOfferOut])
async def list_offers(ticket_id: uuid.UUID, db: DB, user: OffersView) -> list[TicketOfferOut]:
    """As ofertas da OS, a mais nova primeiro (também as que fecharam), com o estado efetivo."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    return await svc.ticket_offers(db, ticket.id)


@router.post(
    "/tickets/{ticket_id}/offers",
    response_model=list[TicketOfferOut],
    status_code=status.HTTP_201_CREATED,
)
async def send_offers(
    ticket_id: uuid.UUID, body: OfferCreate, db: DB, user: OffersEdit
) -> list[TicketOfferOut]:
    """Manda a OS (sem técnico, em aberto) para 1 a 10 técnicos ativos com o valor, o prazo para
    responder (opcional) e o recado. Devolve as ofertas criadas."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    offers = await svc.send(db, ticket, body, user)
    ids = [offer.id for offer in offers]
    await commit_and_publish(db)
    return await svc.offers_by_id(db, ids)


@router.post("/tickets/{ticket_id}/offers/{offer_id}/cancel", response_model=TicketOfferOut)
async def cancel_offer(
    ticket_id: uuid.UUID, offer_id: uuid.UUID, db: DB, user: OffersEdit
) -> TicketOfferOut:
    """Cancela a oferta pendente (o técnico recebe "A central cancelou esta oferta")."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    offer = await svc.cancel(db, ticket, offer_id, user)
    await commit_and_publish(db)
    return (await svc.offers_by_id(db, [offer.id]))[0]


# ------------------------------------------------------------------ técnico


@router.get("/me/offers", response_model=list[FieldOfferOut])
async def my_offers(db: DB, user: TechnicianUser) -> list[FieldOfferOut]:
    """As ofertas pendentes no prazo e as que fecharam nas últimas 24 h, a mais nova primeiro."""
    return await svc.my_offers(db, user)


@router.get("/me/offers/{offer_id}", response_model=FieldOfferOut)
async def open_offer(offer_id: uuid.UUID, db: DB, user: TechnicianUser) -> FieldOfferOut:
    """O detalhe da oferta. Abrir a pendente grava a leitura (`viewed_at`): sem ela, não aceita."""
    await svc.mark_viewed(db, offer_id, user)
    await commit_and_publish(db)
    return await svc.field_offer(db, offer_id, user)


@router.post("/me/offers/{offer_id}/accept", response_model=TicketDetail)
async def accept_offer(offer_id: uuid.UUID, db: DB, user: TechnicianUser) -> TicketDetail:
    """Aceita pelo valor da oferta: a OS passa a ser dele (a resposta é a OS como o app a vê)."""
    ticket = await svc.accept(db, offer_id, user)
    await commit_and_publish(db)
    return await _detail(db, ticket.id, user)


@router.post("/me/offers/{offer_id}/decline", response_model=FieldOfferOut)
async def decline_offer(
    offer_id: uuid.UUID, db: DB, user: TechnicianUser, body: OfferDecline | None = None
) -> FieldOfferOut:
    """Recusa a oferta (motivo opcional, até 300 caracteres)."""
    await svc.decline(db, offer_id, user, body.reason if body is not None else None)
    await commit_and_publish(db)
    return await svc.field_offer(db, offer_id, user)

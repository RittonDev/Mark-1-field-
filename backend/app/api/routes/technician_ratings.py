"""Avaliação do cliente sobre um técnico numa OS concluída (services/technician_ratings.py;
contrato da Entrega 2, §6.5).

Na OS: a gestão com a OS na fila dela (o núcleo da gestão, como os horários da OS; outra fila: 403
QUEUE_FORBIDDEN) vê, registra, corrige e exclui. Na ficha do técnico: a média, a contagem e a lista,
com Técnicos em Visualizar. O técnico nunca vê (403 aqui; nada no app nem em /me/*).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import DB, TicketManagerUser, access_user
from app.models.user_change import VIA_CENTRAL
from app.schemas.technician_rating import (
    RatingIn,
    TechnicianRatingOut,
    TechnicianRatingsOut,
    TicketRatingsOut,
)
from app.services import technicians, user_history
from app.services import technician_ratings as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["technician-ratings"])

TechniciansView = access_user("base.technicians")


@router.get("/tickets/{ticket_id}/ratings", response_model=TicketRatingsOut)
async def ticket_ratings(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> TicketRatingsOut:
    """O responsável, os auxiliares (papel técnico) e quem saiu da OS com avaliação, cada um com a
    dele (ou null). `concluded`: a OS está resolvida ou fechada (só ela recebe avaliação)."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    return await svc.ticket_ratings(db, ticket)


@router.put("/tickets/{ticket_id}/ratings/{technician_id}", response_model=TechnicianRatingOut)
async def rate_technician(
    ticket_id: uuid.UUID,
    technician_id: uuid.UUID,
    body: RatingIn,
    db: DB,
    user: TicketManagerUser,
) -> TechnicianRatingOut:
    """Registra ou corrige: `score` inteiro de 1 a 5, `comment` (até 1000) e `rater_name` (quem
    avaliou no cliente, até 120); vazio vira null. 409 RATING_NOT_CONCLUDED com a OS aberta; 422
    RATING_NOT_IN_TICKET para quem não está na OS (quem saiu e tem avaliação corrige). Igual ao
    gravado: 200 sem mudança. Histórico da OS (rating_set, só a gestão) e do cadastro (ratings)."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    change = await svc.rate(db, ticket, technician_id, body, user)
    assert change.rating is not None
    rating_id = change.rating.id
    await commit_and_publish(db)
    if change.changes:
        await user_history.publish_changed(
            change.technician, change.changes, via=VIA_CENTRAL, actor=user
        )
    return await svc.rating_of(db, rating_id, ticket)


@router.delete(
    "/tickets/{ticket_id}/ratings/{technician_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_rating(
    ticket_id: uuid.UUID, technician_id: uuid.UUID, db: DB, user: TicketManagerUser
) -> Response:
    """Exclui (204). Sem avaliação: 404 RATING_NOT_FOUND; OS aberta: 409 RATING_NOT_CONCLUDED."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    change = await svc.remove(db, ticket, technician_id, user)
    await commit_and_publish(db)
    await user_history.publish_changed(
        change.technician, change.changes, via=VIA_CENTRAL, actor=user
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/technicians/{user_id}/ratings", response_model=TechnicianRatingsOut)
async def technician_ratings(
    user_id: uuid.UUID,
    db: DB,
    _: TechniciansView,
    limit: Annotated[int, Query(ge=1, le=svc.PAGE_MAX)] = svc.PAGE_DEFAULT,
    # Até o maior BIGINT do Postgres (acima disso o banco recusa o OFFSET: seria um 500).
    offset: Annotated[int, Query(ge=0, le=2**63 - 1)] = 0,
) -> TechnicianRatingsOut:
    """A média (1 casa, ROUND_HALF_UP) e a contagem de todas as avaliações do técnico e a página
    pedida, a mais nova primeiro. 404 se não for técnico."""
    technician = await technicians.get_technician(db, user_id)
    return await svc.for_technician(db, technician.id, limit, offset)

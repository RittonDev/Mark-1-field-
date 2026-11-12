"""Minha fila (analista) e as filas da equipe."""

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DB, TicketManagerUser
from app.models import User
from app.schemas.queues import MyQueue, TeamQueues
from app.services import queues as svc
from app.services.errors import NotFound

router = APIRouter(tags=["queues"])


@router.get("/queues", response_model=TeamQueues)
async def team_queues(db: DB, _: TicketManagerUser) -> TeamQueues:
    """Quantas OS cada analista/gestor tem na fila (e as sem analista)."""
    return await svc.team_queues(db)


@router.get("/my-queue", response_model=MyQueue)
async def my_queue(
    db: DB,
    user: TicketManagerUser,
    user_id: uuid.UUID | None = None,
    day: Annotated[dt.date | None, Query(alias="date")] = None,
) -> MyQueue:
    """A fila do dia: minhas OS (ou de um colega, com `user_id`) organizadas por seção."""
    target = user
    if user_id is not None and user_id != user.id:
        found = await db.get(User, user_id)
        if found is None:
            raise NotFound("Usuário não encontrado")
        target = found
    return await svc.my_queue(db, target, day)

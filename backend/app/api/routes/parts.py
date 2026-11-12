"""Pedidos de peça do técnico (peça só entra com orçamento aprovado)."""

import uuid

from fastapi import APIRouter, status

from app.api.deps import DB, StaffUser, TicketManagerUser
from app.models import User
from app.models.part_request import TicketPartRequest
from app.schemas.part_request import (
    PartRequestAttachment,
    PartRequestIn,
    PartRequestOut,
    PartRequestUpdate,
)
from app.services import parts as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["part-requests"])


def _out(request: TicketPartRequest, user: User) -> PartRequestOut:
    out = PartRequestOut.model_validate(request)
    out.attachments = [
        PartRequestAttachment(id=att_id, url=tickets_svc.attachment_url(att_id, user))
        for att_id in out.attachment_ids
    ]
    return out


@router.get("/tickets/{ticket_id}/part-requests", response_model=list[PartRequestOut])
async def list_part_requests(ticket_id: uuid.UUID, db: DB, user: StaffUser) -> list[PartRequestOut]:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    return [_out(r, user) for r in await svc.list_for_ticket(db, ticket)]


@router.post(
    "/tickets/{ticket_id}/part-requests",
    response_model=PartRequestOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_part_request(
    ticket_id: uuid.UUID, body: PartRequestIn, db: DB, user: StaffUser
) -> PartRequestOut:
    """O técnico da OS (ou a gestão) pede a peça; a gestão monta o orçamento a partir dele."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    request = await svc.create(db, ticket, body, user)
    await commit_and_publish(db)
    return _out(await svc.get(db, request.id), user)


@router.patch("/part-requests/{request_id}", response_model=PartRequestOut)
async def update_part_request(
    request_id: uuid.UUID, body: PartRequestUpdate, db: DB, user: TicketManagerUser
) -> PartRequestOut:
    request = await svc.get(db, request_id)
    await tickets_svc.get_visible_ticket(db, user, request.ticket_id)
    await svc.update(db, request, body, user)
    await commit_and_publish(db)
    await db.refresh(request, ["quote", "requested_by"])
    return _out(request, user)

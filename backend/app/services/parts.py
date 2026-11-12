"""Pedidos de peça do técnico: peça só entra com orçamento aprovado e assinado pelo cliente.

Fluxo: o técnico pede (no app, inclusive offline) -> a gestão monta o orçamento a partir do
pedido e liga os dois -> o cliente aprova (ou recusa) pelo link -> o pedido acompanha a
decisão e o técnico é avisado.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import PartRequestStatus, QuoteStatus, TicketEventType, UserRole
from app.db.base import utcnow
from app.models import Quote, Ticket, TicketAttachment, User
from app.models.part_request import TicketPartRequest
from app.schemas.part_request import PartRequestIn, PartRequestUpdate
from app.services.errors import NotFound, PermissionDenied, WorkflowError
from app.services.realtime import queue_event
from app.services.tickets import FINAL, _touch, record_event

P = PartRequestStatus
# Pedidos que ainda acompanham a decisão do orçamento ligado.
FOLLOWING_QUOTE = (P.OPEN, P.QUOTED)
STATUS_LABEL = {
    P.OPEN: "aberto",
    P.QUOTED: "orçado",
    P.APPROVED: "aprovado",
    P.REJECTED: "recusado",
    P.CANCELLED: "cancelado",
}


def _can_request(actor: User, ticket: Ticket) -> bool:
    if actor.can_manage_tickets:
        return True
    return actor.role == UserRole.TECHNICIAN and ticket.assignee_id == actor.id


def _summary(request: TicketPartRequest) -> dict[str, Any]:
    quantity = request.quantity.normalize() if request.quantity is not None else None
    return {
        "part_request_id": str(request.id),
        "description": request.description,
        "quantity": f"{quantity:f}" if quantity is not None else None,
        "unit": request.unit,
        "status": request.status.value,
    }


async def create(
    db: AsyncSession, ticket: Ticket, data: PartRequestIn, actor: User
) -> TicketPartRequest:
    if not _can_request(actor, ticket):
        raise PermissionDenied("Só o técnico da OS ou a gestão pedem peça")
    if ticket.status in FINAL:
        raise WorkflowError("OS encerrada não recebe pedido de peça")
    if data.client_id:
        existing = await db.scalar(
            select(TicketPartRequest).where(
                TicketPartRequest.ticket_id == ticket.id,
                TicketPartRequest.client_id == data.client_id,
            )
        )
        if existing is not None:
            return existing  # reenvio do mesmo pedido feito offline
    ids = list(dict.fromkeys(data.attachment_ids))
    if ids:
        found = set(
            await db.scalars(
                select(TicketAttachment.id).where(
                    TicketAttachment.ticket_id == ticket.id, TicketAttachment.id.in_(ids)
                )
            )
        )
        if found != set(ids):
            raise WorkflowError("Foto não encontrada nesta OS")
    now = utcnow()
    request = TicketPartRequest(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        requested_by_id=actor.id,
        description=" ".join(data.description.split()),
        quantity=data.quantity,
        unit=data.unit.strip() or "un",
        note=(data.note or "").strip() or None,
        attachment_ids=[str(i) for i in ids],
        status=P.OPEN,
        client_id=data.client_id,
        created_at=now,
        updated_at=now,
    )
    db.add(request)
    await db.flush()
    summary = _summary(request)
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.PART_REQUESTED,
        to_value=P.OPEN.value,
        note=request.note,
        data=summary,
        now=now,
    )
    await _touch(db, ticket, now)
    queue_event(db, "updated", ticket, actor, {"fields": ["part_requests"]}, internal=True)
    # Toast para a gestão: o técnico está esperando o orçamento.
    queue_event(
        db,
        "part_request_created",
        ticket,
        actor,
        summary,
        event_type="part_request.created",
        managers_only=True,
    )
    return request


async def list_for_ticket(db: AsyncSession, ticket: Ticket) -> list[TicketPartRequest]:
    return list(
        await db.scalars(
            select(TicketPartRequest)
            .where(TicketPartRequest.ticket_id == ticket.id)
            .order_by(TicketPartRequest.created_at)
        )
    )


async def get(db: AsyncSession, request_id: uuid.UUID) -> TicketPartRequest:
    request = await db.get(TicketPartRequest, request_id)
    if request is None:
        raise NotFound("Pedido de peça não encontrado")
    return request


def _notify_decision(
    db: AsyncSession, ticket: Ticket, actor: User | None, request: TicketPartRequest
) -> None:
    """Aprovado/recusado: o técnico recebe push e a gestão vê na hora."""
    queue_event(db, "part_request_decided", ticket, actor, _summary(request), internal=True)


async def update(
    db: AsyncSession, request: TicketPartRequest, data: PartRequestUpdate, actor: User
) -> TicketPartRequest:
    if not actor.can_manage_tickets:
        raise PermissionDenied("Só a gestão responde pedidos de peça")
    ticket = await db.get(Ticket, request.ticket_id)
    if ticket is None:
        raise NotFound("OS não encontrada")
    fields = data.model_fields_set
    before = request.status
    if "quote_id" in fields:
        if data.quote_id is None:
            request.quote_id = None
        else:
            quote = await db.get(Quote, data.quote_id)
            if quote is None or quote.ticket_id != request.ticket_id:
                raise WorkflowError("Escolha um orçamento desta OS")
            request.quote_id = quote.id
            if "status" not in fields and request.status == P.OPEN:
                # Ligou ao orçamento: segue a situação dele (já decidido ou à espera).
                request.status = (
                    P.APPROVED
                    if quote.status == QuoteStatus.APPROVED
                    else P.REJECTED
                    if quote.status == QuoteStatus.REJECTED
                    else P.QUOTED
                )
    if "status" in fields and data.status is not None:
        request.status = data.status
    if "response_note" in fields:
        request.response_note = (data.response_note or "").strip() or None
    now = utcnow()
    request.updated_at = now
    await db.flush()
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.PART_REQUEST_UPDATED,
        from_value=before.value,
        to_value=request.status.value,
        note=request.response_note if "response_note" in fields else None,
        data=_summary(request) | {"quote_id": str(request.quote_id) if request.quote_id else None},
        now=now,
    )
    await _touch(db, ticket, now)
    queue_event(db, "updated", ticket, actor, {"fields": ["part_requests"]}, internal=True)
    if request.status != before and request.status in (P.APPROVED, P.REJECTED):
        _notify_decision(db, ticket, actor, request)
    return request


async def on_quote_decided(
    db: AsyncSession, ticket: Ticket, quote: Quote, *, approved: bool
) -> None:
    """O cliente respondeu o orçamento: os pedidos ligados a ele acompanham a decisão."""
    requests = list(
        await db.scalars(
            select(TicketPartRequest).where(
                TicketPartRequest.quote_id == quote.id,
                TicketPartRequest.status.in_(FOLLOWING_QUOTE),
            )
        )
    )
    if not requests:
        return
    now = utcnow()
    target = P.APPROVED if approved else P.REJECTED
    for request in requests:
        before = request.status
        request.status = target
        request.updated_at = now
        record_event(
            db,
            ticket,
            None,
            TicketEventType.PART_REQUEST_UPDATED,
            from_value=before.value,
            to_value=target.value,
            note=f"Cliente {'aprovou' if approved else 'recusou'} o orçamento",
            data=_summary(request) | {"quote_id": str(quote.id)},
            now=now,
        )
        _notify_decision(db, ticket, None, request)
    await db.flush()

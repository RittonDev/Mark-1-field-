"""Orçamentos da OS: montar, enviar o link ao cliente e registrar a decisão dele."""

import hashlib
import secrets
import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import QuoteStatus, TicketEventType
from app.db.base import utcnow
from app.models import Quote, QuoteItemCatalog, Ticket, User
from app.schemas.quote import QuoteApprove, QuoteIn, format_quote_code
from app.services import storage
from app.services.activities import local_today
from app.services.errors import NotFound, PermissionDenied, WorkflowError
from app.services.realtime import bus, queue_event
from app.services.tickets import _touch, record_event

CENT = Decimal("0.01")
EDITABLE = (QuoteStatus.DRAFT, QuoteStatus.SENT, QuoteStatus.EXPIRED)


class QuoteUnavailable(Exception):
    """Link inexistente, cancelado, já respondido ou vencido."""


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _require_manager(actor: User) -> None:
    if not actor.can_manage_tickets:
        raise PermissionDenied("Orçamentos são feitos por analistas e gestores")


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _compute(data: QuoteIn) -> tuple[list[dict[str, Any]], Decimal, Decimal]:
    items = []
    subtotal = Decimal("0")
    for item in data.items:
        line = _money(item.quantity * item.unit_price)
        subtotal += line
        items.append(
            {
                "description": item.description.strip(),
                "quantity": str(item.quantity),
                "unit": item.unit.strip() or "un",
                "unit_price": str(item.unit_price),
                "total": str(line),
                "catalog_item_id": str(item.catalog_item_id) if item.catalog_item_id else None,
            }
        )
    if data.discount > subtotal:
        raise WorkflowError("O desconto não pode ser maior que o subtotal")
    return items, subtotal, subtotal - data.discount


def refresh_expiry(quote: Quote) -> None:
    """Enviado e vencido sem resposta passa a "vencido" (lido a qualquer momento)."""
    if (
        quote.status == QuoteStatus.SENT
        and quote.valid_until is not None
        and quote.valid_until < local_today()
    ):
        quote.status = QuoteStatus.EXPIRED


async def get(db: AsyncSession, quote_id: uuid.UUID) -> Quote:
    quote = await db.get(Quote, quote_id)
    if quote is None:
        raise NotFound("Orçamento não encontrado")
    refresh_expiry(quote)
    return quote


async def list_for_ticket(db: AsyncSession, ticket: Ticket) -> list[Quote]:
    rows = list(
        await db.scalars(
            select(Quote).where(Quote.ticket_id == ticket.id).order_by(Quote.created_at.desc())
        )
    )
    for q in rows:
        refresh_expiry(q)
    return rows


async def create(db: AsyncSession, ticket: Ticket, data: QuoteIn, actor: User) -> Quote:
    _require_manager(actor)
    items, subtotal, total = _compute(data)
    quote = Quote(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        status=QuoteStatus.DRAFT,
        title=data.title.strip(),
        items=items,
        subtotal=subtotal,
        discount=data.discount,
        total=total,
        valid_until=data.valid_until,
        notes=(data.notes or "").strip() or None,
        created_by_id=actor.id,
    )
    db.add(quote)
    await db.flush()
    await db.refresh(quote, ["created_by", "number"])
    return quote


async def update(db: AsyncSession, quote: Quote, data: QuoteIn, actor: User) -> Quote:
    _require_manager(actor)
    if quote.status not in EDITABLE:
        raise WorkflowError("Orçamento já respondido ou cancelado não pode ser alterado")
    items, subtotal, total = _compute(data)
    quote.title = data.title.strip()
    quote.items = items
    quote.subtotal = subtotal
    quote.discount = data.discount
    quote.total = total
    quote.valid_until = data.valid_until
    quote.notes = (data.notes or "").strip() or None
    # Mudou o que o cliente vai aprovar: o link antigo deixa de valer.
    quote.status = QuoteStatus.DRAFT
    quote.token_hash = None
    await db.flush()
    return quote


async def send(db: AsyncSession, ticket: Ticket, quote: Quote, actor: User) -> str:
    _require_manager(actor)
    if quote.status not in EDITABLE:
        raise WorkflowError("Orçamento já respondido ou cancelado")
    if quote.valid_until is not None and quote.valid_until < local_today():
        raise WorkflowError("A validade já passou: ajuste a data antes de enviar")
    token = secrets.token_urlsafe(32)
    quote.token_hash = _hash(token)
    quote.status = QuoteStatus.SENT
    quote.sent_at = utcnow()
    quote.sent_by_id = actor.id
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.QUOTE_SENT,
        to_value=format_quote_code(quote.number),
        data={"quote_id": str(quote.id), "total": str(quote.total)},
    )
    await _touch(db, ticket, utcnow())
    queue_event(db, "updated", ticket, actor, {"fields": ["quotes"]}, internal=True)
    await db.flush()
    return token


async def cancel(db: AsyncSession, quote: Quote, actor: User) -> Quote:
    _require_manager(actor)
    if quote.status in (QuoteStatus.APPROVED, QuoteStatus.REJECTED):
        raise WorkflowError("Orçamento já respondido pelo cliente")
    quote.status = QuoteStatus.CANCELLED
    quote.token_hash = None
    await db.flush()
    return quote


# ------------------------------------------------------------ link do cliente


async def by_token(db: AsyncSession, token: str) -> Quote:
    quote = await db.scalar(select(Quote).where(Quote.token_hash == _hash(token)))
    if quote is None:
        raise QuoteUnavailable
    refresh_expiry(quote)
    return quote


def _ensure_open(quote: Quote) -> None:
    if quote.status != QuoteStatus.SENT:
        raise QuoteUnavailable


async def _decided(db: AsyncSession, ticket: Ticket, quote: Quote, approved: bool) -> None:
    event = TicketEventType.QUOTE_APPROVED if approved else TicketEventType.QUOTE_REJECTED
    record_event(
        db,
        ticket,
        None,
        event,
        to_value=format_quote_code(quote.number),
        note=quote.rejection_reason,
        data={
            "quote_id": str(quote.id),
            "total": str(quote.total),
            "by": quote.approver_name,
        },
    )
    await _touch(db, ticket, utcnow())
    queue_event(db, "updated", ticket, None, {"fields": ["quotes"]}, internal=True)


async def approve(db: AsyncSession, quote: Quote, data: QuoteApprove, ip: str | None) -> Quote:
    _ensure_open(quote)
    if not data.accept:
        raise WorkflowError("Marque a concordância com o orçamento para aprovar")
    try:
        raw, ext = storage.decode_image_data_url(data.signature, 1024 * 1024)
    except storage.InvalidImage as exc:
        raise WorkflowError("Assinatura inválida: assine no quadro e tente de novo") from exc
    quote.signature_key = await storage.save_bytes("quotes", ext, raw)
    quote.status = QuoteStatus.APPROVED
    quote.decided_at = utcnow()
    quote.approver_name = " ".join(data.name.split())
    quote.approver_document = (data.document or "").strip() or None
    quote.approver_role = (data.role or "").strip() or None
    quote.decision_ip = ip  # o link segue abrindo, só para consulta (o status impede 2ª resposta)
    ticket = await db.get(Ticket, quote.ticket_id)
    if ticket is not None:
        await _decided(db, ticket, quote, approved=True)
    await db.flush()
    return quote


async def reject(
    db: AsyncSession, quote: Quote, reason: str, name: str | None, ip: str | None
) -> Quote:
    _ensure_open(quote)
    quote.status = QuoteStatus.REJECTED
    quote.decided_at = utcnow()
    quote.rejection_reason = reason.strip()
    quote.approver_name = " ".join((name or "").split()) or None
    quote.decision_ip = ip
    ticket = await db.get(Ticket, quote.ticket_id)
    if ticket is not None:
        await _decided(db, ticket, quote, approved=False)
    await db.flush()
    return quote


async def publish_decision(quote: Quote, ticket_code: str) -> None:
    """Toast para a gestão na hora em que o cliente responde."""
    await bus.publish(
        {
            "type": "quote.decided",
            "quote_id": str(quote.id),
            "ticket_id": str(quote.ticket_id),
            "ticket_code": ticket_code,
            "quote_code": format_quote_code(quote.number),
            "status": quote.status.value,
            "name": quote.approver_name,
            "audience": {"managers_only": True},
        }
    )


# ------------------------------------------------------------------ catálogo


async def catalog_item(db: AsyncSession, item_id: uuid.UUID) -> QuoteItemCatalog:
    item = await db.get(QuoteItemCatalog, item_id)
    if item is None:
        raise NotFound("Item não encontrado")
    return item

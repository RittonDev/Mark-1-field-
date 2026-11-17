"""Orçamentos da OS: montar, enviar o link ao cliente, cobrar a resposta e registrar a decisão.

A fila "Para cobrar" (lista de /orcamentos e o Início) tem uma regra só, escrita duas vezes: em SQL
(follow_up_condition, para filtrar e contar no banco) e em Python (follow_up, o motivo de cada
orçamento). As duas precisam bater: um orçamento está na fila se e só se tem motivo.
"""

import hashlib
import uuid
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import ColumnElement, and_, case, column, func, or_, select, true, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.config import settings
from app.core.enums import QuoteStatus, TicketEventType, TicketStatus, UserRole
from app.db.base import utcnow
from app.models import Quote, QuoteItemCatalog, Ticket, User
from app.schemas.quote import (
    QuoteApprove,
    QuoteFollowUp,
    QuoteIn,
    QuoteLastPrice,
    QuoteLink,
    format_quote_code,
)
from app.services import parts, storage
from app.services.activities import day_bounds, local_today
from app.services.client_report import VIEW_DEDUPE
from app.services.errors import NotFound, PermissionDenied, WorkflowError
from app.services.realtime import bus, queue_event
from app.services.tickets import _touch, record_event

CENT = Decimal("0.01")
EDITABLE = (QuoteStatus.DRAFT, QuoteStatus.SENT, QuoteStatus.EXPIRED)
LINK_KIND = "quote"
ANSWERED = "Este orçamento já foi respondido ou venceu"
IN_REVIEW = "Este orçamento está em revisão pela empresa. Aguarde o novo envio para responder."

# Fila "Para cobrar". 82% das aprovações saem em até 24 h: sem resposta em 2 dias, cobrar.
FOLLOW_UP_AFTER = timedelta(hours=48)
IN_REVIEW_AFTER = timedelta(hours=24)
EXPIRED_WINDOW = timedelta(days=7)
# Enviado sem validade há mais de 30 dias sai da fila (ninguém vai cobrar mais).
SENT_WINDOW = timedelta(days=30)
# Uso do item do catálogo: orçamentos dos últimos 12 meses.
USAGE_WINDOW = timedelta(days=365)

NOT_WAITING = "Só orçamento aguardando o cliente pode ser cobrado"
EXPIRED_REMIND = "O orçamento venceu: renove a validade antes de cobrar"
NO_LINK = "Gere o link antes de cobrar"


class QuoteUnavailable(Exception):
    """Link inexistente, trocado, adulterado ou de orçamento cancelado."""


class QuoteNotOpen(Exception):
    """O link abre, mas o orçamento não aceita resposta agora (respondido, vencido, em revisão)."""


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
                "kind": item.kind,
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
    # Mudou o que o cliente vai aprovar: volta a rascunho. O link continua o mesmo: o cliente
    # vê o conteúdo atual "em revisão" e pode responder de novo quando for reenviado.
    quote.status = QuoteStatus.DRAFT
    await db.flush()
    return quote


def link_out(quote: Quote) -> QuoteLink | None:
    """Link do cliente para copiar e enviar (existe a partir do primeiro envio)."""
    if not quote.link_id or quote.status == QuoteStatus.CANCELLED:
        return None
    token = links.token_for(LINK_KIND, quote.link_id)
    path = f"/orcamento/{token}"
    return QuoteLink(token=token, path=path, url=f"{settings.WEB_URL.rstrip('/')}{path}")


async def send(db: AsyncSession, ticket: Ticket, quote: Quote, actor: User) -> str:
    _require_manager(actor)
    if quote.status not in EDITABLE:
        raise WorkflowError("Orçamento já respondido ou cancelado")
    if quote.valid_until is not None and quote.valid_until < local_today():
        raise WorkflowError("A validade já passou: ajuste a data antes de enviar")
    # Reenviar mantém o mesmo link (o cliente usa o que já recebeu).
    if quote.link_id is None:
        quote.link_id = links.new_link_id()
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
    return links.token_for(LINK_KIND, quote.link_id)


async def rotate_link(db: AsyncSession, quote: Quote, actor: User) -> QuoteLink:
    """Troca o link (o anterior, inclusive um antigo só com hash, para de abrir)."""
    _require_manager(actor)
    if quote.status == QuoteStatus.CANCELLED or (
        quote.link_id is None and quote.token_hash is None
    ):
        raise WorkflowError("Envie o orçamento para gerar o link do cliente")
    quote.link_id = links.new_link_id()
    quote.token_hash = None
    await db.flush()
    out = link_out(quote)
    assert out is not None
    return out


async def cancel(db: AsyncSession, quote: Quote, actor: User) -> Quote:
    _require_manager(actor)
    if quote.status in (QuoteStatus.APPROVED, QuoteStatus.REJECTED):
        raise WorkflowError("Orçamento já respondido pelo cliente")
    quote.status = QuoteStatus.CANCELLED
    quote.link_id = None
    quote.token_hash = None
    # Os pedidos de peça ligados a ele voltam a esperar um orçamento.
    ticket = await db.get(Ticket, quote.ticket_id)
    if ticket is not None:
        await parts.on_quote_cancelled(db, ticket, quote, actor)
    await db.flush()
    return quote


# ------------------------------------------------------------ cobrar a resposta


def has_link(quote: Quote) -> bool:
    return quote.link_id is not None or quote.token_hash is not None


def _contact(quote: Quote) -> datetime | None:
    """Último contato com o cliente: a última cobrança ou, sem ela, o envio."""
    return quote.last_reminded_at or quote.sent_at


def follow_up(
    quote: Quote, *, ticket_cancelled: bool, now: datetime, today: date
) -> QuoteFollowUp | None:
    """Por que cobrar este orçamento agora (None: fora da fila). Versão Python da regra; a de SQL
    é follow_up_condition. Na ordem de precedência:

    - expired: venceu há até 7 dias (renovar e reenviar);
    - expiring: vence hoje ou amanhã e ninguém falou com o cliente hoje;
    - not_opened / no_answer: enviado nos últimos 30 dias e o último contato (envio ou cobrança)
      foi há 48 h ou mais; "não abriu" quando há link e nenhuma abertura;
    - in_review: editado depois do envio (volta a rascunho) e parado há 24 h sem reenviar.

    Orçamento de OS cancelada nunca entra.
    """
    if ticket_cancelled:
        return None
    valid = quote.valid_until
    sent = quote.status == QuoteStatus.SENT
    contact = _contact(quote)
    if quote.status == QuoteStatus.EXPIRED or (sent and valid is not None and valid < today):
        return "expired" if valid is not None and valid >= today - EXPIRED_WINDOW else None
    if sent:
        if (
            valid is not None
            and today <= valid <= today + timedelta(days=1)
            and (contact is None or contact < day_bounds(today)[0])
        ):
            return "expiring"
        if (
            quote.sent_at is not None
            and quote.sent_at >= now - SENT_WINDOW
            and contact is not None
            and contact <= now - FOLLOW_UP_AFTER
        ):
            return "not_opened" if has_link(quote) and not quote.client_views else "no_answer"
        return None
    if (
        quote.status == QuoteStatus.DRAFT
        and quote.sent_at is not None
        and quote.updated_at <= now - IN_REVIEW_AFTER
    ):
        return "in_review"
    return None


def follow_up_condition(now: datetime, today: date, day_start: datetime) -> ColumnElement[bool]:
    """A regra de follow_up em SQL (quem chama faz o join com Ticket). "Não abriu" e "sem
    resposta" têm a mesma condição de fila: o que separa os dois (as aberturas) é só o motivo."""
    contact = func.coalesce(Quote.last_reminded_at, Quote.sent_at)
    sent = Quote.status == QuoteStatus.SENT
    overdue = or_(Quote.status == QuoteStatus.EXPIRED, and_(sent, Quote.valid_until < today))
    return and_(
        Ticket.status != TicketStatus.CANCELLED,
        or_(
            # expired
            and_(overdue, Quote.valid_until >= today - EXPIRED_WINDOW),
            # expiring
            and_(
                sent,
                Quote.valid_until >= today,
                Quote.valid_until <= today + timedelta(days=1),
                or_(contact.is_(None), contact < day_start),
            ),
            # not_opened e no_answer
            and_(
                sent,
                or_(Quote.valid_until.is_(None), Quote.valid_until >= today),
                Quote.sent_at >= now - SENT_WINDOW,
                contact <= now - FOLLOW_UP_AFTER,
            ),
            # in_review
            and_(
                Quote.status == QuoteStatus.DRAFT,
                Quote.sent_at.is_not(None),
                Quote.updated_at <= now - IN_REVIEW_AFTER,
            ),
        ),
    )


def follow_up_order() -> list[Any]:
    """Quem vence antes primeiro (sem validade no fim), depois o contato mais antigo."""
    return [
        Quote.valid_until.asc().nulls_last(),
        func.coalesce(Quote.last_reminded_at, Quote.sent_at).asc(),
        Quote.number.asc(),
    ]


async def remind(db: AsyncSession, ticket: Ticket, quote: Quote, actor: User) -> Quote:
    """Registra a cobrança da resposta (o lembrete sai pelo WhatsApp, montado na tela). A cobrança
    vira o último contato: o orçamento sai da fila por 48 h."""
    _require_manager(actor)
    # Enviado com a validade passada vira "vencido" aqui: pede renovar, e não cobrar.
    refresh_expiry(quote)
    if quote.status == QuoteStatus.EXPIRED:
        raise WorkflowError(EXPIRED_REMIND)
    if quote.status != QuoteStatus.SENT:
        raise WorkflowError(NOT_WAITING)
    if not has_link(quote):
        raise WorkflowError(NO_LINK)
    now = utcnow()
    quote.reminder_count = (quote.reminder_count or 0) + 1
    quote.last_reminded_at = now
    quote.last_reminded_by_id = actor.id
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.QUOTE_REMINDED,
        to_value=format_quote_code(quote.number),
        data={
            "quote_id": str(quote.id),
            "count": quote.reminder_count,
            "total": str(quote.total),
        },
        now=now,
    )
    await _touch(db, ticket, now)
    queue_event(db, "updated", ticket, actor, {"fields": ["quotes"]}, internal=True)
    await db.flush()
    await db.refresh(quote, ["last_reminded_by"])
    return quote


# ------------------------------------------------------------ aberturas do cliente


def counts_as_view(viewer: User | None, preview: bool) -> bool:
    """Só o cliente conta: sem sessão ou com a do portal (solicitante). A equipe com sessão e a
    prévia ("Ver como o cliente", ?preview=1) não contam."""
    if preview:
        return False
    return viewer is None or viewer.role == UserRole.REQUESTER


async def register_view(db: AsyncSession, quote: Quote, now: datetime) -> None:
    """Conta a abertura do cliente numa atualização só (duas abas ao mesmo tempo não contam em
    dobro); de novo em menos de 10 min só atualiza a hora. Não mexe no "atualizado em": a visita
    não reinicia o "em revisão" nem muda a ordem das listas."""
    last = Quote.client_last_viewed_at
    await db.execute(
        update(Quote)
        .where(Quote.id == quote.id)
        .values(
            client_views=case(
                (or_(last.is_(None), last <= now - VIEW_DEDUPE), Quote.client_views + 1),
                else_=Quote.client_views,
            ),
            client_first_viewed_at=func.coalesce(Quote.client_first_viewed_at, now),
            client_last_viewed_at=now,
            updated_at=Quote.updated_at,
        )
        .execution_options(synchronize_session=False)
    )


# ------------------------------------------------------------ link do cliente


async def by_token(db: AsyncSession, token: str) -> Quote:
    if "." in token:
        link_id = links.parse_token(LINK_KIND, token)
        if link_id is None:
            raise QuoteUnavailable
        quote = await db.scalar(select(Quote).where(Quote.link_id == link_id))
    else:
        # Link enviado antes do link_id (só o hash no banco).
        quote = await db.scalar(select(Quote).where(Quote.token_hash == _hash(token)))
    if quote is None or quote.status == QuoteStatus.CANCELLED:
        raise QuoteUnavailable
    refresh_expiry(quote)
    return quote


def _ensure_open(quote: Quote) -> None:
    if quote.status == QuoteStatus.DRAFT:
        raise QuoteNotOpen(IN_REVIEW)
    if quote.status != QuoteStatus.SENT:
        raise QuoteNotOpen(ANSWERED)


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
    quote.approver_registration = (data.registration or "").strip() or None
    quote.client_comment = (data.comment or "").strip() or None
    quote.approver_document = (data.document or "").strip() or None
    quote.approver_role = (data.role or "").strip() or None
    quote.decision_ip = ip  # o link segue abrindo, só para consulta (o status impede 2ª resposta)
    ticket = await db.get(Ticket, quote.ticket_id)
    if ticket is not None:
        await _decided(db, ticket, quote, approved=True)
        # Pedidos de peça ligados a este orçamento: liberados para a troca.
        await parts.on_quote_decided(db, ticket, quote, approved=True)
    await db.flush()
    return quote


async def reject(
    db: AsyncSession,
    quote: Quote,
    reason: str,
    name: str | None,
    ip: str | None,
    comment: str | None = None,
) -> Quote:
    _ensure_open(quote)
    quote.status = QuoteStatus.REJECTED
    quote.decided_at = utcnow()
    quote.rejection_reason = reason.strip()
    quote.client_comment = (comment or "").strip() or None
    quote.approver_name = " ".join((name or "").split()) or None
    quote.decision_ip = ip
    ticket = await db.get(Ticket, quote.ticket_id)
    if ticket is not None:
        await _decided(db, ticket, quote, approved=False)
        await parts.on_quote_decided(db, ticket, quote, approved=False)
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

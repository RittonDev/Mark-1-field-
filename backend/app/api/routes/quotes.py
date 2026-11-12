import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import DB, TicketManagerUser
from app.core.config import settings
from app.core.enums import QuoteStatus
from app.core.security import InvalidToken, create_token, decode_token
from app.models import Quote, QuoteItemCatalog, Ticket
from app.schemas.quote import (
    CatalogItemIn,
    CatalogItemOut,
    PublicQuote,
    PublicQuoteAddress,
    PublicQuoteCustomer,
    QuoteApprove,
    QuoteIn,
    QuoteLink,
    QuoteListRow,
    QuoteOut,
    QuoteReject,
    QuoteSent,
    format_quote_code,
)
from app.schemas.ticket import format_ticket_code
from app.services import company as company_svc
from app.services import quotes as svc
from app.services import storage
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["quotes"])
public = APIRouter(prefix="/public/quotes", tags=["quotes"])

LINK_GONE = "Este orçamento não está mais disponível. Fale com a Maxx Field."


SIGNATURE_LINK = timedelta(minutes=30)
PUBLIC_SIGNATURE_LINK = timedelta(hours=24)


def _signature_path(quote: Quote, ttl: timedelta) -> str:
    token = create_token(f"quote-signature:{quote.id}", "download", ttl)
    return f"{settings.API_PREFIX}/quotes/{quote.id}/signature?token={token}"


def _out(quote: Quote) -> QuoteOut:
    out = QuoteOut.model_validate(quote)
    if quote.signature_key:
        out.signature_url = _signature_path(quote, SIGNATURE_LINK)
    elif quote.legacy and quote.legacy.get("signature_url"):
        # Orçamento migrado: a assinatura continua no armazenamento do Field Control.
        out.signature_url = quote.legacy["signature_url"]
    out.link = svc.link_out(quote)
    return out


# ------------------------------------------------------------------ catálogo


@router.get("/quote-items", response_model=list[CatalogItemOut])
async def list_catalog(
    db: DB, _: TicketManagerUser, active: bool | None = None
) -> list[QuoteItemCatalog]:
    stmt = select(QuoteItemCatalog).order_by(QuoteItemCatalog.name)
    if active is not None:
        stmt = stmt.where(QuoteItemCatalog.is_active.is_(active))
    return list(await db.scalars(stmt))


@router.post("/quote-items", response_model=CatalogItemOut, status_code=status.HTTP_201_CREATED)
async def create_catalog_item(
    body: CatalogItemIn, db: DB, _: TicketManagerUser
) -> QuoteItemCatalog:
    item = QuoteItemCatalog(id=uuid.uuid4(), **body.model_dump())
    db.add(item)
    await db.commit()
    return item


@router.put("/quote-items/{item_id}", response_model=CatalogItemOut)
async def update_catalog_item(
    item_id: uuid.UUID, body: CatalogItemIn, db: DB, _: TicketManagerUser
) -> QuoteItemCatalog:
    item = await svc.catalog_item(db, item_id)
    for key, value in body.model_dump().items():
        setattr(item, key, value)
    await db.commit()
    return item


# ------------------------------------------------------------------ orçamentos


@router.get("/tickets/{ticket_id}/quotes", response_model=list[QuoteOut])
async def ticket_quotes(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> list[QuoteOut]:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    quotes = await svc.list_for_ticket(db, ticket)
    await db.commit()  # grava os que venceram
    return [_out(q) for q in quotes]


@router.post(
    "/tickets/{ticket_id}/quotes", response_model=QuoteOut, status_code=status.HTTP_201_CREATED
)
async def create_quote(
    ticket_id: uuid.UUID, body: QuoteIn, db: DB, user: TicketManagerUser
) -> QuoteOut:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    quote = await svc.create(db, ticket, body, user)
    await db.commit()
    return _out(quote)


@router.put("/quotes/{quote_id}", response_model=QuoteOut)
async def update_quote(
    quote_id: uuid.UUID, body: QuoteIn, db: DB, user: TicketManagerUser
) -> QuoteOut:
    quote = await svc.update(db, await svc.get(db, quote_id), body, user)
    await db.commit()
    return _out(quote)


@router.post("/quotes/{quote_id}/send", response_model=QuoteSent)
async def send_quote(quote_id: uuid.UUID, db: DB, user: TicketManagerUser) -> QuoteSent:
    """Marca como enviado e devolve o link do cliente (reenviar mantém o mesmo link)."""
    quote = await svc.get(db, quote_id)
    ticket = await tickets_svc.get_ticket(db, quote.ticket_id)
    token = await svc.send(db, ticket, quote, user)
    await commit_and_publish(db)
    return QuoteSent(**_out(quote).model_dump(exclude={"code"}), token=token)


@router.post("/quotes/{quote_id}/link/rotate", response_model=QuoteLink)
async def rotate_quote_link(quote_id: uuid.UUID, db: DB, user: TicketManagerUser) -> QuoteLink:
    """Troca o link do cliente: o anterior para de abrir."""
    link = await svc.rotate_link(db, await svc.get(db, quote_id), user)
    await db.commit()
    return link


@router.post("/quotes/{quote_id}/cancel", response_model=QuoteOut)
async def cancel_quote(quote_id: uuid.UUID, db: DB, user: TicketManagerUser) -> QuoteOut:
    quote = await svc.cancel(db, await svc.get(db, quote_id), user)
    await db.commit()
    return _out(quote)


@router.get("/quotes", response_model=list[QuoteListRow])
async def list_quotes(
    db: DB,
    _: TicketManagerUser,
    start: datetime | None = None,
    end: datetime | None = None,
    status_: Annotated[QuoteStatus | None, Query(alias="status")] = None,
) -> list[QuoteListRow]:
    stmt = (
        select(Quote, Ticket)
        .join(Ticket, Ticket.id == Quote.ticket_id)
        .order_by(Quote.created_at.desc())
        .limit(500)
    )
    if start is not None:
        stmt = stmt.where(Quote.created_at >= start)
    if end is not None:
        stmt = stmt.where(Quote.created_at < end)
    rows = (await db.execute(stmt)).all()
    out = []
    for quote, ticket in rows:
        svc.refresh_expiry(quote)
        if status_ is not None and quote.status != status_:
            continue
        out.append(
            QuoteListRow(
                **_out(quote).model_dump(exclude={"code"}),
                ticket_code=format_ticket_code(ticket.number),
                customer=ticket.customer.name if ticket.customer else None,
            )
        )
    await db.commit()
    return out


@router.get("/quotes/{quote_id}/signature", include_in_schema=False)
async def quote_signature(quote_id: uuid.UUID, token: str, db: DB) -> FileResponse:
    try:
        payload = decode_token(token, "download")
    except InvalidToken as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link expirado") from exc
    if payload.get("sub") != f"quote-signature:{quote_id}":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link inválido")
    quote = await svc.get(db, quote_id)
    if not quote.signature_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sem assinatura")
    return FileResponse(storage.open_path(quote.signature_key))


# ------------------------------------------------------------ link do cliente


async def _public(db: DB, token: str) -> tuple[Quote, Ticket]:
    try:
        quote = await svc.by_token(db, token)
    except svc.QuoteUnavailable as exc:
        raise HTTPException(status.HTTP_410_GONE, LINK_GONE) from exc
    ticket = await db.get(Ticket, quote.ticket_id)
    if ticket is None:
        raise HTTPException(status.HTTP_410_GONE, LINK_GONE)
    return quote, ticket


def _address(ticket: Ticket) -> PublicQuoteAddress | None:
    """Endereço do atendimento: o informado na OS ou o do local (com bairro, cidade e CEP)."""
    loc = ticket.location
    if ticket.service_address:
        line, district, zip_code = ticket.service_address, None, None
    elif loc is not None:
        line, district, zip_code = loc.address_line, loc.district, loc.zip_code
    else:
        return None
    city = loc.city if loc else None
    state = loc.state if loc else None
    head = " - ".join(p for p in (line, district) if p)
    city_state = " - ".join(p for p in (city, state) if p)
    full = ", ".join(p for p in (head, city_state, zip_code) if p) or None
    if full is None:
        return None
    return PublicQuoteAddress(
        line=line, district=district, city=city, state=state, zip_code=zip_code, full=full
    )


async def _public_view(db: DB, quote: Quote, ticket: Ticket, base_url: str) -> PublicQuote:
    out = _out(quote)
    customer = ticket.customer
    signature_url = None
    if quote.status == QuoteStatus.APPROVED and quote.signature_key:
        root = (settings.API_PUBLIC_URL or base_url).rstrip("/")
        signature_url = f"{root}{_signature_path(quote, PUBLIC_SIGNATURE_LINK)}"
    elif quote.status == QuoteStatus.APPROVED and (quote.legacy or {}).get("signature_url"):
        signature_url = (quote.legacy or {})["signature_url"]
    return PublicQuote(
        code=format_quote_code(quote.number),
        title=quote.title,
        status=quote.status,
        customer=customer.name if customer else None,
        location=ticket.location.name if ticket.location else None,
        ticket_code=format_ticket_code(ticket.number),
        ticket_title=ticket.title,
        items=out.items,
        subtotal=quote.subtotal,
        discount=quote.discount,
        total=quote.total,
        valid_until=quote.valid_until,
        notes=quote.notes,
        sent_at=quote.sent_at,
        decided_at=quote.decided_at,
        approver_name=quote.approver_name,
        rejection_reason=quote.rejection_reason,
        company=await company_svc.profile(db),
        customer_info=(
            PublicQuoteCustomer(
                name=customer.name,
                document=customer.document,
                email=customer.email,
                phone=customer.phone,
            )
            if customer
            else None
        ),
        address=_address(ticket),
        ticket_number=ticket.number,
        issued_at=quote.sent_at or quote.created_at,
        totals_by_kind=out.totals_by_kind,
        approver_registration=quote.approver_registration,
        client_comment=quote.client_comment,
        signature_url=signature_url,
    )


@public.get("/{token}", response_model=PublicQuote)
async def view_quote(token: str, request: Request, db: DB) -> PublicQuote:
    quote, ticket = await _public(db, token)
    await db.commit()
    return await _public_view(db, quote, ticket, str(request.base_url))


def _ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    return (
        forwarded.split(",")[0].strip()
        if forwarded
        else (request.client.host if request.client else None)
    )


@public.post("/{token}/approve", response_model=PublicQuote)
async def approve_quote(token: str, body: QuoteApprove, request: Request, db: DB) -> PublicQuote:
    quote, ticket = await _public(db, token)
    try:
        await svc.approve(db, quote, body, _ip(request))
    except svc.QuoteNotOpen as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    await commit_and_publish(db)
    await svc.publish_decision(quote, format_ticket_code(ticket.number))
    return await _public_view(db, quote, ticket, str(request.base_url))


@public.post("/{token}/reject", response_model=PublicQuote)
async def reject_quote(token: str, body: QuoteReject, request: Request, db: DB) -> PublicQuote:
    quote, ticket = await _public(db, token)
    try:
        await svc.reject(db, quote, body.reason, body.name, _ip(request), comment=body.comment)
    except svc.QuoteNotOpen as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    await commit_and_publish(db)
    await svc.publish_decision(quote, format_ticket_code(ticket.number))
    return await _public_view(db, quote, ticket, str(request.base_url))

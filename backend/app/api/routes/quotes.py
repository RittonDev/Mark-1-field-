import re
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import ColumnElement, and_, func, or_, select

from app.api.deps import DB, TicketManagerUser
from app.api.files import stored_file
from app.core.config import settings
from app.core.enums import QuoteStatus, TicketStatus
from app.core.security import InvalidToken, create_token, decode_token
from app.models import Customer, Location, Quote, QuoteItemCatalog, Ticket
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
    QuoteStatusTotal,
    QuoteSummary,
    format_quote_code,
)
from app.schemas.ticket import format_ticket_code
from app.services import company as company_svc
from app.services import quotes as svc
from app.services import search
from app.services import tickets as tickets_svc
from app.services.activities import local_today
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["quotes"])
public = APIRouter(prefix="/public/quotes", tags=["quotes"])

LINK_GONE = "Este orçamento não está mais disponível. Fale com a Maxx Field."
TICKET_CANCELLED = "A OS foi cancelada: reabra a OS antes de mexer no orçamento"
TICKET_CANCELLED_PUBLIC = "Esta OS foi cancelada. Fale com a Maxx Field."
# "ORC-000123" (orçamento), "OS 123" (OS), "#123" ou "123" (qualquer um dos dois).
_CODE = re.compile(r"^(?P<prefix>orc|os)?[\s#-]*0*(?P<number>\d{1,9})$", re.IGNORECASE)


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


async def _ticket_status(db: DB, ticket_id: uuid.UUID) -> TicketStatus | None:
    return await db.scalar(select(Ticket.status).where(Ticket.id == ticket_id))


async def _ensure_not_cancelled(db: DB, ticket_id: uuid.UUID) -> None:
    """OS cancelada não recebe orçamento novo nem envio (a aprovação liberaria peças e avisaria o
    técnico de uma OS que não existe mais). Reaberta, volta a valer."""
    if await _ticket_status(db, ticket_id) == TicketStatus.CANCELLED:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, TICKET_CANCELLED)


@router.post(
    "/tickets/{ticket_id}/quotes", response_model=QuoteOut, status_code=status.HTTP_201_CREATED
)
async def create_quote(
    ticket_id: uuid.UUID, body: QuoteIn, db: DB, user: TicketManagerUser
) -> QuoteOut:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await _ensure_not_cancelled(db, ticket.id)
    quote = await svc.create(db, ticket, body, user)
    await db.commit()
    return _out(quote)


@router.put("/quotes/{quote_id}", response_model=QuoteOut)
async def update_quote(
    quote_id: uuid.UUID, body: QuoteIn, db: DB, user: TicketManagerUser
) -> QuoteOut:
    quote = await svc.get(db, quote_id)
    await _ensure_not_cancelled(db, quote.ticket_id)
    quote = await svc.update(db, quote, body, user)
    await db.commit()
    return _out(quote)


@router.post("/quotes/{quote_id}/send", response_model=QuoteSent)
async def send_quote(quote_id: uuid.UUID, db: DB, user: TicketManagerUser) -> QuoteSent:
    """Marca como enviado e devolve o link do cliente (reenviar mantém o mesmo link)."""
    quote = await svc.get(db, quote_id)
    await _ensure_not_cancelled(db, quote.ticket_id)
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


def _overdue() -> ColumnElement[bool]:
    """Enviado e com a validade vencida: já é "vencido", mesmo antes da rotina gravar."""
    return and_(Quote.status == QuoteStatus.SENT, Quote.valid_until < local_today())


def _status_condition(wanted: QuoteStatus) -> ColumnElement[bool]:
    if wanted == QuoteStatus.SENT:
        return and_(Quote.status == QuoteStatus.SENT, ~_overdue())
    if wanted == QuoteStatus.EXPIRED:
        return or_(Quote.status == QuoteStatus.EXPIRED, _overdue())
    return Quote.status == wanted


def _search(q: str | None) -> ColumnElement[bool] | None:
    """Código do orçamento ou da OS ("ORC-000123", "OS 123"), título, cliente ou loja."""
    if not q or not q.strip():
        return None
    options: list[Any] = []
    code = _CODE.match(q.strip())
    if code:
        number, prefix = int(code.group("number")), (code.group("prefix") or "").lower()
        if prefix != "os":
            options.append(Quote.number == number)
        if prefix != "orc":
            options.append(Ticket.number == number)
    words = search.all_words(q, [Quote.title, Ticket.title, Customer.name, Location.name])
    if words is not None:
        options.append(words)
    return or_(*options) if options else None


def _list_conditions(
    start: datetime | None,
    end: datetime | None,
    customer_id: uuid.UUID | None,
    q: str | None,
) -> list[Any]:
    conds: list[Any] = []
    if start is not None:
        conds.append(Quote.created_at >= start)
    if end is not None:
        conds.append(Quote.created_at < end)
    if customer_id is not None:
        conds.append(Ticket.customer_id == customer_id)
    matched = _search(q)
    if matched is not None:
        conds.append(matched)
    return conds


def _joined(stmt: Any) -> Any:
    return (
        stmt.join(Ticket, Ticket.id == Quote.ticket_id)
        .outerjoin(Customer, Customer.id == Ticket.customer_id)
        .outerjoin(Location, Location.id == Ticket.location_id)
    )


@router.get("/quotes", response_model=list[QuoteListRow])
async def list_quotes(
    db: DB,
    _: TicketManagerUser,
    response: Response,
    start: datetime | None = None,
    end: datetime | None = None,
    status_: Annotated[QuoteStatus | None, Query(alias="status")] = None,
    customer_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=2000)] = 500,
) -> list[QuoteListRow]:
    """Orçamentos (mais novos primeiro). Os filtros valem no banco, antes do limite; o total que
    bate com eles vai no cabeçalho X-Total-Count."""
    conds = _list_conditions(start, end, customer_id, q)
    if status_ is not None:
        conds.append(_status_condition(status_))
    total = await db.scalar(_joined(select(func.count()).select_from(Quote)).where(*conds))
    response.headers["X-Total-Count"] = str(total or 0)
    # Só as colunas da OS que a lista mostra (a OS inteira traria as ~19 relações dela).
    stmt = _joined(select(Quote, Ticket.number, Customer.name, Location.name)).where(*conds)
    rows = (await db.execute(stmt.order_by(Quote.created_at.desc()).limit(limit))).all()
    out = []
    for quote, ticket_number, customer, location in rows:
        svc.refresh_expiry(quote)
        out.append(
            QuoteListRow(
                **_out(quote).model_dump(exclude={"code"}),
                ticket_code=format_ticket_code(ticket_number),
                customer=customer,
                location=location,
            )
        )
    await db.commit()  # grava os que venceram
    return out


@router.get("/quotes/summary", response_model=QuoteSummary)
async def quotes_summary(
    db: DB,
    _: TicketManagerUser,
    start: datetime | None = None,
    end: datetime | None = None,
    customer_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> QuoteSummary:
    """Quantidade e valor por situação, somados no banco sobre todos os orçamentos do filtro
    (os totais do topo da tela não dependem do limite da lista)."""
    conds = _list_conditions(start, end, customer_id, q)
    by_status = {s.value: QuoteStatusTotal() for s in QuoteStatus}
    rows = await db.execute(
        _joined(select(Quote.status, func.count(), func.coalesce(func.sum(Quote.total), 0)))
        .where(*conds)
        .group_by(Quote.status)
    )
    for quote_status, count, total in rows:
        by_status[quote_status.value] = QuoteStatusTotal(count=count, total=Decimal(total))
    # Enviados com a validade vencida contam como vencidos.
    count, total = (
        await db.execute(
            _joined(select(func.count(), func.coalesce(func.sum(Quote.total), 0))).where(
                *conds, _overdue()
            )
        )
    ).one()
    if count:
        sent, expired = by_status[QuoteStatus.SENT.value], by_status[QuoteStatus.EXPIRED.value]
        by_status[QuoteStatus.SENT.value] = QuoteStatusTotal(
            count=sent.count - count, total=sent.total - Decimal(total)
        )
        by_status[QuoteStatus.EXPIRED.value] = QuoteStatusTotal(
            count=expired.count + count, total=expired.total + Decimal(total)
        )
    return QuoteSummary(by_status=by_status)


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
    return stored_file(quote.signature_key)


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
    """IP de quem respondeu, para o registro da aprovação eletrônica. É o que o uvicorn resolveu
    (--proxy-headers só confia no proxy de FORWARDED_ALLOW_IPS): o X-Forwarded-For que o próprio
    cliente escreve não entra. Cabe na coluna (64)."""
    return request.client.host[:64] if request.client else None


async def _lock_for_answer(db: DB, quote: Quote, ticket: Ticket) -> None:
    """Trava a linha do orçamento até o fim da transação e relê: dois cliques (ou aprovar numa
    aba e recusar em outra) não passam juntos; o segundo vê "já respondido"."""
    await db.execute(select(Quote.id).where(Quote.id == quote.id).with_for_update())
    await db.refresh(quote)
    svc.refresh_expiry(quote)
    if await _ticket_status(db, ticket.id) == TicketStatus.CANCELLED:
        raise HTTPException(status.HTTP_409_CONFLICT, TICKET_CANCELLED_PUBLIC)


@public.post("/{token}/approve", response_model=PublicQuote)
async def approve_quote(token: str, body: QuoteApprove, request: Request, db: DB) -> PublicQuote:
    quote, ticket = await _public(db, token)
    await _lock_for_answer(db, quote, ticket)
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
    await _lock_for_answer(db, quote, ticket)
    try:
        await svc.reject(db, quote, body.reason, body.name, _ip(request), comment=body.comment)
    except svc.QuoteNotOpen as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    await commit_and_publish(db)
    await svc.publish_decision(quote, format_ticket_code(ticket.number))
    return await _public_view(db, quote, ticket, str(request.base_url))

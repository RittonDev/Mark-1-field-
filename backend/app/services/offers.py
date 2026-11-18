"""Oferta de OS com preço para os técnicos parceiros.

A central (quem atribui técnico e tem Pagamentos em Editar) manda uma OS sem técnico e em aberto
para 1 a 10 técnicos ativos, com o valor que o técnico recebe, um prazo para responder (opcional) e
um recado. O técnico vê a oferta no app antes de estar na OS, só com o recorte do convite pelo
WhatsApp (serviço, escopo, formulários, bairro e cidade, data e valor; nada de cliente, loja,
endereço, contato, SLA, analista, etiquetas ou projeto), e responde "Aceitar por R$ X" ou "Recusar".
Não existe contraproposta.

- Para aceitar, ele precisa ter aberto a oferta: o detalhe grava `viewed_at` (e o app pede o
  "Escopo lido").
- Quem aceita primeiro leva. O aceite trava a OS, confere a oferta (pendente e no prazo) e a OS (em
  aberto e sem técnico) e faz a atribuição normal (`tickets._assign`, com o técnico como autor e
  `data.via = "offer"`): o status final é o mesmo de quando a central coloca o técnico pela tela.
  Depois dela, o valor da oferta vira o valor do técnico na OS (vence o padrão do tipo de serviço).
  As outras ofertas pendentes da OS fecham como canceladas ("outro técnico aceitou").
- Definir o técnico na mão e cancelar, resolver ou fechar a OS também fecham as pendentes (os
  ganchos ficam em services/tickets.py). Reenviar para quem já tem oferta pendente (ou vencida)
  da OS substitui a anterior.
- Prazo vencido não tem rotina: a pendente com `expires_at` passado tem o estado "expired".
- Não há chat no app: a conversa com o técnico é pelo WhatsApp. Ele fica sabendo pelo tempo real
  (ticket.offer só para ele) e pelo texto que a central cola no grupo dos técnicos.
"""

import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload, selectinload

from app.core.enums import (
    OfferCancelReason,
    OfferStatus,
    PayoutStatus,
    TicketEventType,
    UserRole,
)
from app.db.base import utcnow
from app.models import Ticket, TicketOffer, TicketPayout, User
from app.schemas.common import Ref
from app.schemas.offer import (
    FieldOfferOut,
    FieldOfferTicket,
    OfferCreate,
    OfferForm,
    OfferState,
    TicketOfferOut,
)
from app.schemas.payout import PayoutIn
from app.schemas.ticket import format_ticket_code
from app.services import payouts as payouts_svc
from app.services import tickets as tickets_svc
from app.services.errors import NotFound, OfferError, PermissionDenied, WorkflowError
from app.services.workflow import OPEN_STATUSES

# As ofertas que fecharam e ainda aparecem no app ("outro técnico aceitou", "prazo encerrado").
RECENT_WINDOW = timedelta(hours=24)
MY_OFFERS_LIMIT = 50
# Nota do valor do técnico na OS que veio da oferta (tela de Pagamentos).
OFFER_PAYOUT_NOTE = "Valor da oferta aceita"

NOT_FOUND = "Oferta não encontrada"
CANNOT_OFFER = "Somente analistas e supervisores ofertam a OS"
HAS_TECHNICIAN = "A OS já tem técnico: só dá para ofertar uma OS sem técnico"
NOT_OPEN = "Só dá para ofertar uma OS em aberto (não resolvida, fechada nem cancelada)"
EXPIRES_IN_PAST = "O prazo para responder precisa ser no futuro"
NOT_A_TECHNICIAN = "Técnico não encontrado"
ALREADY_ANSWERED = "O técnico já respondeu esta oferta. Recarregue a OS."

# Erros do aceite e da recusa: (texto, code). O app reage pelo code.
TAKEN = ("Outro técnico já aceitou esta OS.", "OFFER_TAKEN")
EXPIRED = ("O prazo para responder esta oferta acabou.", "OFFER_EXPIRED")
CANCELLED = ("A central cancelou esta oferta.", "OFFER_CANCELLED")
UNAVAILABLE = ("Esta OS não está mais disponível.", "OFFER_UNAVAILABLE")
ANSWERED = ("Você já respondeu esta oferta.", "OFFER_ANSWERED")
NOT_VIEWED = ("Abra a oferta e leia o escopo antes de aceitar.", "OFFER_NOT_VIEWED")

# Oferta cancelada: o erro de quem tenta responder depois.
_CANCELLED_ERRORS: dict[OfferCancelReason, tuple[str, str]] = {
    OfferCancelReason.TAKEN: TAKEN,
    OfferCancelReason.CENTRAL: CANCELLED,
    # Substituída por uma oferta nova da mesma OS: o app busca as ofertas de novo e acha a nova.
    OfferCancelReason.REPLACED: CANCELLED,
    OfferCancelReason.ASSIGNED: UNAVAILABLE,
    OfferCancelReason.TICKET_CLOSED: UNAVAILABLE,
}

_STATES: dict[OfferStatus, OfferState] = {
    OfferStatus.PENDING: "pending",
    OfferStatus.ACCEPTED: "accepted",
    OfferStatus.DECLINED: "declined",
    OfferStatus.CANCELLED: "cancelled",
}


def _error(pair: tuple[str, str], status_code: int = 409) -> OfferError:
    message, code = pair
    return OfferError(message, code=code, status_code=status_code)


def effective_state(offer: TicketOffer, now: datetime) -> OfferState:
    """O estado que a API mostra: a pendente com o prazo passado é "expired" (sem rotina)."""
    if (
        offer.status == OfferStatus.PENDING
        and offer.expires_at is not None
        and offer.expires_at <= now
    ):
        return "expired"
    return _STATES[offer.status]


# --------------------------------------------------------------------------- saída


def offer_out(offer: TicketOffer, now: datetime) -> TicketOfferOut:
    """A oferta para a central (leva o valor: só com Pagamentos)."""
    creator = offer.created_by
    return TicketOfferOut(
        id=offer.id,
        ticket_id=offer.ticket_id,
        technician=Ref(id=offer.technician.id, name=offer.technician.name),
        amount=offer.amount,
        state=effective_state(offer, now),
        expires_at=offer.expires_at,
        note=offer.note,
        decline_reason=offer.decline_reason,
        cancel_reason=offer.cancel_reason,
        viewed_at=offer.viewed_at,
        responded_at=offer.responded_at,
        created_by=Ref(id=creator.id, name=creator.name) if creator is not None else None,
        created_at=offer.created_at,
    )


def _field_ticket(ticket: Ticket, *, full: bool) -> FieldOfferTicket:
    """O recorte da OS para o técnico que ainda não está nela. `full=False` (oferta que já
    fechou): sem escopo, formulários e bairro."""
    store = ticket.location
    service = ticket.service_type
    return FieldOfferTicket(
        id=ticket.id,
        code=format_ticket_code(ticket.number),
        title=ticket.title,
        description=((ticket.description or "").strip() or None) if full else None,
        service_type=Ref(id=service.id, name=service.name) if service is not None else None,
        forms=[OfferForm(name=f.name, required=f.required) for f in ticket.forms] if full else [],
        district=store.district if full and store is not None else None,
        city=store.city if store is not None else None,
        state=store.state if store is not None else None,
        scheduled_start=ticket.scheduled_start,
        scheduled_end=ticket.scheduled_end,
    )


def field_out(offer: TicketOffer, ticket: Ticket, now: datetime) -> FieldOfferOut:
    """A oferta no app do técnico."""
    state = effective_state(offer, now)
    return FieldOfferOut(
        id=offer.id,
        state=state,
        amount=offer.amount,
        expires_at=offer.expires_at,
        note=offer.note,
        viewed_at=offer.viewed_at,
        responded_at=offer.responded_at,
        created_at=offer.created_at,
        ticket=_field_ticket(ticket, full=state == "pending"),
    )


async def ticket_offers(db: AsyncSession, ticket_id: uuid.UUID) -> list[TicketOfferOut]:
    """As ofertas da OS para a central, a mais nova primeiro (as de um mesmo envio, pelo nome)."""
    offers = await db.scalars(
        select(TicketOffer)
        .join(User, User.id == TicketOffer.technician_id)
        .where(TicketOffer.ticket_id == ticket_id)
        .order_by(TicketOffer.created_at.desc(), User.name, TicketOffer.id)
        .execution_options(populate_existing=True)
    )
    now = utcnow()
    return [offer_out(offer, now) for offer in offers]


async def offers_by_id(db: AsyncSession, ids: list[uuid.UUID]) -> list[TicketOfferOut]:
    """As ofertas relidas do banco (depois do commit), na ordem dada."""
    found = {
        offer.id: offer
        for offer in await db.scalars(
            select(TicketOffer)
            .where(TicketOffer.id.in_(ids))
            .execution_options(populate_existing=True)
        )
    }
    now = utcnow()
    return [offer_out(found[i], now) for i in ids if i in found]


# --------------------------------------------------------------------------- central


async def _locked_ticket(db: AsyncSession, ticket_id: uuid.UUID) -> Ticket:
    """A OS relida e travada até o fim da transação: as ofertas de uma OS (envio, cancelamento,
    aceite, recusa) passam uma de cada vez, e o primeiro aceite é o que vale."""
    ticket = await db.scalar(
        select(Ticket)
        .where(Ticket.id == ticket_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if ticket is None:
        raise NotFound("OS não encontrada")
    return ticket


async def _technicians(db: AsyncSession, ticket: Ticket, ids: list[uuid.UUID]) -> list[User]:
    """Os técnicos da oferta, sem repetir: técnicos de campo ativos (o inativo não entra no app)
    e que ainda não estão na OS."""
    wanted = list(dict.fromkeys(ids))
    found = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(wanted)))}
    helpers = {h.id for h in ticket.helpers}
    out: list[User] = []
    for user_id in wanted:
        user = found.get(user_id)
        if user is None:
            raise WorkflowError(NOT_A_TECHNICIAN)
        if user.role != UserRole.TECHNICIAN:
            raise WorkflowError(f"{user.name} não é técnico de campo")
        if not user.is_active:
            raise WorkflowError(
                f"{user.name} está sem acesso ao app: libere o acesso em Técnicos antes de ofertar"
            )
        if user.id in helpers:
            raise WorkflowError(f"{user.name} já está na OS")
        out.append(user)
    return out


async def send(
    db: AsyncSession, ticket: Ticket, data: OfferCreate, actor: User
) -> list[TicketOffer]:
    """Manda a OS (sem técnico, em aberto) para os técnicos, com o valor, o prazo e o recado.
    Quem já tinha oferta pendente (ou vencida) desta OS recebe a nova no lugar da anterior (a
    antiga fica cancelada como "replaced", sem evento próprio: o envio cita a troca)."""
    if not tickets_svc.can_assign(actor, ticket):
        raise PermissionDenied(CANNOT_OFFER)
    ticket = await _locked_ticket(db, ticket.id)
    if ticket.assignee_id is not None:
        raise WorkflowError(HAS_TECHNICIAN)
    if ticket.status not in OPEN_STATUSES:
        raise WorkflowError(NOT_OPEN)
    now = utcnow()
    if data.expires_at is not None and data.expires_at <= now:
        raise WorkflowError(EXPIRES_IN_PAST)
    technicians = await _technicians(db, ticket, data.technician_ids)
    ids = [t.id for t in technicians]

    previous = list(
        await db.scalars(
            select(TicketOffer)
            .where(
                TicketOffer.ticket_id == ticket.id,
                TicketOffer.technician_id.in_(ids),
                TicketOffer.status == OfferStatus.PENDING,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    for old in previous:
        old.status = OfferStatus.CANCELLED
        old.cancel_reason = OfferCancelReason.REPLACED
        old.updated_at = now
    if previous:
        # A anterior sai de "pendente" antes de a nova entrar (índice único parcial).
        await db.flush()

    amount = data.amount.quantize(Decimal("0.01"))
    offers = [
        TicketOffer(
            id=uuid.uuid4(),
            ticket_id=ticket.id,
            technician_id=technician.id,
            technician=technician,
            amount=amount,
            status=OfferStatus.PENDING,
            expires_at=data.expires_at,
            note=data.note,
            created_by_id=actor.id,
            created_by=actor,
            created_at=now,
            updated_at=now,
        )
        for technician in technicians
    ]
    db.add_all(offers)
    event_data: dict[str, object] = {
        "amount": payouts_svc.money_text(amount),
        "expires_at": data.expires_at.isoformat() if data.expires_at else None,
        "offers": [
            {"id": str(o.id), "technician_id": str(o.technician_id), "technician": o.technician.name}
            for o in offers
        ],
    }
    if previous:
        event_data["replaced"] = [old.technician.name for old in previous]
    tickets_svc.record_event(
        db,
        ticket,
        actor,
        TicketEventType.OFFER_SENT,
        to_value=str(amount),
        note=data.note,
        data=event_data,
        now=now,
    )
    tickets_svc.queue_offer_events(
        db,
        ticket,
        actor,
        "sent",
        ids,
        technician_name=technicians[0].name if len(technicians) == 1 else None,
    )
    await db.flush()
    return offers


async def cancel(
    db: AsyncSession, ticket: Ticket, offer_id: uuid.UUID, actor: User
) -> TicketOffer:
    """A central cancela uma oferta pendente (também a vencida). Já cancelada: devolve como está;
    já respondida pelo técnico: 422."""
    ticket = await _locked_ticket(db, ticket.id)
    offer = await db.scalar(
        select(TicketOffer)
        .where(TicketOffer.id == offer_id, TicketOffer.ticket_id == ticket.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if offer is None:
        raise NotFound(NOT_FOUND)
    if offer.status == OfferStatus.CANCELLED:
        return offer
    if offer.status != OfferStatus.PENDING:
        raise WorkflowError(ALREADY_ANSWERED)
    tickets_svc.cancel_offers(
        db, ticket, [offer], actor, reason=OfferCancelReason.CENTRAL, now=utcnow()
    )
    await db.flush()
    return offer


# --------------------------------------------------------------------------- técnico


async def _own_offer(db: AsyncSession, offer_id: uuid.UUID, technician: User) -> TicketOffer:
    """A oferta, se é do técnico (a de outro: 404, como se não existisse)."""
    offer = await db.scalar(
        select(TicketOffer)
        .where(TicketOffer.id == offer_id, TicketOffer.technician_id == technician.id)
        .execution_options(populate_existing=True)
    )
    if offer is None:
        raise NotFound(NOT_FOUND)
    return offer


async def _field_tickets(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, Ticket]:
    """As OS das ofertas só com o que o recorte usa (loja, tipo de serviço e formulários)."""
    if not ids:
        return {}
    rows = await db.scalars(
        select(Ticket)
        .options(
            noload("*"),
            selectinload(Ticket.location),
            selectinload(Ticket.service_type),
            selectinload(Ticket.forms),
        )
        .where(Ticket.id.in_(ids))
    )
    return {t.id: t for t in rows}


async def my_offers(db: AsyncSession, technician: User) -> list[FieldOfferOut]:
    """As ofertas do técnico: as pendentes no prazo e as que fecharam nas últimas 24 h (para o app
    dizer "outro técnico aceitou", "prazo encerrado"...), a mais nova primeiro, até 50. A
    substituída por uma oferta nova da mesma OS não aparece (a nova aparece)."""
    now = utcnow()
    since = now - RECENT_WINDOW
    offers = list(
        await db.scalars(
            select(TicketOffer)
            .options(noload(TicketOffer.technician), noload(TicketOffer.created_by))
            .where(
                TicketOffer.technician_id == technician.id,
                TicketOffer.cancel_reason.is_distinct_from(OfferCancelReason.REPLACED),
                or_(
                    and_(
                        TicketOffer.status == OfferStatus.PENDING,
                        or_(TicketOffer.expires_at.is_(None), TicketOffer.expires_at > since),
                    ),
                    and_(
                        TicketOffer.status != OfferStatus.PENDING,
                        TicketOffer.updated_at > since,
                    ),
                ),
            )
            .order_by(TicketOffer.created_at.desc(), TicketOffer.id)
            .limit(MY_OFFERS_LIMIT)
        )
    )
    tickets = await _field_tickets(db, {o.ticket_id for o in offers})
    return [field_out(o, tickets[o.ticket_id], now) for o in offers if o.ticket_id in tickets]


async def field_offer(db: AsyncSession, offer_id: uuid.UUID, technician: User) -> FieldOfferOut:
    """Uma oferta do técnico, relida do banco."""
    offer = await _own_offer(db, offer_id, technician)
    ticket = await tickets_svc.get_ticket(db, offer.ticket_id)
    return field_out(offer, ticket, utcnow())


async def mark_viewed(db: AsyncSession, offer_id: uuid.UUID, technician: User) -> TicketOffer:
    """O técnico abriu a oferta: grava `viewed_at` na primeira vez (só a pendente no prazo) e a
    central vê na hora. Sem isso o aceite é recusado (OFFER_NOT_VIEWED)."""
    offer = await _own_offer(db, offer_id, technician)
    now = utcnow()
    if offer.viewed_at is not None or effective_state(offer, now) != "pending":
        return offer
    # Uma vez só, mesmo com dois aparelhos abrindo juntos.
    done = await db.execute(
        update(TicketOffer)
        .where(
            TicketOffer.id == offer.id,
            TicketOffer.viewed_at.is_(None),
            TicketOffer.status == OfferStatus.PENDING,
        )
        .values(viewed_at=now)
        .execution_options(synchronize_session=False)
    )
    if done.rowcount:
        ticket = await tickets_svc.get_ticket(db, offer.ticket_id)
        tickets_svc.queue_offer_events(
            db, ticket, technician, "viewed", [], technician_name=technician.name
        )
    return offer


def _check_answerable(offer: TicketOffer, ticket: Ticket, now: datetime) -> None:
    """A oferta pendente ainda pode ser respondida? Cancelada, vencida ou com a OS fora do ar
    (encerrada ou já com técnico): 409 com o code de cada caso."""
    if offer.status == OfferStatus.CANCELLED:
        reason = offer.cancel_reason
        raise _error(_CANCELLED_ERRORS.get(reason, UNAVAILABLE) if reason else UNAVAILABLE)
    if offer.expires_at is not None and offer.expires_at <= now:
        raise _error(EXPIRED)
    if ticket.status not in OPEN_STATUSES or ticket.assignee_id is not None:
        raise _error(UNAVAILABLE)


async def _set_offer_payout(
    db: AsyncSession, ticket: Ticket, offer: TicketOffer, technician: User
) -> None:
    """O valor da oferta vira o valor do técnico na OS, depois da atribuição: vence o padrão do
    tipo de serviço (ou o valor transferido). Autor: quem mandou a oferta (sem ele, o técnico).
    Valor dele já pago nesta OS (ele foi o técnico dela antes) não muda: a central acerta."""
    paid = await db.scalar(
        select(TicketPayout.id).where(
            TicketPayout.ticket_id == ticket.id,
            TicketPayout.technician_id == technician.id,
            TicketPayout.status == PayoutStatus.PAID,
        )
    )
    if paid is not None:
        return
    creator = await db.get(User, offer.created_by_id) if offer.created_by_id else None
    await payouts_svc.set_payout(
        db,
        ticket,
        technician.id,
        PayoutIn(amount=offer.amount, note=OFFER_PAYOUT_NOTE),
        creator or technician,
    )


async def accept(db: AsyncSession, offer_id: uuid.UUID, technician: User) -> Ticket:
    """ "Aceitar por R$ X": quem aceita primeiro fica com a OS (ver o docstring do módulo).

    409 OFFER_TAKEN (outro técnico aceitou), OFFER_EXPIRED, OFFER_CANCELLED (a central cancelou ou
    trocou a oferta), OFFER_UNAVAILABLE (a OS foi encerrada ou já tem técnico), OFFER_ANSWERED (ele
    recusou); 422 OFFER_NOT_VIEWED (não abriu a oferta). Aceite repetido da oferta que já é dele:
    devolve a OS como está."""
    offer = await _own_offer(db, offer_id, technician)
    ticket = await _locked_ticket(db, offer.ticket_id)
    # Relida com a OS travada: o aceite que chegou antes já gravou o que fez.
    await db.refresh(offer, with_for_update=True)
    now = utcnow()
    if offer.status == OfferStatus.ACCEPTED:
        if ticket.assignee_id == technician.id:
            return ticket
        raise _error(UNAVAILABLE)
    if offer.status == OfferStatus.DECLINED:
        raise _error(ANSWERED)
    _check_answerable(offer, ticket, now)
    if offer.viewed_at is None:
        raise _error(NOT_VIEWED, status_code=422)

    offer.status = OfferStatus.ACCEPTED
    offer.responded_at = now
    offer.updated_at = now
    tickets_svc.record_event(
        db,
        ticket,
        technician,
        TicketEventType.OFFER_ACCEPTED,
        to_value=str(offer.amount),
        data={
            "offer_id": str(offer.id),
            "technician_id": str(technician.id),
            "technician": technician.name,
            "amount": payouts_svc.money_text(offer.amount),
        },
        now=now,
    )
    others = list(
        await db.scalars(
            select(TicketOffer)
            .where(
                TicketOffer.ticket_id == ticket.id,
                TicketOffer.id != offer.id,
                tickets_svc.offer_live_clause(now),
            )
            .order_by(TicketOffer.created_at)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    tickets_svc.cancel_offers(db, ticket, others, None, reason=OfferCancelReason.TAKEN, now=now)
    # Gravado antes da atribuição: o gancho dela não acha mais ofertas pendentes para fechar.
    await db.flush()
    await tickets_svc._assign(
        db, ticket, technician.id, None, technician, now=now, note="Aceitou a oferta", via="offer"
    )
    await _set_offer_payout(db, ticket, offer, technician)
    tickets_svc.queue_offer_events(
        db, ticket, technician, "accepted", [technician.id], technician_name=technician.name
    )
    await db.flush()
    return ticket


async def decline(
    db: AsyncSession, offer_id: uuid.UUID, technician: User, reason: str | None
) -> TicketOffer:
    """ "Recusar" (motivo opcional). Recusa repetida: devolve como está. Os erros são os do
    aceite (a aceita: 409 OFFER_ANSWERED)."""
    offer = await _own_offer(db, offer_id, technician)
    ticket = await _locked_ticket(db, offer.ticket_id)
    await db.refresh(offer, with_for_update=True)
    now = utcnow()
    if offer.status == OfferStatus.DECLINED:
        return offer
    if offer.status == OfferStatus.ACCEPTED:
        raise _error(ANSWERED)
    _check_answerable(offer, ticket, now)
    text = (reason or "").strip() or None
    offer.status = OfferStatus.DECLINED
    offer.decline_reason = text
    offer.responded_at = now
    offer.updated_at = now
    tickets_svc.record_event(
        db,
        ticket,
        technician,
        TicketEventType.OFFER_DECLINED,
        to_value=str(offer.amount),
        note=text,
        data={
            "offer_id": str(offer.id),
            "technician_id": str(technician.id),
            "technician": technician.name,
            "amount": payouts_svc.money_text(offer.amount),
        },
        now=now,
    )
    tickets_svc.queue_offer_events(
        db,
        ticket,
        technician,
        "declined",
        [technician.id],
        technician_name=technician.name,
        reason=text,
    )
    await db.flush()
    return offer

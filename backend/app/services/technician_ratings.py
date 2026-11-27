"""Avaliação do cliente sobre um técnico numa OS concluída (contrato da Entrega 2, §6.5).

Até o módulo de OS ter o formulário do cliente, a central registra na OS concluída (resolvida ou
fechada) a avaliação que o cliente fez de cada técnico dela: o responsável ou um auxiliar (quem saiu
da OS e já tem avaliação ainda é corrigido ou excluído, não avaliado de novo). Uma por OS e técnico,
nota inteira de 1 a 5, comentário e quem avaliou no cliente. Corrigir grava quem corrigiu
(`updated_by`); a mesma avaliação de novo não muda nada.

Só a gestão vê: nada no app nem em /me/*, fora do Elo e do relatório do cliente. O rastro fica no
histórico da OS (eventos rating_set e rating_removed, só da gestão: `managers_only` e nos tipos
internos da rota de eventos) e no histórico do cadastro do técnico (campo `ratings`, via central),
com o aviso `profile.changed` da gestão. A OS reaberta mantém as avaliações; mexer nelas pede a OS
concluída de novo.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import text as text_utils
from app.core.enums import RatingSource, TicketEventType, UserRole
from app.db.base import utcnow
from app.models import Location, Ticket, TicketEvent, User
from app.models.technician_rating import TechnicianRating
from app.models.user_change import VIA_CENTRAL
from app.schemas.common import Ref
from app.schemas.technician_rating import (
    SCORE_MAX,
    RatingIn,
    RatingTicketOut,
    TechnicianRatingOut,
    TechnicianRatingsOut,
    TicketRatingLine,
    TicketRatingRole,
    TicketRatingsOut,
)
from app.schemas.ticket import format_ticket_code
from app.services import user_history
from app.services.errors import CodedError
from app.services.payouts import CONCLUDED
from app.services.realtime import queue_event

# GET /technicians/{id}/ratings: a página (a ficha pede 20 por vez).
PAGE_DEFAULT = 20
PAGE_MAX = 100

NOT_CONCLUDED = "Só a OS concluída recebe avaliação"
NOT_IN_TICKET = "Este técnico não está nesta OS"
NOT_FOUND = "Avaliação não encontrada"

# O campo do histórico do cadastro.
HISTORY_FIELD = "ratings"
_TENTH = Decimal("0.1")


# --------------------------------------------------------------------------- números e textos


def _mean(total: int, count: int) -> float | None:
    """A média com uma casa, arredondada para cima no meio (4,25 → 4,3). Sem avaliação: None."""
    if count <= 0:
        return None
    return float((Decimal(total) / Decimal(count)).quantize(_TENTH, rounding=ROUND_HALF_UP))


def average(scores: Iterable[int]) -> float | None:
    """A média das notas com uma casa (ROUND_HALF_UP: [4, 5, 4, 4] → 4.3). Nenhuma: None."""
    values = [int(score) for score in scores]
    return _mean(sum(values), len(values))


def score_text(score: int) -> str:
    """ "4 de 5": a nota como o histórico da OS e o do cadastro mostram."""
    return f"{score} de {SCORE_MAX}"


def _ref(user: User | None) -> Ref | None:
    return Ref(id=user.id, name=user.name) if user is not None else None


def ticket_out(ticket: Ticket) -> RatingTicketOut:
    return RatingTicketOut(
        id=ticket.id,
        code=format_ticket_code(ticket.number),
        title=ticket.title,
        location=ticket.location.name if ticket.location is not None else None,
        resolved_at=ticket.resolved_at,
    )


def rating_out(rating: TechnicianRating, ticket: RatingTicketOut) -> TechnicianRatingOut:
    """A avaliação lida do banco (as relações carregadas: `get` ou as consultas daqui)."""
    return TechnicianRatingOut(
        id=rating.id,
        ticket=ticket,
        technician=Ref(id=rating.technician.id, name=rating.technician.name),
        score=rating.score,
        comment=rating.comment,
        rater_name=rating.rater_name,
        source=rating.source,
        created_at=rating.created_at,
        created_by=_ref(rating.created_by),
        updated_at=rating.updated_at,
        updated_by=_ref(rating.updated_by),
    )


# --------------------------------------------------------------------------- leituras


async def summaries(
    db: AsyncSession, user_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[float | None, int]]:
    """(média com 1 casa, quantas) de cada técnico pedido, de todas as avaliações dele; quem não tem
    avaliação vem (None, 0). Uma consulta; nenhuma sem ids."""
    ids = list(dict.fromkeys(user_ids))
    out: dict[uuid.UUID, tuple[float | None, int]] = dict.fromkeys(ids, (None, 0))
    if not ids:
        return out
    rows = await db.execute(
        select(
            TechnicianRating.technician_id,
            func.sum(TechnicianRating.score),
            func.count(),
        )
        .where(TechnicianRating.technician_id.in_(ids))
        .group_by(TechnicianRating.technician_id)
    )
    for technician_id, total, count in rows:
        out[technician_id] = (_mean(int(total or 0), int(count)), int(count))
    return out


async def get(db: AsyncSession, rating_id: uuid.UUID) -> TechnicianRating | None:
    """A avaliação relida do banco (com quem avaliou, registrou e corrigiu)."""
    return await db.scalar(
        select(TechnicianRating)
        .where(TechnicianRating.id == rating_id)
        .execution_options(populate_existing=True)
    )


async def _find(
    db: AsyncSession, ticket_id: uuid.UUID, technician_id: uuid.UUID
) -> TechnicianRating | None:
    return await db.scalar(
        select(TechnicianRating)
        .where(
            TechnicianRating.ticket_id == ticket_id,
            TechnicianRating.technician_id == technician_id,
        )
        .execution_options(populate_existing=True)
    )


def _current(ticket: Ticket) -> list[tuple[User, TicketRatingRole]]:
    """Os técnicos da OS agora: o responsável e os auxiliares (em ordem do nome), só papel técnico
    (o analista que assumiu a OS não é avaliado aqui)."""
    out: list[tuple[User, TicketRatingRole]] = []
    seen: set[uuid.UUID] = set()
    assignee = ticket.assignee
    if assignee is not None and assignee.role == UserRole.TECHNICIAN:
        out.append((assignee, "assignee"))
        seen.add(assignee.id)
    for helper in ticket.helpers:
        if helper.role == UserRole.TECHNICIAN and helper.id not in seen:
            out.append((helper, "helper"))
            seen.add(helper.id)
    return out


async def ticket_ratings(db: AsyncSession, ticket: Ticket) -> TicketRatingsOut:
    """O responsável, os auxiliares e quem saiu da OS com avaliação (por nome), cada um com a
    avaliação dele."""
    rows = await db.scalars(
        select(TechnicianRating)
        .where(TechnicianRating.ticket_id == ticket.id)
        .execution_options(populate_existing=True)
    )
    by_technician = {rating.technician_id: rating for rating in rows}
    ref = ticket_out(ticket)
    lines: list[TicketRatingLine] = []
    for user, role in _current(ticket):
        rating = by_technician.pop(user.id, None)
        lines.append(
            TicketRatingLine(
                technician=Ref(id=user.id, name=user.name),
                role=role,
                rating=rating_out(rating, ref) if rating is not None else None,
            )
        )
    former = sorted(
        by_technician.values(),
        key=lambda r: (text_utils.fold(r.technician.name), str(r.technician_id)),
    )
    for rating in former:
        lines.append(
            TicketRatingLine(
                technician=Ref(id=rating.technician.id, name=rating.technician.name),
                role="former",
                rating=rating_out(rating, ref),
            )
        )
    return TicketRatingsOut(concluded=ticket.status in CONCLUDED, technicians=lines)


async def rating_of(db: AsyncSession, rating_id: uuid.UUID, ticket: Ticket) -> TechnicianRatingOut:
    """A resposta do PUT: a avaliação relida depois do commit."""
    rating = await get(db, rating_id)
    if rating is None:  # excluída por outra pessoa entre o commit e a leitura
        raise CodedError(NOT_FOUND, "RATING_NOT_FOUND", 404)
    return rating_out(rating, ticket_out(ticket))


async def for_technician(
    db: AsyncSession, user_id: uuid.UUID, limit: int = PAGE_DEFAULT, offset: int = 0
) -> TechnicianRatingsOut:
    """A média (1 casa) e a contagem de todas as avaliações do técnico e a página pedida, a mais
    nova primeiro."""
    total, count = (
        await db.execute(
            select(func.coalesce(func.sum(TechnicianRating.score), 0), func.count()).where(
                TechnicianRating.technician_id == user_id
            )
        )
    ).one()
    rows = await db.execute(
        select(
            TechnicianRating,
            Ticket.id,
            Ticket.number,
            Ticket.title,
            Ticket.resolved_at,
            Location.name,
        )
        .join(Ticket, Ticket.id == TechnicianRating.ticket_id)
        .outerjoin(Location, Location.id == Ticket.location_id)
        .where(TechnicianRating.technician_id == user_id)
        .order_by(TechnicianRating.created_at.desc(), TechnicianRating.id.desc())
        .offset(offset)
        .limit(limit)
        .execution_options(populate_existing=True)
    )
    items = [
        rating_out(
            rating,
            RatingTicketOut(
                id=ticket_id,
                code=format_ticket_code(number),
                title=title,
                location=location,
                resolved_at=resolved_at,
            ),
        )
        for rating, ticket_id, number, title, resolved_at, location in rows
    ]
    return TechnicianRatingsOut(
        average=_mean(int(total or 0), int(count)), count=int(count), items=items
    )


# --------------------------------------------------------------------------- gravação


@dataclass
class RatingChange:
    """O que a gravação fez: a avaliação (None na exclusão), o técnico dela e as mudanças do
    histórico do cadastro (vazio: nada mudou; a rota só avisa com mudança)."""

    rating: TechnicianRating | None
    technician: User
    changes: list[dict[str, Any]]


def _ensure_concluded(ticket: Ticket) -> None:
    if ticket.status not in CONCLUDED:
        raise CodedError(NOT_CONCLUDED, "RATING_NOT_CONCLUDED", 409)


async def _lock(db: AsyncSession, ticket_id: uuid.UUID, technician_id: uuid.UUID) -> None:
    """Uma gravação por vez da avaliação de cada técnico na OS, até o fim da transação: dois pedidos
    juntos dão um registro só (o segundo lê o primeiro e corrige ou vê que é igual)."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"technician-rating:{ticket_id}:{technician_id}"},
    )


def _event(
    db: AsyncSession,
    ticket: Ticket,
    actor: User,
    event_type: TicketEventType,
    technician: User,
    *,
    from_value: str | None = None,
    to_value: str | None = None,
    note: str | None = None,
) -> None:
    """Histórico da OS (só a gestão: nos tipos internos da rota de eventos) e o aviso em tempo real
    só para a gestão (sem push e sem ir ao técnico)."""
    db.add(
        TicketEvent(
            ticket_id=ticket.id,
            actor_id=actor.id,
            event_type=event_type,
            from_value=from_value,
            to_value=to_value,
            note=note,
            data={"technician_id": str(technician.id), "technician_name": technician.name},
            created_at=utcnow(),
        )
    )
    queue_event(
        db, "updated", ticket, actor, {"fields": ["ratings"]}, internal=True, managers_only=True
    )


async def rate(
    db: AsyncSession, ticket: Ticket, technician_id: uuid.UUID, data: RatingIn, actor: User
) -> RatingChange:
    """Registra ou corrige (PUT). A OS precisa estar concluída (409 RATING_NOT_CONCLUDED); registrar
    pede o técnico na OS agora, responsável ou auxiliar (422 RATING_NOT_IN_TICKET); quem saiu e tem
    avaliação corrige. Igual ao gravado: nada muda (sem evento nem histórico)."""
    _ensure_concluded(ticket)
    await _lock(db, ticket.id, technician_id)
    rating = await _find(db, ticket.id, technician_id)
    code = format_ticket_code(ticket.number)
    before: str | None = None
    if rating is None:
        technician = next((u for u, _ in _current(ticket) if u.id == technician_id), None)
        if technician is None:
            raise CodedError(NOT_IN_TICKET, "RATING_NOT_IN_TICKET", 422)
        rating = TechnicianRating(
            id=uuid.uuid4(),
            ticket_id=ticket.id,
            technician_id=technician.id,
            score=data.score,
            comment=data.comment,
            rater_name=data.rater_name,
            source=RatingSource.CENTRAL,
            created_by_id=actor.id,
            updated_by_id=None,
        )
        db.add(rating)
        phrase = f"registrou {code}: {score_text(data.score)}"
    else:
        technician = rating.technician
        same = (rating.score, rating.comment, rating.rater_name) == (
            data.score,
            data.comment,
            data.rater_name,
        )
        if same:
            return RatingChange(rating=rating, technician=technician, changes=[])
        before = score_text(rating.score)
        if rating.score != data.score:
            phrase = f"corrigiu {code}: {rating.score} → {score_text(data.score)}"
        else:
            phrase = f"corrigiu {code}"
        rating.score = data.score
        rating.comment = data.comment
        rating.rater_name = data.rater_name
        rating.source = RatingSource.CENTRAL
        rating.updated_by_id = actor.id
    _event(
        db,
        ticket,
        actor,
        TicketEventType.RATING_SET,
        technician,
        from_value=before,
        to_value=score_text(data.score),
        note=data.comment,
    )
    changes = [{"field": HISTORY_FIELD, "from": None, "to": phrase}]
    user_history.record(db, technician, changes, via=VIA_CENTRAL, actor=actor)
    await db.flush()
    return RatingChange(rating=rating, technician=technician, changes=changes)


async def remove(
    db: AsyncSession, ticket: Ticket, technician_id: uuid.UUID, actor: User
) -> RatingChange:
    """Exclui (DELETE) com a OS concluída (409 RATING_NOT_CONCLUDED); sem avaliação, 404
    RATING_NOT_FOUND."""
    _ensure_concluded(ticket)
    await _lock(db, ticket.id, technician_id)
    rating = await _find(db, ticket.id, technician_id)
    if rating is None:
        raise CodedError(NOT_FOUND, "RATING_NOT_FOUND", 404)
    technician = rating.technician
    await db.delete(rating)
    _event(
        db,
        ticket,
        actor,
        TicketEventType.RATING_REMOVED,
        technician,
        from_value=score_text(rating.score),
    )
    code = format_ticket_code(ticket.number)
    changes = [{"field": HISTORY_FIELD, "from": None, "to": f"excluiu a avaliação de {code}"}]
    user_history.record(db, technician, changes, via=VIA_CENTRAL, actor=actor)
    await db.flush()
    return RatingChange(rating=None, technician=technician, changes=changes)

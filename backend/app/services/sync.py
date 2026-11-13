"""Sincronização offline-first do app do técnico.

pull: delta por `updated_at` desde o último `server_time` recebido.
push: lote de operações feitas offline, idempotentes por `client_op_id`;
cada operação roda num SAVEPOINT, então uma rejeitada não derruba as outras.
"""

import contextlib
import logging
import uuid
from datetime import datetime, timedelta

from pydantic import ValidationError
from sqlalchemy import and_, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from app.core.enums import TicketEventType, UserRole
from app.db.base import utcnow
from app.models import SyncOperation, Ticket, TicketComment, TicketEvent, TicketWorklog, User
from app.schemas.forms import TicketFormAnswers
from app.schemas.part_request import PartRequestIn
from app.schemas.sync import (
    SyncOperationIn,
    SyncOperationResult,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
)
from app.schemas.ticket import (
    CommentCreate,
    CommentOut,
    TicketDetail,
    TicketTransition,
    TicketUnproductive,
    TicketUpdate,
    WorklogCreate,
    WorklogOut,
)
from app.services import forms, parts, schedule, validation_messages
from app.services import tickets as svc
from app.services.errors import (
    DomainError,
    NotFound,
    PermissionDenied,
    VersionConflict,
    WorkflowError,
)
from app.services.realtime import commit_and_publish, discard_pending, pending_count
from app.services.workflow import OPEN_STATUSES

log = logging.getLogger(__name__)

PULL_LIMIT = 500
# Muitas OS com o mesmo `updated_at` (atualização em massa): a página leva todas as desse
# instante, até este teto, senão o cursor não sai do lugar.
SAME_INSTANT_LIMIT = 5000
# Margem para transações que gravaram antes do corte mas confirmaram depois.
CLOCK_SKEW = timedelta(seconds=10)
INITIAL_WINDOW = timedelta(days=7)
UNEXPECTED = "Não foi possível aplicar esta operação. Avise a central."


async def pull(db: AsyncSession, user: User, since: datetime | None) -> SyncPullResponse:
    started = utcnow()
    conds = []
    vis = svc.visibility_clause(user)
    if vis is not None:
        conds.append(vis)
    if since is not None:
        conds.append(Ticket.updated_at > since)
    else:
        conds.append(
            or_(Ticket.status.in_(OPEN_STATUSES), Ticket.updated_at > started - INITIAL_WINDOW)
        )
    tickets = list(
        await db.scalars(
            select(Ticket)
            .where(*conds)
            .order_by(Ticket.updated_at, Ticket.id)
            .limit(PULL_LIMIT + 1)
        )
    )
    has_more = len(tickets) > PULL_LIMIT
    tickets = tickets[:PULL_LIMIT]
    cursor = started - CLOCK_SKEW
    if has_more:
        last = tickets[-1].updated_at
        if tickets[0].updated_at == last:
            # A página inteira é do mesmo instante: leva todas as OS dele e o próximo pedido
            # começa depois (com o "último - 1 µs" a mesma página voltaria para sempre).
            tickets = list(
                await db.scalars(
                    select(Ticket)
                    .where(*conds, Ticket.updated_at == last)
                    .order_by(Ticket.id)
                    .limit(SAME_INSTANT_LIMIT)
                )
            )
            cursor = last
        else:
            # Recomeça no instante da última OS: as do mesmo instante que ficaram de fora vêm
            # na próxima página (as já enviadas vêm de novo, sem problema para o app).
            cursor = last - timedelta(microseconds=1)
    ids = [t.id for t in tickets]

    comments: list[TicketComment] = []
    worklogs: list[TicketWorklog] = []
    # Técnico é terceiro: não recebe acompanhamentos (a central fala com ele pelo WhatsApp) e
    # só vê as próprias horas.
    technician = user.role == UserRole.TECHNICIAN
    if ids and not technician:
        cq = select(TicketComment).where(TicketComment.ticket_id.in_(ids))
        if since is not None:
            cq = cq.where(TicketComment.created_at > since)
        if not user.is_staff:
            cq = cq.where(TicketComment.is_internal.is_(False))
        comments = list(await db.scalars(cq.order_by(TicketComment.created_at)))
    if ids and user.is_staff:
        wq = select(TicketWorklog).where(TicketWorklog.ticket_id.in_(ids))
        if technician:
            wq = wq.where(TicketWorklog.user_id == user.id)
        if since is not None:
            wq = wq.where(TicketWorklog.created_at > since)
        worklogs = list(await db.scalars(wq.order_by(TicketWorklog.created_at)))

    revoked: list[uuid.UUID] = []
    if since is not None and technician:
        revoked = await _revoked(db, user, since)

    return SyncPullResponse(
        server_time=cursor,
        has_more=has_more,
        tickets=[svc.to_detail(t, user) for t in tickets],
        comments=[CommentOut.model_validate(c) for c in comments],
        worklogs=[WorklogOut.model_validate(w) for w in worklogs],
        revoked_ticket_ids=revoked,
    )


async def _revoked(db: AsyncSession, user: User, since: datetime) -> list[uuid.UUID]:
    """OS que saíram do técnico desde `since`: tirado do lugar de responsável ou da lista de
    outros técnicos da visita, e que ele não tem mais por outro caminho (duas consultas)."""
    me = str(user.id)
    candidates = set(
        await db.scalars(
            select(TicketEvent.ticket_id)
            .where(
                TicketEvent.created_at > since,
                or_(
                    and_(
                        TicketEvent.event_type == TicketEventType.ASSIGNED,
                        TicketEvent.from_value == me,
                    ),
                    and_(
                        TicketEvent.event_type == TicketEventType.HELPERS_CHANGED,
                        TicketEvent.data.contains({"removed_ids": [me]}),
                    ),
                ),
            )
            .distinct()
        )
    )
    if not candidates:
        return []
    still_mine = set(
        await db.scalars(
            select(Ticket.id).where(Ticket.id.in_(candidates), schedule.works_on(user.id))
        )
    )
    return sorted(candidates - still_mine, key=str)


async def _apply(db: AsyncSession, ticket: Ticket, op: SyncOperationIn, user: User) -> None:
    # `client_timestamp`: quando o técnico apertou o botão (relógio do aparelho). Fica como
    # evidência no histórico; o horário da OS continua sendo o do servidor.
    if op.type == "transition":
        payload = TicketTransition.model_validate(op.payload)
        if (
            payload.to_status == ticket.status
            and user.role == UserRole.TECHNICIAN
            and ticket.assignee_id == user.id
        ):
            # A central já fez esta mudança pelo técnico (ele esqueceu e avisou no grupo):
            # o que ele fez offline já está valendo, nada a aplicar nem a recusar.
            return
        await svc.transition_ticket(db, ticket, payload, user, declared_at=op.client_timestamp)
    elif op.type == "comment":
        if user.role == UserRole.TECHNICIAN:
            raise PermissionDenied(
                "Acompanhamento não faz parte do app: fale com a central pelo WhatsApp"
            )
        await svc.add_comment(db, ticket, CommentCreate.model_validate(op.payload), user)
    elif op.type == "worklog":
        await svc.add_worklog(db, ticket, WorklogCreate.model_validate(op.payload), user)
    elif op.type == "update":
        await svc.update_ticket(db, ticket, TicketUpdate.model_validate(op.payload), user)
    elif op.type == "unproductive":
        await svc.register_unproductive(
            db,
            ticket,
            TicketUnproductive.model_validate(op.payload),
            user,
            declared_at=op.client_timestamp,
        )
    elif op.type == "form_answers":
        try:
            form_id = uuid.UUID(str(op.payload.get("form_id")))
        except (TypeError, ValueError) as exc:
            raise WorkflowError("Formulário inválido") from exc
        form = await forms.get_ticket_form(db, ticket, form_id)
        await forms.save_answers(
            db, ticket, form, TicketFormAnswers.model_validate(op.payload), user
        )
    elif op.type == "part_request":
        await parts.create(db, ticket, PartRequestIn.model_validate(op.payload), user)
    await db.flush()


def validation_text(exc: ValidationError) -> str:
    """Erro de validação legível para o técnico ("Campo: mensagem" ou só a mensagem)."""
    return validation_messages.readable(exc.errors())


async def _attempt(
    db: AsyncSession, user: User, op: SyncOperationIn
) -> tuple[str, str | None, bool]:
    """Aplica uma operação no seu SAVEPOINT: (status, erro, a OS existe para o usuário).

    Nenhum erro de uma operação derruba o lote: o que não é regra de negócio (dado que o banco
    recusa, defeito) vira "rejeitada" com um texto simples e fica no log. Sem isso o lote voltava
    com 500, o app reenviava para sempre e deixava de receber OS novas.
    """
    try:
        async with db.begin_nested():
            ticket = await svc.get_visible_ticket(db, user, op.ticket_id)
            await _apply(db, ticket, op, user)
    except (VersionConflict, StaleDataError) as exc:
        if isinstance(exc, StaleDataError):
            return "conflict", str(VersionConflict()), True
        return "conflict", str(exc), True
    except ValidationError as exc:
        return "rejected", validation_text(exc), True
    except NotFound as exc:
        return "rejected", str(exc), False
    except DomainError as exc:
        return "rejected", str(exc), True
    except Exception:
        log.exception("Falha ao aplicar a operação %s (%s)", op.client_op_id, op.type)
        return "rejected", UNEXPECTED, True
    return "applied", None, True


async def push(db: AsyncSession, user: User, request: SyncPushRequest) -> SyncPushResponse:
    # Um envio por vez de cada usuário: o app desiste da resposta em 20 s e reenvia o mesmo lote
    # enquanto o primeiro ainda roda. O segundo espera o primeiro gravar e encontra as operações
    # como "duplicate" (sem a trava, aplicava de novo e o registro duplicado virava 409, e o app
    # descartava o lote inteiro).
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"sync:{user.id}"},
    )
    outcomes: list[tuple[SyncOperationIn, str, str | None]] = []
    for op in request.operations:
        existing = await db.scalar(
            select(SyncOperation).where(
                SyncOperation.user_id == user.id, SyncOperation.client_op_id == op.client_op_id
            )
        )
        if existing is not None:
            outcomes.append((op, "duplicate", (existing.response or {}).get("error")))
            continue

        mark = pending_count(db)
        try:
            # A operação e o registro dela entram juntos (ou nenhum dos dois).
            async with db.begin_nested():
                status, error, ticket_exists = await _attempt(db, user, op)
                if status != "applied":
                    discard_pending(db, mark)
                db.add(
                    SyncOperation(
                        user_id=user.id,
                        client_op_id=op.client_op_id,
                        op_type=op.type,
                        ticket_id=op.ticket_id if ticket_exists else None,
                        status=status,
                        response={"error": error} if error else None,
                    )
                )
                await db.flush()
        except IntegrityError:
            # Corrida com outro envio que registrou a mesma operação: vale o que ele gravou.
            discard_pending(db, mark)
            existing = await db.scalar(
                select(SyncOperation).where(
                    SyncOperation.user_id == user.id,
                    SyncOperation.client_op_id == op.client_op_id,
                )
            )
            outcomes.append(
                (op, "duplicate", (existing.response or {}).get("error") if existing else None)
            )
            continue
        outcomes.append((op, status, error))

    await commit_and_publish(db)

    # Depois do commit todas as operações de uma OS veem o mesmo estado final: cada OS é lida
    # e montada uma vez só (um lote de 100 respostas de formulário não recarrega 100 vezes).
    details: dict[uuid.UUID, TicketDetail | None] = {}
    results: list[SyncOperationResult] = []
    for op, status, error in outcomes:
        if op.ticket_id not in details:
            detail = None
            with contextlib.suppress(NotFound):
                detail = svc.to_detail(await svc.get_visible_ticket(db, user, op.ticket_id), user)
            details[op.ticket_id] = detail
        results.append(
            SyncOperationResult(
                client_op_id=op.client_op_id,
                status=status,  # type: ignore[arg-type]
                error=error,
                ticket=details[op.ticket_id],
            )
        )
    return SyncPushResponse(server_time=utcnow(), results=results)

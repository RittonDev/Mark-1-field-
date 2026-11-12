"""Sincronização offline-first do app do técnico.

pull: delta por `updated_at` desde o último `server_time` recebido.
push: lote de operações feitas offline, idempotentes por `client_op_id`;
cada operação roda num SAVEPOINT, então uma rejeitada não derruba as outras.
"""

import contextlib
import uuid
from datetime import datetime, timedelta

from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from app.core.enums import TicketEventType, UserRole
from app.db.base import utcnow
from app.models import SyncOperation, Ticket, TicketComment, TicketEvent, TicketWorklog, User
from app.schemas.forms import TicketFormAnswers
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
    TicketTransition,
    TicketUpdate,
    WorklogCreate,
    WorklogOut,
)
from app.services import forms
from app.services import tickets as svc
from app.services.errors import DomainError, NotFound, VersionConflict
from app.services.realtime import commit_and_publish, discard_pending, pending_count
from app.services.workflow import OPEN_STATUSES

PULL_LIMIT = 500
# Margem para transações que gravaram antes do corte mas confirmaram depois.
CLOCK_SKEW = timedelta(seconds=10)
INITIAL_WINDOW = timedelta(days=7)


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
            select(Ticket).where(*conds).order_by(Ticket.updated_at).limit(PULL_LIMIT + 1)
        )
    )
    has_more = len(tickets) > PULL_LIMIT
    tickets = tickets[:PULL_LIMIT]
    ids = [t.id for t in tickets]

    comments: list[TicketComment] = []
    worklogs: list[TicketWorklog] = []
    if ids:
        cq = select(TicketComment).where(TicketComment.ticket_id.in_(ids))
        if since is not None:
            cq = cq.where(TicketComment.created_at > since)
        if not user.is_staff:
            cq = cq.where(TicketComment.is_internal.is_(False))
        comments = list(await db.scalars(cq.order_by(TicketComment.created_at)))
        if user.is_staff:
            wq = select(TicketWorklog).where(TicketWorklog.ticket_id.in_(ids))
            if since is not None:
                wq = wq.where(TicketWorklog.created_at > since)
            worklogs = list(await db.scalars(wq.order_by(TicketWorklog.created_at)))

    revoked = []
    if since is not None and user.role == UserRole.TECHNICIAN:
        candidates = await db.scalars(
            select(TicketEvent.ticket_id)
            .where(
                TicketEvent.event_type == TicketEventType.ASSIGNED,
                TicketEvent.from_value == str(user.id),
                TicketEvent.created_at > since,
            )
            .distinct()
        )
        for ticket_id in candidates:
            ticket = await db.get(Ticket, ticket_id)
            if ticket is not None and not svc.can_view(user, ticket):
                revoked.append(ticket_id)

    cursor = (
        tickets[-1].updated_at - timedelta(microseconds=1) if has_more else started - CLOCK_SKEW
    )
    return SyncPullResponse(
        server_time=cursor,
        has_more=has_more,
        tickets=[svc.to_detail(t, user) for t in tickets],
        comments=[CommentOut.model_validate(c) for c in comments],
        worklogs=[WorklogOut.model_validate(w) for w in worklogs],
        revoked_ticket_ids=revoked,
    )


async def _apply(db: AsyncSession, ticket: Ticket, op: SyncOperationIn, user: User) -> None:
    if op.type == "transition":
        await svc.transition_ticket(db, ticket, TicketTransition.model_validate(op.payload), user)
    elif op.type == "comment":
        await svc.add_comment(db, ticket, CommentCreate.model_validate(op.payload), user)
    elif op.type == "worklog":
        await svc.add_worklog(db, ticket, WorklogCreate.model_validate(op.payload), user)
    elif op.type == "update":
        await svc.update_ticket(db, ticket, TicketUpdate.model_validate(op.payload), user)
    elif op.type == "form_answers":
        form = await forms.get_ticket_form(db, ticket, uuid.UUID(str(op.payload.get("form_id"))))
        await forms.save_answers(db, ticket, form, TicketFormAnswers.model_validate(op.payload), user)
    await db.flush()


def validation_text(exc: ValidationError) -> str:
    """Erro de validação legível para o técnico ("campo: mensagem" ou só a mensagem)."""
    parts = []
    for err in exc.errors():
        msg = err["msg"].removeprefix("Value error, ")
        loc = ".".join(str(p) for p in err["loc"])
        parts.append(f"{loc}: {msg}" if loc else msg)
    return "; ".join(parts)


async def push(db: AsyncSession, user: User, request: SyncPushRequest) -> SyncPushResponse:
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
        status, error = "applied", None
        ticket_exists = True
        try:
            async with db.begin_nested():
                ticket = await svc.get_visible_ticket(db, user, op.ticket_id)
                await _apply(db, ticket, op, user)
        except (VersionConflict, StaleDataError) as exc:
            status, error = "conflict", str(exc)
        except ValidationError as exc:
            status, error = "rejected", validation_text(exc)
        except NotFound as exc:
            status, error, ticket_exists = "rejected", str(exc), False
        except DomainError as exc:
            status, error = "rejected", str(exc)
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
        outcomes.append((op, status, error))

    await commit_and_publish(db)

    results: list[SyncOperationResult] = []
    for op, status, error in outcomes:
        detail = None
        with contextlib.suppress(NotFound):
            detail = svc.to_detail(await svc.get_visible_ticket(db, user, op.ticket_id), user)
        results.append(
            SyncOperationResult(
                client_op_id=op.client_op_id,
                status=status,  # type: ignore[arg-type]
                error=error,
                ticket=detail,
            )
        )
    return SyncPushResponse(server_time=utcnow(), results=results)

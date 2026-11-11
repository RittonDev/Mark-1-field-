"""Regras de negócio da OS: abertura, edição, atribuição, status, acompanhamentos.

As rotas HTTP e a sincronização mobile chamam estas funções; nenhuma regra de
OS deve morar na camada de rotas.
"""

import math
import uuid
from datetime import datetime, timedelta
from enum import Enum
from typing import Any

from fastapi import UploadFile
from sqlalchemy import DateTime, and_, case, func, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import settings
from app.core.enums import TicketEventType, TicketPriority, TicketStatus, UserRole
from app.db.base import utcnow
from app.models import (
    Asset,
    Category,
    Customer,
    Location,
    Team,
    Ticket,
    TicketAttachment,
    TicketComment,
    TicketEvent,
    TicketWorklog,
    User,
)
from app.schemas.ticket import (
    CommentCreate,
    TicketCreate,
    TicketDetail,
    TicketFilters,
    TicketTransition,
    TicketUpdate,
    WorklogCreate,
)
from app.services import sla, storage
from app.services.errors import NotFound, PermissionDenied, VersionConflict, WorkflowError
from app.services.realtime import queue_event
from app.services.workflow import (
    OPEN_STATUSES,
    SLA_PAUSED_STATUSES,
    STATUS_INFO,
    TRANSITIONS,
    UNTOUCHED_STATUSES,
    compute_priority,
    user_can_transition,
    validate_transition,
)

S = TicketStatus
FIELD_ACTIVE = frozenset({S.ASSIGNED, S.SCHEDULED, S.EN_ROUTE, S.IN_PROGRESS})
FINAL = frozenset({S.CLOSED, S.CANCELLED})


# --------------------------------------------------------------------------- visibilidade


def visibility_clause(user: User) -> ColumnElement[bool] | None:
    if user.is_manager:
        return None
    if user.role == UserRole.ANALYST:
        conds: list[ColumnElement[bool]] = [
            Ticket.assignee_id == user.id,
            and_(Ticket.assignee_id.is_(None), Ticket.team_id.is_(None)),
        ]
        if user.team_id is not None:
            conds.append(Ticket.team_id == user.team_id)
        return or_(*conds)
    return or_(Ticket.requester_id == user.id, Ticket.created_by_id == user.id)


def can_view(user: User, ticket: Ticket) -> bool:
    if user.is_manager:
        return True
    if user.role == UserRole.ANALYST:
        return (
            ticket.assignee_id == user.id
            or (ticket.assignee_id is None and ticket.team_id is None)
            or (user.team_id is not None and ticket.team_id == user.team_id)
        )
    return user.id in (ticket.requester_id, ticket.created_by_id)


def can_edit(user: User, ticket: Ticket) -> bool:
    if ticket.status in FINAL:
        return False
    if user.is_manager:
        return True
    if user.role == UserRole.ANALYST:
        return ticket.assignee_id == user.id or (
            user.team_id is not None and ticket.team_id == user.team_id
        )
    return False


def can_assign(user: User, ticket: Ticket) -> bool:
    return user.is_manager and ticket.status not in FINAL


def can_take(user: User, ticket: Ticket) -> bool:
    return (
        user.is_staff
        and ticket.status in OPEN_STATUSES
        and ticket.assignee_id != user.id
        and (user.is_manager or ticket.assignee_id is None)
        and can_view(user, ticket)
    )


def allowed_transitions(user: User, ticket: Ticket) -> list[TicketStatus]:
    result: list[TicketStatus] = []
    for to in TRANSITIONS.get(ticket.status, ()):
        if not user_can_transition(
            role=user.role,
            user_id=user.id,
            user_team_id=user.team_id,
            ticket_assignee_id=ticket.assignee_id,
            ticket_team_id=ticket.team_id,
            ticket_requester_id=ticket.requester_id,
            from_status=ticket.status,
            to_status=to,
        ):
            continue
        # Sem analista, só um analista consegue (ele assume automaticamente).
        if (
            STATUS_INFO[to].requires_assignee
            and ticket.assignee_id is None
            and user.role != UserRole.ANALYST
        ):
            continue
        result.append(to)
    return result


def to_detail(ticket: Ticket, user: User) -> TicketDetail:
    detail = TicketDetail.model_validate(ticket)
    detail.allowed_transitions = allowed_transitions(user, ticket)
    detail.can_edit = can_edit(user, ticket)
    detail.can_assign = can_assign(user, ticket)
    return detail


# --------------------------------------------------------------------------- carga


async def get_ticket(db: AsyncSession, ticket_id: uuid.UUID) -> Ticket:
    ticket = await db.scalar(
        select(Ticket).where(Ticket.id == ticket_id).execution_options(populate_existing=True)
    )
    if ticket is None:
        raise NotFound("OS não encontrada")
    return ticket


async def get_visible_ticket(db: AsyncSession, user: User, ticket_id: uuid.UUID) -> Ticket:
    ticket = await get_ticket(db, ticket_id)
    if not can_view(user, ticket):
        raise NotFound("OS não encontrada")
    return ticket


def check_version(ticket: Ticket, expected: int | None) -> None:
    if expected is not None and expected != ticket.version:
        raise VersionConflict(ticket.version)


# --------------------------------------------------------------------------- utilitários


def _jsonable(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def record_event(
    db: AsyncSession,
    ticket: Ticket,
    actor: User | None,
    event_type: TicketEventType,
    *,
    from_value: str | None = None,
    to_value: str | None = None,
    note: str | None = None,
    data: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> None:
    db.add(
        TicketEvent(
            ticket_id=ticket.id,
            actor_id=actor.id if actor else None,
            event_type=event_type,
            from_value=from_value,
            to_value=to_value,
            note=(note or "").strip() or None,
            data=data or None,
            created_at=now or utcnow(),
        )
    )


async def _touch(db: AsyncSession, ticket: Ticket, now: datetime) -> None:
    """Marca atividade na OS (para ordenação e sync) sem incrementar a versão."""
    await db.execute(
        update(Ticket)
        .where(Ticket.id == ticket.id)
        .values(updated_at=now)
        .execution_options(synchronize_session=False)
    )


async def _resolve_refs(
    db: AsyncSession,
    *,
    customer_id: uuid.UUID | None,
    location_id: uuid.UUID | None,
    asset_id: uuid.UUID | None,
    category_id: uuid.UUID | None,
    team_id: uuid.UUID | None,
) -> dict[str, Any]:
    """Valida e completa as referências (cliente/local inferidos do ativo)."""
    if asset_id is not None:
        asset = await db.get(Asset, asset_id)
        if asset is None:
            raise WorkflowError("Ativo não encontrado")
        customer_id = customer_id or asset.customer_id
        location_id = location_id or asset.location_id
        if asset.customer_id != customer_id:
            raise WorkflowError("O ativo não pertence ao cliente informado")
    if location_id is not None:
        location = await db.get(Location, location_id)
        if location is None:
            raise WorkflowError("Local não encontrado")
        customer_id = customer_id or location.customer_id
        if location.customer_id != customer_id:
            raise WorkflowError("O local não pertence ao cliente informado")
    if customer_id is not None and await db.get(Customer, customer_id) is None:
        raise WorkflowError("Cliente não encontrado")
    category = None
    if category_id is not None:
        category = await db.get(Category, category_id)
        if category is None:
            raise WorkflowError("Categoria não encontrada")
    if team_id is not None and await db.get(Team, team_id) is None:
        raise WorkflowError("Grupo não encontrado")
    return {
        "customer_id": customer_id,
        "location_id": location_id,
        "asset_id": asset_id,
        "category": category,
        "team_id": team_id,
    }


def _check_schedule(start: datetime | None, end: datetime | None) -> None:
    if start is not None and end is not None and end <= start:
        raise WorkflowError("O fim da visita deve ser depois do início")


# --------------------------------------------------------------------------- status


def _change_status(
    db: AsyncSession,
    ticket: Ticket,
    to: TicketStatus,
    actor: User | None,
    *,
    now: datetime,
    note: str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Aplica a mudança de status com efeitos de SLA e datas. Não valida permissão."""
    from_status = ticket.status
    if to in SLA_PAUSED_STATUSES and from_status not in SLA_PAUSED_STATUSES:
        sla.pause(ticket, now)
    elif from_status in SLA_PAUSED_STATUSES and to not in SLA_PAUSED_STATUSES:
        sla.resume(ticket, now)

    if (
        ticket.first_response_at is None
        and actor is not None
        and actor.is_staff
        and from_status in UNTOUCHED_STATUSES
        and to != S.CANCELLED
    ):
        ticket.first_response_at = now

    if to == S.RESOLVED:
        ticket.resolved_at = now
    elif to == S.CLOSED:
        ticket.closed_at = now
    elif to == S.CANCELLED:
        ticket.cancelled_at = now
    elif to == S.REOPENED:
        ticket.reopen_count = (ticket.reopen_count or 0) + 1
        ticket.resolved_at = None
        ticket.closed_at = None

    ticket.status = to
    payload = {"from": from_status.value, "to": to.value, **(data or {})}
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.STATUS_CHANGED,
        from_value=from_status.value,
        to_value=to.value,
        note=note,
        data=data,
        now=now,
    )
    queue_event(db, "status_changed", ticket, actor, payload)


async def _assign(
    db: AsyncSession,
    ticket: Ticket,
    assignee_id: uuid.UUID | None,
    team_id: uuid.UUID | None,
    actor: User,
    *,
    now: datetime,
    note: str | None = None,
) -> None:
    prev_id = ticket.assignee_id
    assignee: User | None = None
    if assignee_id is not None:
        assignee = await db.get(User, assignee_id)
        if assignee is None or not assignee.is_active or not assignee.is_staff:
            raise WorkflowError("Analista inválido ou inativo")

    team_changed = False
    if team_id is not None and team_id != ticket.team_id:
        if await db.get(Team, team_id) is None:
            raise WorkflowError("Grupo não encontrado")
        ticket.team_id = team_id
        team_changed = True
    elif assignee is not None and ticket.team_id is None and assignee.team_id is not None:
        ticket.team_id = assignee.team_id
        team_changed = True

    if prev_id == assignee_id and not team_changed:
        return

    prev_name = None
    if prev_id is not None:
        prev_user = await db.get(User, prev_id)
        prev_name = prev_user.name if prev_user else None

    ticket.assignee_id = assignee_id
    data = {
        "from_name": prev_name,
        "to_name": assignee.name if assignee else None,
        "team_id": _jsonable(ticket.team_id),
    }
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.ASSIGNED,
        from_value=_jsonable(prev_id),
        to_value=_jsonable(assignee_id),
        note=note,
        data=data,
        now=now,
    )
    queue_event(db, "assigned", ticket, actor, data, previous_assignee_id=prev_id)

    if assignee_id is None:
        if ticket.status in FIELD_ACTIVE:
            _change_status(db, ticket, S.NEW, actor, now=now, note="Analista removido")
    elif ticket.status in (S.NEW, S.TRIAGE, S.REOPENED):
        _change_status(db, ticket, S.ASSIGNED, actor, now=now)
    elif ticket.status in (S.EN_ROUTE, S.IN_PROGRESS) and prev_id not in (None, assignee_id):
        _change_status(db, ticket, S.ASSIGNED, actor, now=now, note="Troca de analista")


# --------------------------------------------------------------------------- casos de uso


async def create_ticket(db: AsyncSession, data: TicketCreate, actor: User) -> Ticket:
    now = utcnow()
    is_requester = actor.role == UserRole.REQUESTER
    refs = await _resolve_refs(
        db,
        customer_id=data.customer_id,
        location_id=data.location_id,
        asset_id=data.asset_id,
        category_id=data.category_id,
        team_id=None if is_requester else data.team_id,
    )
    category: Category | None = refs["category"]
    team_id = refs["team_id"]
    if team_id is None and category is not None:
        team_id = category.default_team_id

    priority = (
        data.priority
        if data.priority is not None and not is_requester
        else compute_priority(data.impact, data.urgency)
    )

    requester_id = actor.id if is_requester else data.requester_id
    requester_name = data.requester_name
    if requester_id is not None:
        requester = await db.get(User, requester_id)
        if requester is None:
            raise WorkflowError("Solicitante não encontrado")
        requester_name = requester_name or requester.name

    scheduled_start = None if is_requester else data.scheduled_start
    scheduled_end = None if is_requester else data.scheduled_end
    _check_schedule(scheduled_start, scheduled_end)

    ticket = Ticket(
        title=data.title.strip(),
        description=data.description,
        type=data.type,
        status=S.NEW,
        impact=data.impact,
        urgency=data.urgency,
        priority=priority,
        source=data.source,
        category_id=category.id if category else None,
        customer_id=refs["customer_id"],
        location_id=refs["location_id"],
        asset_id=refs["asset_id"],
        requester_id=requester_id,
        requester_name=requester_name,
        requester_contact=data.requester_contact,
        created_by_id=actor.id,
        team_id=team_id,
        scheduled_start=scheduled_start,
        scheduled_end=scheduled_end,
        sla_paused_seconds=0,
        reopen_count=0,
        created_at=now,
        updated_at=now,
    )
    response_min, resolution_min = await sla.get_policy_minutes(db, priority)
    sla.set_due_dates(
        ticket, base=now, response_minutes=response_min, resolution_minutes=resolution_min
    )
    db.add(ticket)
    await db.flush()  # gera id e número

    record_event(
        db,
        ticket,
        actor,
        TicketEventType.CREATED,
        to_value=S.NEW.value,
        data={"priority": priority.value, "source": data.source.value},
        now=now,
    )
    queue_event(db, "created", ticket, actor, {"title": ticket.title})

    if data.assignee_id is not None and not is_requester:
        if not actor.is_manager and data.assignee_id != actor.id:
            raise PermissionDenied("Somente supervisores atribuem OS a outros analistas")
        await _assign(db, ticket, data.assignee_id, None, actor, now=now)
    return ticket


async def update_ticket(
    db: AsyncSession, ticket: Ticket, data: TicketUpdate, actor: User
) -> Ticket:
    if not can_edit(actor, ticket):
        raise PermissionDenied("Você não pode editar esta OS")
    check_version(ticket, data.expected_version)
    fields = data.model_dump(exclude_unset=True, exclude={"expected_version"})
    if not fields:
        return ticket

    ref_keys = {"customer_id", "location_id", "asset_id", "category_id", "team_id"}
    if ref_keys & fields.keys():
        refs = await _resolve_refs(
            db,
            customer_id=fields.get("customer_id", ticket.customer_id),
            location_id=fields.get("location_id", ticket.location_id),
            asset_id=fields.get("asset_id", ticket.asset_id),
            category_id=fields.get("category_id", ticket.category_id),
            team_id=fields.get("team_id", ticket.team_id),
        )
        fields.update(
            customer_id=refs["customer_id"],
            location_id=refs["location_id"],
            asset_id=refs["asset_id"],
            category_id=refs["category"].id if refs["category"] else None,
            team_id=refs["team_id"],
        )

    if ("impact" in fields or "urgency" in fields) and "priority" not in fields:
        fields["priority"] = compute_priority(
            fields.get("impact", ticket.impact), fields.get("urgency", ticket.urgency)
        )
    _check_schedule(
        fields.get("scheduled_start", ticket.scheduled_start),
        fields.get("scheduled_end", ticket.scheduled_end),
    )

    changes: dict[str, list[Any]] = {}
    for key, value in fields.items():
        old = getattr(ticket, key)
        if old != value:
            changes[key] = [_jsonable(old), _jsonable(value)]
            setattr(ticket, key, value)
    if not changes:
        return ticket

    if "priority" in changes and ticket.resolved_at is None:
        response_min, resolution_min = await sla.get_policy_minutes(db, ticket.priority)
        sla.set_due_dates(
            ticket,
            base=ticket.created_at,
            response_minutes=response_min,
            resolution_minutes=resolution_min,
        )

    now = utcnow()
    record_event(db, ticket, actor, TicketEventType.UPDATED, data={"changes": changes}, now=now)
    queue_event(db, "updated", ticket, actor, {"fields": sorted(changes)})
    return ticket


async def assign_ticket(
    db: AsyncSession,
    ticket: Ticket,
    *,
    assignee_id: uuid.UUID | None,
    team_id: uuid.UUID | None,
    note: str | None,
    expected_version: int | None,
    actor: User,
) -> Ticket:
    if not can_assign(actor, ticket):
        raise PermissionDenied("Somente supervisores atribuem OS")
    check_version(ticket, expected_version)
    await _assign(db, ticket, assignee_id, team_id, actor, now=utcnow(), note=note)
    return ticket


async def take_ticket(db: AsyncSession, ticket: Ticket, actor: User) -> Ticket:
    if not can_take(actor, ticket):
        raise PermissionDenied("Esta OS não pode ser assumida por você")
    await _assign(db, ticket, actor.id, None, actor, now=utcnow(), note="Assumida pelo analista")
    return ticket


async def transition_ticket(
    db: AsyncSession, ticket: Ticket, payload: TicketTransition, actor: User
) -> Ticket:
    now = utcnow()
    check_version(ticket, payload.expected_version)
    to = payload.to_status
    if not user_can_transition(
        role=actor.role,
        user_id=actor.id,
        user_team_id=actor.team_id,
        ticket_assignee_id=ticket.assignee_id,
        ticket_team_id=ticket.team_id,
        ticket_requester_id=ticket.requester_id,
        from_status=ticket.status,
        to_status=to,
    ):
        raise PermissionDenied("Você não pode mudar o status desta OS")

    if payload.scheduled_start is not None:
        ticket.scheduled_start = payload.scheduled_start
    if payload.scheduled_end is not None:
        ticket.scheduled_end = payload.scheduled_end
    _check_schedule(ticket.scheduled_start, ticket.scheduled_end)

    auto_assign = (
        actor.role == UserRole.ANALYST
        and ticket.assignee_id is None
        and STATUS_INFO[to].requires_assignee
    )
    validate_transition(
        from_status=ticket.status,
        to_status=to,
        has_assignee=ticket.assignee_id is not None or auto_assign,
        has_schedule=ticket.scheduled_start is not None,
        note=payload.note,
        resolution_notes=payload.resolution_notes,
    )
    if auto_assign:
        await _assign(db, ticket, actor.id, None, actor, now=now, note="Assumida ao mudar o status")

    if to == S.RESOLVED and payload.resolution_notes:
        ticket.resolution_notes = payload.resolution_notes.strip()

    data: dict[str, Any] = {}
    if payload.latitude is not None and payload.longitude is not None:
        data["latitude"] = payload.latitude
        data["longitude"] = payload.longitude
    if to == S.SCHEDULED and ticket.scheduled_start is not None:
        data["scheduled_start"] = ticket.scheduled_start.isoformat()
    if ticket.status != to:
        _change_status(db, ticket, to, actor, now=now, note=payload.note, data=data)
    return ticket


async def add_comment(
    db: AsyncSession, ticket: Ticket, data: CommentCreate, actor: User
) -> TicketComment:
    if ticket.status in FINAL and not actor.is_manager:
        raise WorkflowError("OS encerrada não recebe novos acompanhamentos")
    now = utcnow()
    is_internal = data.is_internal and actor.is_staff
    comment = TicketComment(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        author_id=actor.id,
        body=data.body.strip(),
        is_internal=is_internal,
        created_at=now,
    )
    db.add(comment)
    if actor.is_staff and not is_internal and ticket.first_response_at is None:
        ticket.first_response_at = now
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.COMMENT_ADDED,
        data={"comment_id": str(comment.id), "internal": is_internal},
        now=now,
    )
    await _touch(db, ticket, now)
    queue_event(
        db,
        "comment_added",
        ticket,
        actor,
        {"comment_id": str(comment.id), "internal": is_internal, "preview": comment.body[:140]},
        internal=is_internal,
    )
    # Como no ServiceNow: resposta do solicitante tira a OS de "Aguardando cliente".
    if (
        actor.role == UserRole.REQUESTER
        and ticket.status == S.ON_HOLD_CUSTOMER
        and ticket.assignee_id is not None
    ):
        _change_status(db, ticket, S.ASSIGNED, actor, now=now, note="Retorno do solicitante")
    await db.flush()
    return comment


async def add_worklog(
    db: AsyncSession, ticket: Ticket, data: WorklogCreate, actor: User
) -> TicketWorklog:
    if not (actor.is_staff and can_edit(actor, ticket)):
        raise PermissionDenied("Você não pode apontar horas nesta OS")
    now = utcnow()
    minutes = data.minutes
    if minutes is None and data.ended_at is not None:
        minutes = max(1, math.ceil((data.ended_at - data.started_at).total_seconds() / 60))
    worklog = TicketWorklog(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        user_id=actor.id,
        description=data.description.strip(),
        started_at=data.started_at,
        ended_at=data.ended_at,
        minutes=minutes or 1,
        latitude=data.latitude,
        longitude=data.longitude,
        created_at=now,
    )
    db.add(worklog)
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.WORKLOG_ADDED,
        data={"worklog_id": str(worklog.id), "minutes": worklog.minutes},
        now=now,
    )
    await _touch(db, ticket, now)
    queue_event(db, "worklog_added", ticket, actor, {"minutes": worklog.minutes}, internal=True)
    await db.flush()
    return worklog


async def add_attachment(
    db: AsyncSession, ticket: Ticket, upload: UploadFile, kind: str, actor: User
) -> TicketAttachment:
    if ticket.status in FINAL and not actor.is_manager:
        raise WorkflowError("OS encerrada não recebe anexos")
    if kind not in ("file", "photo", "signature"):
        raise WorkflowError("kind deve ser file, photo ou signature")
    now = utcnow()
    try:
        key, size = await storage.save_upload(ticket.id, upload)
    except storage.UploadTooLarge as exc:
        raise WorkflowError(str(exc)) from exc
    attachment = TicketAttachment(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        uploaded_by_id=actor.id,
        filename=(upload.filename or "arquivo")[:255],
        content_type=upload.content_type or "application/octet-stream",
        size_bytes=size,
        kind=kind,
        storage_key=key,
        created_at=now,
    )
    db.add(attachment)
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.ATTACHMENT_ADDED,
        data={"attachment_id": str(attachment.id), "filename": attachment.filename, "kind": kind},
        now=now,
    )
    await _touch(db, ticket, now)
    queue_event(db, "attachment_added", ticket, actor, {"filename": attachment.filename})
    await db.flush()
    return attachment


async def auto_close_resolved(db: AsyncSession, now: datetime | None = None) -> int:
    """Fecha OS resolvidas há mais de AUTO_CLOSE_RESOLVED_DAYS (aceite tácito)."""
    now = now or utcnow()
    cutoff = now - timedelta(days=settings.AUTO_CLOSE_RESOLVED_DAYS)
    tickets = list(
        await db.scalars(
            select(Ticket)
            .where(Ticket.status == S.RESOLVED, Ticket.resolved_at < cutoff)
            .limit(200)
        )
    )
    for ticket in tickets:
        _change_status(
            db,
            ticket,
            S.CLOSED,
            None,
            now=now,
            note=f"Fechada automaticamente {settings.AUTO_CLOSE_RESOLVED_DAYS} dias após a solução",
        )
    return len(tickets)


# --------------------------------------------------------------------------- listagem


def breached_clause(now: datetime) -> ColumnElement[bool]:
    clock = func.coalesce(Ticket.sla_paused_at, literal(now, DateTime(timezone=True)))
    return and_(
        Ticket.status.in_(OPEN_STATUSES),
        or_(
            and_(Ticket.resolution_due_at.is_not(None), clock > Ticket.resolution_due_at),
            and_(
                Ticket.first_response_at.is_(None),
                Ticket.response_due_at.is_not(None),
                clock > Ticket.response_due_at,
            ),
        ),
    )


PRIORITY_RANK = case(
    {
        TicketPriority.CRITICAL: 1,
        TicketPriority.HIGH: 2,
        TicketPriority.MEDIUM: 3,
        TicketPriority.LOW: 4,
    },
    value=Ticket.priority,
    else_=5,
)

ORDERABLE: dict[str, Any] = {
    "updated_at": Ticket.updated_at,
    "created_at": Ticket.created_at,
    "priority": PRIORITY_RANK,
    "resolution_due_at": Ticket.resolution_due_at,
    "number": Ticket.number,
}


def _ordering(order_by: str) -> list[Any]:
    desc = order_by.startswith("-")
    column = ORDERABLE.get(order_by.lstrip("-"), Ticket.updated_at)
    primary = column.desc() if desc else column.asc()
    return [primary.nulls_last(), Ticket.number.desc()]


def _parse_number(q: str) -> int | None:
    digits = q.upper().removeprefix(f"{settings.TICKET_PREFIX}-").lstrip("#")
    return int(digits) if digits.isdigit() else None


def filter_conditions(user: User, f: TicketFilters, now: datetime) -> list[ColumnElement[bool]]:
    conds: list[ColumnElement[bool]] = []
    vis = visibility_clause(user)
    if vis is not None:
        conds.append(vis)
    if f.status:
        conds.append(Ticket.status.in_(f.status))
    if f.open_only:
        conds.append(Ticket.status.in_(OPEN_STATUSES))
    if f.priority:
        conds.append(Ticket.priority.in_(f.priority))
    if f.type:
        conds.append(Ticket.type == f.type)
    if f.assignee_id:
        conds.append(Ticket.assignee_id == f.assignee_id)
    if f.team_id:
        conds.append(Ticket.team_id == f.team_id)
    if f.customer_id:
        conds.append(Ticket.customer_id == f.customer_id)
    if f.asset_id:
        conds.append(Ticket.asset_id == f.asset_id)
    if f.category_id:
        subcats = select(Category.id).where(
            or_(Category.id == f.category_id, Category.parent_id == f.category_id)
        )
        conds.append(Ticket.category_id.in_(subcats))
    if f.mine:
        if user.is_staff:
            conds.append(Ticket.assignee_id == user.id)
        else:
            conds.append(Ticket.requester_id == user.id)
    if f.unassigned:
        conds.append(Ticket.assignee_id.is_(None))
    if f.sla_breached:
        conds.append(breached_clause(now))
    if f.q and f.q.strip():
        q = f.q.strip()
        like = f"%{q}%"
        text_match = [
            Ticket.title.ilike(like),
            Ticket.description.ilike(like),
            Ticket.requester_name.ilike(like),
        ]
        number = _parse_number(q)
        if number is not None:
            text_match.append(Ticket.number == number)
        conds.append(or_(*text_match))
    return conds


async def list_tickets(
    db: AsyncSession,
    user: User,
    f: TicketFilters,
    *,
    page: int,
    page_size: int,
    order_by: str,
) -> tuple[list[Ticket], int]:
    conds = filter_conditions(user, f, utcnow())
    total = await db.scalar(select(func.count()).select_from(Ticket).where(*conds)) or 0
    stmt = (
        select(Ticket)
        .where(*conds)
        .order_by(*_ordering(order_by))
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return list(await db.scalars(stmt)), total

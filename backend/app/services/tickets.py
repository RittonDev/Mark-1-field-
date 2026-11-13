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
from app.core.enums import (
    AuthorizationStatus,
    FormStatus,
    TicketEventType,
    TicketPriority,
    TicketStatus,
    UserRole,
    ViolationScope,
)
from app.core.security import create_download_token
from app.db.base import utcnow
from app.models import (
    Asset,
    Category,
    Customer,
    Location,
    Project,
    ServiceType,
    Team,
    Ticket,
    TicketAttachment,
    TicketComment,
    TicketEvent,
    TicketWorklog,
    UnproductiveReason,
    User,
    ViolationReason,
)
from app.schemas.field import FieldRules
from app.schemas.part_request import PartRequestAttachment
from app.schemas.ticket import (
    CommentCreate,
    RecurrenceItem,
    TicketAuthorizationIn,
    TicketCreate,
    TicketDetail,
    TicketFilters,
    TicketRecurrence,
    TicketTransition,
    TicketUnproductive,
    TicketUpdate,
    TicketViolationUpdate,
    WorklogCreate,
)
from app.services import client_report, durations, schedule, sla, storage
from app.services import field as field_rules
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
# Quem assume sozinho uma OS sem responsável ao iniciar o atendimento.
SELF_ASSIGN_ROLES = frozenset({UserRole.ANALYST})


# --------------------------------------------------------------------------- visibilidade


def visibility_clause(user: User) -> ColumnElement[bool] | None:
    if user.can_manage_tickets:
        return None
    if user.role == UserRole.TECHNICIAN:
        # O técnico só vê as OS em que o analista o colocou (responsável ou outro técnico).
        return schedule.works_on(user.id)
    return or_(Ticket.requester_id == user.id, Ticket.created_by_id == user.id)


def is_helper(user: User, ticket: Ticket) -> bool:
    """Outro técnico da visita (não o responsável)."""
    return any(h.id == user.id for h in ticket.helpers)


def attachment_visible(attachment: TicketAttachment, user: User) -> bool:
    """O técnico (terceiro) vê as fotos, as fotos dos formulários, a assinatura e o que ele mesmo
    enviou. Documentos do escritório (orçamento, nota, arquivos migrados) ficam com a gestão."""
    if user.role != UserRole.TECHNICIAN:
        return True
    return (
        attachment.uploaded_by_id == user.id
        or attachment.form_id is not None
        or attachment.kind in ("photo", "signature")
    )


def can_view(user: User, ticket: Ticket) -> bool:
    if user.can_manage_tickets:
        return True
    if user.role == UserRole.TECHNICIAN:
        return ticket.assignee_id == user.id or is_helper(user, ticket)
    return user.id in (ticket.requester_id, ticket.created_by_id)


def can_edit(user: User, ticket: Ticket) -> bool:
    if ticket.status in FINAL:
        return False
    if user.can_manage_tickets:
        return True
    if user.role == UserRole.TECHNICIAN:
        return ticket.assignee_id == user.id
    return False


def can_assign(user: User, ticket: Ticket) -> bool:
    return user.can_manage_tickets and ticket.status not in FINAL


def can_take(user: User, ticket: Ticket) -> bool:
    """Assumir a OS é coisa de analista/supervisor: o técnico recebe a OS atribuída."""
    return (
        user.can_manage_tickets
        and ticket.status in OPEN_STATUSES
        and ticket.assignee_id != user.id
        and (user.can_manage_tickets or ticket.assignee_id is None)
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
        # Sem responsável, só quem pode assumir a OS consegue (assume automaticamente).
        if (
            STATUS_INFO[to].requires_assignee
            and ticket.assignee_id is None
            and user.role not in SELF_ASSIGN_ROLES
        ):
            continue
        result.append(to)
    return result


def to_detail(ticket: Ticket, user: User) -> TicketDetail:
    detail = TicketDetail.model_validate(ticket)
    detail.allowed_transitions = allowed_transitions(user, ticket)
    detail.can_edit = can_edit(user, ticket)
    detail.can_assign = can_assign(user, ticket)
    if not user.is_staff:
        detail.expenses = []  # custo é interno
        detail.legacy = None  # dados de origem da migração: só a equipe
        detail.part_requests = []  # pedido de peça é conversa interna com o técnico
    else:
        for request in detail.part_requests:
            request.attachments = [
                PartRequestAttachment(id=att_id, url=attachment_url(att_id, user))
                for att_id in request.attachment_ids
            ]
    # Link do relatório: a gestão sempre; o técnico responsável, com a OS concluída, para enviar
    # ao cliente pelo app (WhatsApp).
    if user.can_manage_tickets or (
        ticket.assignee_id == user.id and ticket.status in client_report.FINISHED
    ):
        detail.report_link = client_report.link_out(ticket)
    if user.role == UserRole.TECHNICIAN:
        field_view(detail)
    return detail


def field_view(detail: TicketDetail) -> TicketDetail:
    """O técnico é terceiro: recebe só o necessário para a visita.

    Fica: cliente, local (nome e endereço da loja), agenda, escopo (título, descrição, tipo de
    serviço, recado), o fluxo de campo (status, chegada, permanência, autorização sim/não) e o
    próprio trabalho (formulários, fotos, assinatura, horas, peças, solução). Sai o que é da
    gestão: prazos e motivos de SLA, analista, equipe, projeto, etiquetas, solicitante, quem abriu,
    nº do chamado do cliente, detalhes da autorização, CNPJ e contato da loja (nome e telefone:
    quem fala com a loja é a central), reincidência e dados migrados.
    """
    blank: dict[str, Any] = {
        "owner": None,
        "team": None,
        "project": None,
        "category": None,
        "tags": [],
        "client_reference": None,
        "requester_name": None,
        "requester": None,
        "requester_contact": None,
        "created_by": None,
        "asset": None,
        "response_due_at": None,
        "resolution_due_at": None,
        "first_response_at": None,
        "sla_paused_at": None,
        "sla_paused_seconds": 0,
        "response_violation_reason": None,
        "resolution_violation_reason": None,
        "violation_note": None,
        "reopen_count": 0,
        "recurrence_30d": 0,
        "recurrence": None,
        "legacy": None,
        "authorized_by_name": None,
        "authorization_channel": None,
        "authorization_ref": None,
        "authorized_by": None,
        "authorized_at": None,
    }
    for key, value in blank.items():
        setattr(detail, key, value)
    if detail.location is not None:
        detail.location = detail.location.model_copy(
            update={"document": None, "contact_name": None, "contact_phone": None}
        )
    # Colegas da visita: só o nome (sem e-mail).
    detail.helpers = [h.model_copy(update={"email": ""}) for h in detail.helpers]
    if detail.assignee is not None:
        detail.assignee = detail.assignee.model_copy(update={"email": ""})
    for expense in detail.expenses:
        expense.created_by = None
    return detail


def attachment_url(attachment_id: uuid.UUID, user: User) -> str:
    """Link assinado de download de um anexo (válido por pouco tempo, para quem pediu)."""
    token = create_download_token(str(attachment_id), str(user.id))
    return f"{settings.API_PREFIX}/attachments/{attachment_id}/download?token={token}"


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


async def _resolve_violation_reason(
    db: AsyncSession, reason_id: uuid.UUID, scope: ViolationScope
) -> ViolationReason:
    reason = await db.get(ViolationReason, reason_id)
    if reason is None or not reason.is_active:
        raise WorkflowError("Motivo de violação não encontrado ou inativo")
    if reason.applies_to not in (scope, ViolationScope.BOTH):
        clock = "resposta" if scope == ViolationScope.RESPONSE else "solução"
        raise WorkflowError(f"O motivo '{reason.name}' não se aplica ao prazo de {clock}")
    return reason


async def _apply_violation(
    db: AsyncSession,
    ticket: Ticket,
    *,
    response_reason_id: uuid.UUID | None,
    resolution_reason_id: uuid.UUID | None,
    note: str | None,
) -> dict[str, list[Any]]:
    """Grava os motivos informados (valida o relógio) e devolve o que mudou."""
    changes: dict[str, list[Any]] = {}
    if response_reason_id is not None:
        await _resolve_violation_reason(db, response_reason_id, ViolationScope.RESPONSE)
        if ticket.response_violation_reason_id != response_reason_id:
            changes["response_violation_reason_id"] = [
                _jsonable(ticket.response_violation_reason_id),
                str(response_reason_id),
            ]
            ticket.response_violation_reason_id = response_reason_id
    if resolution_reason_id is not None:
        await _resolve_violation_reason(db, resolution_reason_id, ViolationScope.RESOLUTION)
        if ticket.resolution_violation_reason_id != resolution_reason_id:
            changes["resolution_violation_reason_id"] = [
                _jsonable(ticket.resolution_violation_reason_id),
                str(resolution_reason_id),
            ]
            ticket.resolution_violation_reason_id = resolution_reason_id
    if note is not None and (note.strip() or None) != ticket.violation_note:
        changes["violation_note"] = [ticket.violation_note, note.strip() or None]
        ticket.violation_note = note.strip() or None
    return changes


async def _resolve_service_type(
    db: AsyncSession, service_type_id: uuid.UUID, customer_id: uuid.UUID | None
) -> ServiceType:
    service_type = await db.get(ServiceType, service_type_id)
    if service_type is None or not service_type.is_active:
        raise WorkflowError("Tipo de serviço não encontrado ou inativo")
    if (
        service_type.customer_id is not None
        and customer_id is not None
        and service_type.customer_id != customer_id
    ):
        raise WorkflowError("Este tipo de serviço é do catálogo de outro cliente")
    return service_type


def _default_end(
    start: datetime | None, end: datetime | None, estimated_minutes: int | None
) -> datetime | None:
    """Sem fim informado, a visita dura o estimado pelo tipo de serviço."""
    if start is not None and end is None and estimated_minutes:
        return start + timedelta(minutes=estimated_minutes)
    return end


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

    # Duração real: soma os trechos em "Em atendimento" (o técnico não digita nada).
    if from_status == S.IN_PROGRESS and ticket.work_started_at is not None:
        ticket.work_seconds = durations.actual_seconds(
            ticket.work_seconds, ticket.work_started_at, now
        )
        ticket.work_started_at = None
    if to == S.IN_PROGRESS:
        ticket.work_started_at = now

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
        client_report.assign_on_finish(ticket, now)
    elif to == S.CLOSED:
        ticket.closed_at = now
        client_report.assign_on_finish(ticket, now)
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
            raise WorkflowError("Responsável inválido ou inativo")

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
    # Quem passa a responsável deixa de ser "outro técnico" da mesma visita.
    if assignee_id is not None and any(h.id == assignee_id for h in ticket.helpers):
        ticket.helpers = [h for h in ticket.helpers if h.id != assignee_id]
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
            _change_status(db, ticket, S.NEW, actor, now=now, note="Responsável removido")
    elif ticket.status in (S.NEW, S.TRIAGE, S.REOPENED):
        _change_status(db, ticket, S.ASSIGNED, actor, now=now)
    elif ticket.status in (S.EN_ROUTE, S.IN_PROGRESS) and prev_id not in (None, assignee_id):
        _change_status(db, ticket, S.ASSIGNED, actor, now=now, note="Troca de responsável")


OWNER_INVALID = "Escolha um analista ou gestor"


async def _owner_user(db: AsyncSession, owner_id: uuid.UUID) -> User:
    owner = await db.get(User, owner_id)
    if owner is None or not owner.is_active or not owner.can_manage_tickets:
        raise WorkflowError(OWNER_INVALID)
    return owner


async def _set_owner(
    db: AsyncSession,
    ticket: Ticket,
    owner_id: uuid.UUID | None,
    actor: User,
    *,
    now: datetime,
    note: str | None = None,
) -> bool:
    """Troca o analista responsável (a fila em que a OS aparece). Não mexe no técnico."""
    if ticket.owner_id == owner_id:
        return False
    owner = await _owner_user(db, owner_id) if owner_id is not None else None
    prev_id = ticket.owner_id
    prev = await db.get(User, prev_id) if prev_id is not None else None
    ticket.owner_id = owner_id
    data = {"from_name": prev.name if prev else None, "to_name": owner.name if owner else None}
    if note is None:
        if owner is not None and owner.id == actor.id:
            note = (
                f"{actor.name} puxou a OS de {prev.name}"
                if prev
                else f"{actor.name} puxou a OS para a própria fila"
            )
        elif owner is not None:
            note = f"OS passada para a fila de {owner.name}"
        else:
            note = "OS tirada da fila do analista"
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.OWNER_CHANGED,
        from_value=_jsonable(prev_id),
        to_value=_jsonable(owner_id),
        note=note,
        data=data,
        now=now,
    )
    queue_event(db, "updated", ticket, actor, {"fields": ["owner_id"], **data}, internal=True)
    return True


def _clean_text(value: str | None, *, single_line: bool = False) -> str | None:
    """Texto livre opcional: sem espaços nas pontas; vazio vira null."""
    if value is None:
        return None
    text = " ".join(value.split()) if single_line else value.strip()
    return text or None


async def _helper_users(
    db: AsyncSession, ids: list[uuid.UUID], assignee_id: uuid.UUID | None, actor: User
) -> list[User]:
    """Outros técnicos da visita: ativos, da equipe, sem repetir o responsável."""
    wanted = [i for i in dict.fromkeys(ids) if i != assignee_id]
    if not wanted:
        return []
    if not actor.can_manage_tickets:
        raise PermissionDenied("Só a gestão escolhe os outros técnicos da OS")
    found = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(wanted)))}
    for user_id in wanted:
        user = found.get(user_id)
        if user is None or not user.is_active or not user.is_staff:
            raise WorkflowError("Técnico auxiliar inválido ou inativo")
    return [found[i] for i in wanted]


async def _set_helpers(
    db: AsyncSession, ticket: Ticket, ids: list[uuid.UUID], actor: User, *, allow: bool
) -> bool:
    users = await _helper_users(db, ids, ticket.assignee_id, actor)
    before = {h.id: h for h in ticket.helpers}
    after = {u.id: u for u in users}
    added = [u for user_id, u in after.items() if user_id not in before]
    removed = [h for user_id, h in before.items() if user_id not in after]
    if not added and not removed:
        return False
    if added:
        # Quem entra na visita precisa estar livre no horário (como o responsável).
        await schedule.check_slot(
            db,
            actor,
            assignee_id=None,
            start=ticket.scheduled_start,
            end=ticket.scheduled_end,
            estimated_minutes=ticket.estimated_minutes,
            status=ticket.status,
            exclude_id=ticket.id,
            allow=allow,
            helper_ids=[u.id for u in added],
        )
    ticket.helpers = users
    now = utcnow()
    data = {"added": [u.name for u in added], "removed": [h.name for h in removed]}
    record_event(db, ticket, actor, TicketEventType.HELPERS_CHANGED, data=data, now=now)
    await _touch(db, ticket, now)
    queue_event(
        db,
        "helpers_changed",
        ticket,
        actor,
        {**data, "added_ids": [str(u.id) for u in added]},
        previous_helper_ids=[h.id for h in removed],
    )
    return True


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
    customer_id = refs["customer_id"]
    service_type: ServiceType | None = None
    if data.service_type_id is not None and not is_requester:
        service_type = await _resolve_service_type(db, data.service_type_id, customer_id)
        customer_id = customer_id or service_type.customer_id
        if category is None:
            category = service_type.category
    estimated_minutes = data.estimated_minutes if not is_requester else None
    if estimated_minutes is None and service_type is not None:
        estimated_minutes = service_type.estimated_minutes

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

    # Analista responsável: quem abre pela gestão assume a OS (vai para a fila dele), salvo
    # escolha de outro analista ou null explícito (fica sem analista, para alguém assumir).
    owner_id: uuid.UUID | None = None
    if actor.can_manage_tickets:
        if "owner_id" not in data.model_fields_set:
            owner_id = actor.id
        elif data.owner_id is not None:
            owner_id = (await _owner_user(db, data.owner_id)).id

    scheduled_start = None if is_requester else data.scheduled_start
    scheduled_end = None if is_requester else data.scheduled_end
    scheduled_end = _default_end(scheduled_start, scheduled_end, estimated_minutes)
    _check_schedule(scheduled_start, scheduled_end)
    helpers = await _helper_users(
        db, [] if is_requester else data.helper_ids, data.assignee_id, actor
    )
    # Antes de gravar: uma OS barrada por conflito não pode consumir número.
    await schedule.check_slot(
        db,
        actor,
        assignee_id=None if is_requester else data.assignee_id,
        start=scheduled_start,
        end=scheduled_end,
        estimated_minutes=estimated_minutes,
        status=S.NEW,
        exclude_id=None,
        allow=data.allow_conflict,
        helper_ids=[h.id for h in helpers],
    )

    # Autorização do cliente: com a regra ligada, a OS nasce aguardando (a gestão pode já
    # registrar a autorização na abertura, na correria do atendimento).
    rules = await field_rules.rules(db)
    if data.authorization is not None and not actor.can_manage_tickets:
        raise PermissionDenied("Só a gestão registra a autorização do cliente")
    authorization_status = (
        AuthorizationStatus.PENDING
        if rules.require_authorization
        else AuthorizationStatus.NOT_REQUIRED
    )

    ticket = Ticket(
        authorization_status=authorization_status,
        title=data.title.strip(),
        description=data.description,
        type=data.type,
        status=S.NEW,
        impact=data.impact,
        urgency=data.urgency,
        priority=priority,
        source=data.source,
        category_id=category.id if category else None,
        customer_id=customer_id,
        location_id=refs["location_id"],
        asset_id=refs["asset_id"],
        requester_id=requester_id,
        requester_name=requester_name,
        requester_contact=data.requester_contact,
        service_address=(data.service_address or "").strip() or None,
        client_reference=_clean_text(data.client_reference, single_line=True),
        visit_note=None if is_requester else _clean_text(data.visit_note),
        helpers=helpers,
        created_by_id=actor.id,
        owner_id=owner_id,
        team_id=team_id,
        project_id=await _check_project(db, data.project_id, actor),
        scheduled_start=scheduled_start,
        scheduled_end=scheduled_end,
        service_type_id=service_type.id if service_type else None,
        estimated_minutes=estimated_minutes,
        work_seconds=0,
        sla_paused_seconds=0,
        reopen_count=0,
        created_at=now,
        updated_at=now,
    )
    response_min, resolution_min = await sla.get_policy_minutes(db, priority)
    sla.set_due_dates(
        ticket, base=now, response_minutes=response_min, resolution_minutes=resolution_min
    )
    if data.authorization is not None:
        _apply_authorization(ticket, data.authorization, actor, now)
    await field_rules.recompute_arrival_due(db, ticket, rules)
    db.add(ticket)
    await db.flush()  # gera id e número

    created_data: dict[str, Any] = {"priority": priority.value, "source": data.source.value}
    if helpers:
        created_data["helpers"] = [h.name for h in helpers]
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.CREATED,
        to_value=S.NEW.value,
        data=created_data,
        now=now,
    )
    if data.authorization is not None:
        _record_authorization_event(
            db, ticket, actor, authorization_status, data.authorization, now=now
        )
    queue_event(db, "created", ticket, actor, {"title": ticket.title})
    if helpers:
        # Avisa (push) quem vai junto na visita.
        queue_event(
            db,
            "helpers_changed",
            ticket,
            actor,
            {
                "added": [h.name for h in helpers],
                "removed": [],
                "added_ids": [str(h.id) for h in helpers],
            },
        )

    if data.assignee_id is not None and not is_requester:
        if not actor.can_manage_tickets and data.assignee_id != actor.id:
            raise PermissionDenied("Técnicos só podem atribuir a OS a si mesmos")
        await _assign(db, ticket, data.assignee_id, None, actor, now=now)
    return ticket


async def update_ticket(
    db: AsyncSession, ticket: Ticket, data: TicketUpdate, actor: User
) -> Ticket:
    if not can_edit(actor, ticket):
        raise PermissionDenied("Você não pode editar esta OS")
    check_version(ticket, data.expected_version)
    fields = data.model_dump(exclude_unset=True, exclude={"expected_version", "allow_conflict"})
    # Analista responsável: evento próprio (a fila muda), validado antes de qualquer alteração.
    owner_change = "owner_id" in fields
    new_owner_id = fields.pop("owner_id", None)
    if owner_change:
        if not actor.can_manage_tickets:
            raise PermissionDenied("Só a gestão troca o analista responsável")
        if new_owner_id is not None:
            await _owner_user(db, new_owner_id)
    # Outros técnicos da visita: lista completa, com evento próprio (null = não mexe).
    new_helper_ids = fields.pop("helper_ids", None)
    if new_helper_ids is not None and not actor.can_manage_tickets:
        raise PermissionDenied("Só a gestão escolhe os outros técnicos da OS")
    for key in ("client_reference", "visit_note"):
        if key in fields:
            fields[key] = _clean_text(fields[key], single_line=key == "client_reference")
    if "project_id" in fields:
        await _check_project(db, fields["project_id"], actor)
    if "signature_required" in fields:
        if not actor.can_manage_tickets:
            raise PermissionDenied("Só a gestão decide se a OS exige assinatura")
        if fields["signature_required"] is None:
            fields.pop("signature_required")
    if not fields:
        if owner_change:
            await _set_owner(db, ticket, new_owner_id, actor, now=utcnow())
        if new_helper_ids is not None:
            await _set_helpers(db, ticket, new_helper_ids, actor, allow=data.allow_conflict)
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

    if fields.get("service_type_id") is not None:
        service_type = await _resolve_service_type(
            db, fields["service_type_id"], fields.get("customer_id", ticket.customer_id)
        )
        # Trocar o tipo traz a estimativa dele, a menos que outra tenha sido informada.
        if "estimated_minutes" not in fields:
            fields["estimated_minutes"] = service_type.estimated_minutes

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
    if owner_change:
        await _set_owner(db, ticket, new_owner_id, actor, now=utcnow())
    if new_helper_ids is not None:
        await _set_helpers(db, ticket, new_helper_ids, actor, allow=data.allow_conflict)
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
    # Trocou o local antes da chegada: o prazo segue a nova cidade (capital ou interior).
    if "location_id" in changes and ticket.arrived_at is None:
        await field_rules.recompute_arrival_due(db, ticket, await field_rules.rules(db))

    now = utcnow()
    if changes.keys() & {"scheduled_start", "scheduled_end", "estimated_minutes"}:
        await schedule.ensure_no_conflict(db, ticket, actor, data.allow_conflict)
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
    allow_conflict: bool = False,
) -> Ticket:
    if not can_assign(actor, ticket):
        raise PermissionDenied("Somente analistas e supervisores atribuem OS")
    check_version(ticket, expected_version)
    previous = ticket.assignee_id
    await _assign(db, ticket, assignee_id, team_id, actor, now=utcnow(), note=note)
    if ticket.assignee_id != previous:
        await schedule.ensure_no_conflict(db, ticket, actor, allow_conflict)
    return ticket


async def take_ticket(db: AsyncSession, ticket: Ticket, actor: User) -> Ticket:
    if not can_take(actor, ticket):
        raise PermissionDenied("Esta OS não pode ser assumida por você")
    now = utcnow()
    await _assign(db, ticket, actor.id, None, actor, now=now, note="Assumida pelo próprio usuário")
    # Quem assume leva a OS para a própria fila (mesmo que estivesse na de outro analista).
    if ticket.owner_id != actor.id:
        await _set_owner(db, ticket, actor.id, actor, now=now)
    return ticket


async def claim_ticket(db: AsyncSession, ticket: Ticket, actor: User) -> Ticket:
    """Puxar para a minha fila: vira o analista responsável (o técnico continua o mesmo)."""
    if not actor.can_manage_tickets:
        raise PermissionDenied("Só analistas e gestores têm fila de OS")
    if ticket.owner_id == actor.id:
        raise WorkflowError("Esta OS já está na sua fila")
    if ticket.status not in OPEN_STATUSES:
        raise WorkflowError("Só uma OS em aberto pode ser puxada para a sua fila")
    await _set_owner(db, ticket, actor.id, actor, now=utcnow())
    return ticket


def _ensure_forms_and_signature(ticket: Ticket) -> None:
    """Concluir a OS exige os formulários obrigatórios concluídos e, se pedida, a assinatura."""
    pending = [f.name for f in ticket.forms if f.required and f.status != FormStatus.COMPLETED]
    if pending:
        raise WorkflowError("Conclua o formulário obrigatório antes: " + ", ".join(pending))
    if ticket.signature_required and ticket.signed_at is None:
        raise WorkflowError("Colete a assinatura do responsável no local antes de concluir a OS")


# --------------------------------------------------------------------------- autorização do cliente

AUTHORIZATION_BLOCKED = "Aguardando autorização do cliente para a visita"
_BLOCKED_AUTH = (AuthorizationStatus.PENDING, AuthorizationStatus.DENIED)


def _is_field_visit(ticket: Ticket, to: TicketStatus, actor: User) -> bool:
    """Ir ao local é visita (cobrada). Atendimento remoto do analista não é visita."""
    if to == S.EN_ROUTE:
        return True
    if to != S.IN_PROGRESS:
        return False
    if actor.role == UserRole.TECHNICIAN:
        return True
    return ticket.assignee is not None and ticket.assignee.role == UserRole.TECHNICIAN


def _ensure_visit_authorized(
    ticket: Ticket, to: TicketStatus, actor: User, rules: FieldRules
) -> None:
    """Com a regra ligada, o técnico só sai (ou começa na loja) com a autorização do cliente."""
    if (
        rules.require_authorization
        and ticket.authorization_status in _BLOCKED_AUTH
        and ticket.status != to
        and _is_field_visit(ticket, to, actor)
    ):
        raise WorkflowError(AUTHORIZATION_BLOCKED)


def _apply_authorization(
    ticket: Ticket, data: TicketAuthorizationIn, actor: User, now: datetime
) -> None:
    new = AuthorizationStatus(data.status)
    if new == AuthorizationStatus.AUTHORIZED:
        # Corrigir quem autorizou não reinicia o relógio de chegada.
        if (
            ticket.authorization_status != AuthorizationStatus.AUTHORIZED
            or not ticket.authorized_at
        ):
            ticket.authorized_at = now
    else:
        ticket.authorized_at = None
    ticket.authorization_status = new
    if new == AuthorizationStatus.PENDING:
        ticket.authorized_by_name = None
        ticket.authorization_channel = None
        ticket.authorization_ref = None
        ticket.authorized_by_id = None
        return
    ticket.authorized_by_name = " ".join((data.by_name or "").split()) or ticket.authorized_by_name
    if data.channel is not None:
        ticket.authorization_channel = data.channel.value
    if data.reference is not None:
        ticket.authorization_ref = data.reference.strip() or None
    ticket.authorized_by_id = actor.id


def _record_authorization_event(
    db: AsyncSession,
    ticket: Ticket,
    actor: User,
    previous: AuthorizationStatus,
    data: TicketAuthorizationIn,
    *,
    now: datetime,
) -> None:
    payload = {
        "status": ticket.authorization_status.value,
        "by_name": ticket.authorized_by_name,
        "channel": ticket.authorization_channel,
        "reference": ticket.authorization_ref,
    }
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.AUTHORIZATION_RECORDED,
        from_value=previous.value,
        to_value=ticket.authorization_status.value,
        note=data.note,
        data=payload,
        now=now,
    )
    queue_event(db, "authorization", ticket, actor, payload, internal=True)


async def record_authorization(
    db: AsyncSession, ticket: Ticket, data: TicketAuthorizationIn, actor: User
) -> Ticket:
    """Registra a autorização do cliente (ou a recusa) e liga o relógio de chegada."""
    if not actor.can_manage_tickets:
        raise PermissionDenied("Só a gestão registra a autorização do cliente")
    if ticket.status in FINAL:
        raise WorkflowError("OS encerrada não recebe autorização")
    now = utcnow()
    previous = ticket.authorization_status
    _apply_authorization(ticket, data, actor, now)
    await field_rules.recompute_arrival_due(db, ticket, await field_rules.rules(db))
    _record_authorization_event(db, ticket, actor, previous, data, now=now)
    return ticket


# --------------------------------------------------------------------------- reincidência

RECURRENCE_WINDOW = timedelta(days=30)


async def recurrence_counts(
    db: AsyncSession, tickets: list[Ticket], now: datetime | None = None
) -> dict[uuid.UUID, int]:
    """Outras OS no mesmo local nos últimos 30 dias, para uma página inteira (uma consulta)."""
    since = (now or utcnow()) - RECURRENCE_WINDOW
    location_ids = {t.location_id for t in tickets if t.location_id is not None}
    if not location_ids:
        return {}
    rows = await db.execute(
        select(Ticket.location_id, func.count())
        .where(Ticket.location_id.in_(location_ids), Ticket.created_at >= since)
        .group_by(Ticket.location_id)
    )
    per_location: dict[uuid.UUID, int] = {loc: n for loc, n in rows.all()}
    return {
        t.id: max(0, per_location.get(t.location_id, 0) - (1 if t.created_at >= since else 0))
        for t in tickets
        if t.location_id is not None
    }


async def recurrence_for(
    db: AsyncSession, ticket: Ticket, now: datetime | None = None
) -> TicketRecurrence:
    since = (now or utcnow()) - RECURRENCE_WINDOW
    if ticket.location_id is None:
        return TicketRecurrence(count_30d=0, previous=[])
    same_place = (
        Ticket.location_id == ticket.location_id,
        Ticket.id != ticket.id,
        Ticket.created_at >= since,
    )
    count = await db.scalar(select(func.count()).where(*same_place)) or 0
    rows = await db.execute(
        select(Ticket.id, Ticket.number, Ticket.title, Ticket.status, Ticket.created_at)
        .where(*same_place)
        .order_by(Ticket.created_at.desc())
        .limit(5)
    )
    return TicketRecurrence(
        count_30d=count, previous=[RecurrenceItem.model_validate(r) for r in rows.all()]
    )


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
    rules = await field_rules.rules(db)
    _ensure_visit_authorized(ticket, to, actor, rules)

    if payload.scheduled_start is not None:
        ticket.scheduled_start = payload.scheduled_start
        # Novo início sem fim: o fim vem da estimativa (e não sobra o fim de um agendamento antigo).
        ticket.scheduled_end = _default_end(
            payload.scheduled_start, payload.scheduled_end, ticket.estimated_minutes
        )
    elif payload.scheduled_end is not None:
        ticket.scheduled_end = payload.scheduled_end
    _check_schedule(ticket.scheduled_start, ticket.scheduled_end)

    auto_assign = (
        actor.role in SELF_ASSIGN_ROLES
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
    if to in (S.RESOLVED, S.CLOSED) and ticket.status not in (S.RESOLVED, S.CLOSED):
        _ensure_forms_and_signature(ticket)
    if auto_assign:
        await _assign(db, ticket, actor.id, None, actor, now=now, note="Assumida ao mudar o status")
        if ticket.owner_id is None:
            await _set_owner(db, ticket, actor.id, actor, now=now)

    # Motivo da violação informado junto (normalmente ao resolver uma OS que furou o prazo).
    await _apply_violation(
        db,
        ticket,
        response_reason_id=payload.response_violation_reason_id,
        resolution_reason_id=payload.resolution_violation_reason_id,
        note=payload.violation_note,
    )

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
        if to == S.IN_PROGRESS:
            field_rules.on_arrival(ticket, rules, now)  # primeira chegada: conta o tempo na loja
    if payload.scheduled_start or payload.scheduled_end or auto_assign:
        await schedule.ensure_no_conflict(db, ticket, actor, payload.allow_conflict)
    return ticket


async def add_comment(
    db: AsyncSession, ticket: Ticket, data: CommentCreate, actor: User
) -> TicketComment:
    if ticket.status in FINAL and not actor.can_manage_tickets:
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
    # Os outros técnicos da visita também apontam as horas deles.
    helper_can = ticket.status not in FINAL and is_helper(actor, ticket)
    if not (actor.is_staff and (can_edit(actor, ticket) or helper_can)):
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


def _clean_description(description: str | None) -> str | None:
    text = (description or "").strip()
    if len(text) > 500:
        raise WorkflowError("A descrição do anexo tem no máximo 500 caracteres")
    return text or None


async def add_attachment(
    db: AsyncSession,
    ticket: Ticket,
    upload: UploadFile,
    kind: str,
    actor: User,
    description: str | None = None,
) -> TicketAttachment:
    if ticket.status in FINAL and not actor.can_manage_tickets:
        raise WorkflowError("OS encerrada não recebe anexos")
    if kind not in ("file", "photo", "signature"):
        raise WorkflowError("kind deve ser file, photo ou signature")
    caption = _clean_description(description)
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
        description=caption,
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


async def update_attachment(
    db: AsyncSession,
    ticket: Ticket,
    attachment: TicketAttachment,
    description: str | None,
    actor: User,
) -> TicketAttachment:
    """Descrição (legenda) do anexo: a gestão em qualquer anexo; o técnico só nos que enviou."""
    if not (actor.can_manage_tickets or attachment.uploaded_by_id == actor.id):
        raise PermissionDenied("Você não pode editar este anexo")
    now = utcnow()
    attachment.description = _clean_description(description)
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.ATTACHMENT_UPDATED,
        data={"attachment_id": str(attachment.id), "filename": attachment.filename},
        now=now,
    )
    await _touch(db, ticket, now)
    queue_event(db, "attachment_updated", ticket, actor, {"filename": attachment.filename})
    await db.flush()
    return attachment


async def remove_attachment(
    db: AsyncSession, ticket: Ticket, attachment: TicketAttachment, actor: User
) -> None:
    """Exclui o anexo (só analistas e gestores). A assinatura do responsável fica protegida."""
    if not actor.can_manage_tickets:
        raise PermissionDenied("Só analistas e gestores excluem anexos")
    if ticket.signature_attachment_id == attachment.id:
        raise WorkflowError("A assinatura do responsável não pode ser excluída")
    now = utcnow()
    key = attachment.storage_key
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.ATTACHMENT_REMOVED,
        data={"filename": attachment.filename, "kind": attachment.kind},
        now=now,
    )
    await db.delete(attachment)
    await _touch(db, ticket, now)
    queue_event(db, "attachment_removed", ticket, actor, {"filename": attachment.filename})
    await db.flush()
    if key:
        storage.delete(key)


async def set_violation(
    db: AsyncSession, ticket: Ticket, data: TicketViolationUpdate, actor: User
) -> Ticket:
    """Justifica a violação de SLA. Vale com a OS fechada (é quando o analista revisa)."""
    allowed = actor.can_manage_tickets or (
        actor.role == UserRole.TECHNICIAN and ticket.assignee_id == actor.id
    )
    if not allowed:
        raise PermissionDenied("Você não pode justificar a violação desta OS")
    changes = await _apply_violation(
        db,
        ticket,
        response_reason_id=data.response_violation_reason_id,
        resolution_reason_id=data.resolution_violation_reason_id,
        note=data.violation_note,
    )
    if changes:
        now = utcnow()
        record_event(db, ticket, actor, TicketEventType.UPDATED, data={"changes": changes}, now=now)
        queue_event(db, "updated", ticket, actor, {"fields": sorted(changes)})
    return ticket


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


def violation_pending_clause(now: datetime) -> ColumnElement[bool]:
    """Resolvida/fechada com prazo violado e sem o motivo correspondente."""
    response_late = or_(
        Ticket.first_response_at > Ticket.response_due_at,
        and_(Ticket.first_response_at.is_(None), Ticket.response_due_at < now),
    )
    return and_(
        Ticket.status.in_((S.RESOLVED, S.CLOSED)),
        or_(
            and_(response_late, Ticket.response_violation_reason_id.is_(None)),
            and_(
                Ticket.resolved_at > Ticket.resolution_due_at,
                Ticket.resolution_violation_reason_id.is_(None),
            ),
        ),
    )


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
    if f.project_id:
        conds.append(Ticket.project_id == f.project_id)
    if f.customer_id:
        conds.append(Ticket.customer_id == f.customer_id)
    if f.location_id:
        conds.append(Ticket.location_id == f.location_id)
    if f.service_type_id:
        conds.append(Ticket.service_type_id == f.service_type_id)
    if f.asset_id:
        conds.append(Ticket.asset_id == f.asset_id)
    if f.category_id:
        subcats = select(Category.id).where(
            or_(Category.id == f.category_id, Category.parent_id == f.category_id)
        )
        conds.append(Ticket.category_id.in_(subcats))
    if f.owner_id:
        conds.append(Ticket.owner_id == f.owner_id)
    if f.no_owner:
        conds.append(Ticket.owner_id.is_(None))
    if f.mine:
        if user.can_manage_tickets:
            # Do analista: as que ele executa e as da fila dele (responsável).
            conds.append(or_(Ticket.assignee_id == user.id, Ticket.owner_id == user.id))
        elif user.is_staff:
            conds.append(schedule.works_on(user.id))
        else:
            conds.append(Ticket.requester_id == user.id)
    if f.unassigned:
        conds.append(Ticket.assignee_id.is_(None))
    if f.sla_breached:
        conds.append(breached_clause(now))
    if f.violation_pending:
        conds.append(violation_pending_clause(now))
    if f.q and f.q.strip():
        q = f.q.strip()
        like = f"%{q}%"
        text_match = [
            Ticket.title.ilike(like),
            Ticket.description.ilike(like),
            Ticket.requester_name.ilike(like),
            Ticket.client_reference.ilike(like),
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


# ------------------------------------------------------------------ improdutiva

UNPRODUCTIVE_FROM = (S.ASSIGNED, S.SCHEDULED, S.EN_ROUTE, S.IN_PROGRESS)


async def register_unproductive(
    db: AsyncSession, ticket: Ticket, payload: TicketUnproductive, actor: User
) -> Ticket:
    """O técnico foi e não atendeu (cliente ausente, sem acesso...). A OS volta para
    "Atribuído" sem agenda, para ser reagendada, e a ocorrência fica contada e no histórico."""
    check_version(ticket, payload.expected_version)
    is_assignee = actor.role == UserRole.TECHNICIAN and ticket.assignee_id == actor.id
    if not (actor.can_manage_tickets or is_assignee):
        raise PermissionDenied("Só o técnico responsável ou a gestão registra a visita improdutiva")
    if ticket.status not in UNPRODUCTIVE_FROM:
        raise WorkflowError(
            "Só uma OS atribuída, agendada, em deslocamento ou em atendimento "
            "tem visita improdutiva"
        )
    reason = await db.get(UnproductiveReason, payload.reason_id)
    if reason is None or not reason.is_active:
        raise WorkflowError("Motivo de visita improdutiva inválido")
    now = utcnow()
    data: dict[str, Any] = {
        "reason_id": str(reason.id),
        "reason": reason.name,
        "responsibility": reason.responsibility.value,
        "from_status": ticket.status.value,
    }
    if ticket.scheduled_start is not None:
        data["previous_schedule"] = ticket.scheduled_start.isoformat()
    if payload.latitude is not None and payload.longitude is not None:
        data.update(latitude=payload.latitude, longitude=payload.longitude)
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.UNPRODUCTIVE_VISIT,
        from_value=ticket.status.value,
        to_value=reason.name[:64],
        note=payload.note,
        data=data,
        now=now,
    )
    ticket.unproductive_count = (ticket.unproductive_count or 0) + 1
    ticket.last_unproductive_at = now
    ticket.scheduled_start = None
    ticket.scheduled_end = None
    if ticket.status != S.ASSIGNED:
        _change_status(
            db,
            ticket,
            S.ASSIGNED,
            actor,
            now=now,
            note=f"Visita improdutiva: {reason.name}",
            data={"unproductive": True},
        )
    else:
        queue_event(db, "updated", ticket, actor, {"fields": ["unproductive"]})
    return ticket


async def _check_project(
    db: AsyncSession, project_id: uuid.UUID | None, actor: User
) -> uuid.UUID | None:
    """Marcar a OS como de projeto é decisão da gestão (muda valores e equipe)."""
    if project_id is None:
        return None
    if not actor.can_manage_tickets:
        raise PermissionDenied("Só a gestão vincula a OS a um projeto")
    if await db.get(Project, project_id) is None:
        raise WorkflowError("Projeto não encontrado")
    return project_id

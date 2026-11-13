import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, NoTechnicianUser, StaffUser, TicketManagerUser
from app.core.config import settings
from app.core.enums import TicketPriority, TicketStatus, TicketType, UserRole
from app.core.security import InvalidToken, create_download_token, decode_token
from app.models import Ticket, TicketAttachment, TicketComment, TicketEvent, TicketWorklog, User
from app.schemas.common import Page
from app.schemas.ticket import (
    AttachmentOut,
    AttachmentUpdate,
    CommentCreate,
    CommentOut,
    EventOut,
    TicketAssign,
    TicketCreate,
    TicketDetail,
    TicketFilters,
    TicketListItem,
    TicketTimesIn,
    TicketTransition,
    TicketUnproductive,
    TicketUpdate,
    TicketViolationUpdate,
    WorklogCreate,
    WorklogOut,
)
from app.services import storage
from app.services import tickets as svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["tickets"])

# Eventos que o solicitante não vê no histórico.
_INTERNAL_EVENT_TYPES = {
    "worklog_added",
    "expense_added",
    "expense_updated",
    "expense_removed",
    "quote_sent",
    "owner_changed",
    "authorization_recorded",
    "part_requested",
    "part_request_updated",
    "attachment_removed",
    "times_corrected",
}


async def _with_recurrence(db: DB, ticket: Ticket, user: User) -> TicketDetail:
    detail = svc.to_detail(ticket, user)
    # Reincidência (outras OS no local) é da gestão; o técnico só vê a OS dele.
    if user.can_manage_tickets:
        detail.recurrence = await svc.recurrence_for(db, ticket)
    return detail


async def _detail(db: DB, ticket_id: uuid.UUID, user: User) -> TicketDetail:
    return await _with_recurrence(db, await svc.get_ticket(db, ticket_id), user)


@router.get("/tickets", response_model=Page[TicketListItem])
async def list_tickets(
    db: DB,
    user: NoTechnicianUser,
    status_: Annotated[list[TicketStatus] | None, Query(alias="status")] = None,
    priority: Annotated[list[TicketPriority] | None, Query()] = None,
    type_: Annotated[TicketType | None, Query(alias="type")] = None,
    assignee_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    customer_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    service_type_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    owner_id: uuid.UUID | None = None,
    no_owner: bool = False,
    q: str | None = None,
    mine: bool = False,
    unassigned: bool = False,
    open_only: bool = False,
    sla_breached: bool = False,
    violation_pending: bool = False,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=500)] = 25,
    order_by: str = "-updated_at",
) -> Page[TicketListItem]:
    filters = TicketFilters(
        status=status_,
        priority=priority,
        type=type_,
        assignee_id=assignee_id,
        team_id=team_id,
        customer_id=customer_id,
        location_id=location_id,
        service_type_id=service_type_id,
        category_id=category_id,
        asset_id=asset_id,
        project_id=project_id,
        owner_id=owner_id,
        no_owner=no_owner,
        q=q,
        mine=mine,
        unassigned=unassigned,
        open_only=open_only,
        sla_breached=sla_breached,
        violation_pending=violation_pending,
    )
    items, total = await svc.list_tickets(
        db, user, filters, page=page, page_size=page_size, order_by=order_by
    )
    recurrence = await svc.recurrence_counts(db, list(items))
    page_items = []
    for t in items:
        item = TicketListItem.model_validate(t)
        item.recurrence_30d = recurrence.get(t.id, 0)
        page_items.append(item)
    return Page(
        items=page_items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/tickets", response_model=TicketDetail, status_code=status.HTTP_201_CREATED)
async def create_ticket(body: TicketCreate, db: DB, user: NoTechnicianUser) -> TicketDetail:
    ticket = await svc.create_ticket(db, body, user)
    await commit_and_publish(db)
    return await _detail(db, ticket.id, user)


@router.get("/tickets/{ticket_id}", response_model=TicketDetail)
async def get_ticket(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> TicketDetail:
    return await _with_recurrence(db, await svc.get_visible_ticket(db, user, ticket_id), user)


@router.patch("/tickets/{ticket_id}", response_model=TicketDetail)
async def update_ticket(
    ticket_id: uuid.UUID, body: TicketUpdate, db: DB, user: CurrentUser
) -> TicketDetail:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.update_ticket(db, ticket, body, user)
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


@router.post("/tickets/{ticket_id}/assign", response_model=TicketDetail)
async def assign_ticket(
    ticket_id: uuid.UUID, body: TicketAssign, db: DB, user: CurrentUser
) -> TicketDetail:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.assign_ticket(
        db,
        ticket,
        assignee_id=body.assignee_id,
        team_id=body.team_id,
        note=body.note,
        expected_version=body.expected_version,
        actor=user,
        allow_conflict=body.allow_conflict,
    )
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


@router.post("/tickets/{ticket_id}/take", response_model=TicketDetail)
async def take_ticket(ticket_id: uuid.UUID, db: DB, user: StaffUser) -> TicketDetail:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.take_ticket(db, ticket, user)
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


@router.post("/tickets/{ticket_id}/claim", response_model=TicketDetail)
async def claim_ticket(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> TicketDetail:
    """Puxar a OS para a minha fila (vira o analista responsável; o técnico não muda)."""
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.claim_ticket(db, ticket, user)
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


@router.patch("/tickets/{ticket_id}/violation", response_model=TicketDetail)
async def justify_violation(
    ticket_id: uuid.UUID, body: TicketViolationUpdate, db: DB, user: CurrentUser
) -> TicketDetail:
    """Motivo da violação de SLA (resposta e/ou solução), inclusive com a OS fechada."""
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.set_violation(db, ticket, body, user)
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


@router.post("/tickets/{ticket_id}/transition", response_model=TicketDetail)
async def transition_ticket(
    ticket_id: uuid.UUID, body: TicketTransition, db: DB, user: CurrentUser
) -> TicketDetail:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.transition_ticket(db, ticket, body, user)
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


@router.put("/tickets/{ticket_id}/times", response_model=TicketDetail)
async def correct_times(
    ticket_id: uuid.UUID, body: TicketTimesIn, db: DB, user: TicketManagerUser
) -> TicketDetail:
    """Corrige os horários reais (saída, início, término, tempo de atendimento): só a central."""
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.correct_times(db, ticket, body, user)
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


# ------------------------------------------------------------------ acompanhamentos


@router.get("/tickets/{ticket_id}/comments", response_model=list[CommentOut])
async def list_comments(
    ticket_id: uuid.UUID, db: DB, user: NoTechnicianUser
) -> list[TicketComment]:
    await svc.get_visible_ticket(db, user, ticket_id)
    stmt = select(TicketComment).where(TicketComment.ticket_id == ticket_id)
    if not user.is_staff:
        stmt = stmt.where(TicketComment.is_internal.is_(False))
    return list(await db.scalars(stmt.order_by(TicketComment.created_at)))


@router.post(
    "/tickets/{ticket_id}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_comment(
    ticket_id: uuid.UUID, body: CommentCreate, db: DB, user: NoTechnicianUser
) -> TicketComment:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    comment = await svc.add_comment(db, ticket, body, user)
    await commit_and_publish(db)
    return await db.get(TicketComment, comment.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/tickets/{ticket_id}/events", response_model=list[EventOut])
async def list_events(ticket_id: uuid.UUID, db: DB, user: NoTechnicianUser) -> list[TicketEvent]:
    await svc.get_visible_ticket(db, user, ticket_id)
    events = list(
        await db.scalars(
            select(TicketEvent)
            .where(TicketEvent.ticket_id == ticket_id)
            .order_by(TicketEvent.created_at.desc())
        )
    )
    if user.is_staff:
        return events
    return [
        e
        for e in events
        if e.event_type.value not in _INTERNAL_EVENT_TYPES and not (e.data or {}).get("internal")
    ]


# ------------------------------------------------------------------ apontamentos


@router.get("/tickets/{ticket_id}/worklogs", response_model=list[WorklogOut])
async def list_worklogs(ticket_id: uuid.UUID, db: DB, user: StaffUser) -> list[TicketWorklog]:
    await svc.get_visible_ticket(db, user, ticket_id)
    stmt = select(TicketWorklog).where(TicketWorklog.ticket_id == ticket_id)
    if user.role == UserRole.TECHNICIAN:
        stmt = stmt.where(TicketWorklog.user_id == user.id)  # só as horas dele
    return list(await db.scalars(stmt.order_by(TicketWorklog.started_at)))


@router.post(
    "/tickets/{ticket_id}/worklogs",
    response_model=WorklogOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_worklog(
    ticket_id: uuid.UUID, body: WorklogCreate, db: DB, user: StaffUser
) -> TicketWorklog:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    worklog = await svc.add_worklog(db, ticket, body, user)
    await commit_and_publish(db)
    return await db.get(TicketWorklog, worklog.id, populate_existing=True)  # type: ignore[return-value]


# ------------------------------------------------------------------ anexos


def _attachment_out(attachment: TicketAttachment, user: User) -> AttachmentOut:
    out = AttachmentOut.model_validate(attachment)
    if user.role == UserRole.TECHNICIAN and out.uploaded_by is not None:
        out.uploaded_by = out.uploaded_by.model_copy(update={"email": ""})
    if attachment.external_url:
        # Arquivo migrado que ainda está no armazenamento de origem (Field Control).
        out.download_url = attachment.external_url
        out.external = True
        return out
    token = create_download_token(str(attachment.id), str(user.id))
    out.download_url = f"{settings.API_PREFIX}/attachments/{attachment.id}/download?token={token}"
    return out


@router.get("/tickets/{ticket_id}/attachments", response_model=list[AttachmentOut])
async def list_attachments(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> list[AttachmentOut]:
    await svc.get_visible_ticket(db, user, ticket_id)
    rows = await db.scalars(
        select(TicketAttachment)
        .where(TicketAttachment.ticket_id == ticket_id)
        .order_by(TicketAttachment.created_at)
    )
    return [_attachment_out(a, user) for a in rows if svc.attachment_visible(a, user)]


@router.post(
    "/tickets/{ticket_id}/attachments",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    ticket_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    kind: Annotated[str, Form()] = "file",
    description: Annotated[str | None, Form()] = None,
) -> AttachmentOut:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    attachment = await svc.add_attachment(db, ticket, file, kind, user, description=description)
    await commit_and_publish(db)
    loaded = await db.get(TicketAttachment, attachment.id, populate_existing=True)
    return _attachment_out(loaded, user)  # type: ignore[arg-type]


async def _attachment_with_ticket(
    db: DB, user: User, attachment_id: uuid.UUID
) -> tuple[Ticket, TicketAttachment]:
    attachment = await db.get(TicketAttachment, attachment_id)
    if attachment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Anexo não encontrado")
    ticket = await svc.get_visible_ticket(db, user, attachment.ticket_id)
    return ticket, attachment


@router.patch("/attachments/{attachment_id}", response_model=AttachmentOut)
async def update_attachment(
    attachment_id: uuid.UUID, body: AttachmentUpdate, db: DB, user: StaffUser
) -> AttachmentOut:
    """Legenda do anexo (a gestão em qualquer um; o técnico nos que ele enviou)."""
    ticket, attachment = await _attachment_with_ticket(db, user, attachment_id)
    await svc.update_attachment(db, ticket, attachment, body.description, user)
    await commit_and_publish(db)
    loaded = await db.get(TicketAttachment, attachment_id, populate_existing=True)
    return _attachment_out(loaded, user)  # type: ignore[arg-type]


@router.delete("/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_attachment(attachment_id: uuid.UUID, db: DB, user: TicketManagerUser) -> None:
    """Exclui o anexo (analistas e gestores). A assinatura do responsável não sai."""
    ticket, attachment = await _attachment_with_ticket(db, user, attachment_id)
    await svc.remove_attachment(db, ticket, attachment, user)
    await commit_and_publish(db)


@router.get("/attachments/{attachment_id}/download", include_in_schema=True, response_model=None)
async def download_attachment(
    attachment_id: uuid.UUID, token: str, db: DB
) -> FileResponse | RedirectResponse:
    """Link assinado (gerado na listagem) para `<img src>` e downloads sem header."""
    try:
        payload = decode_token(token, "download")
    except InvalidToken as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link expirado") from exc
    if payload.get("sub") != str(attachment_id):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link inválido")
    attachment = await db.get(TicketAttachment, attachment_id)
    if attachment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Anexo não encontrado")
    if attachment.external_url:
        # Migrado e ainda no armazenamento de origem: o link interno leva até lá.
        return RedirectResponse(
            attachment.external_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT
        )
    if not attachment.storage_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo não encontrado")
    try:
        path = storage.open_path(attachment.storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo não encontrado") from exc
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo não encontrado")
    # Foto abre na tela; o resto baixa. SVG pode carregar script: baixa também. E nada que o
    # navegador abrir daqui roda código (nosniff + CSP sandbox), mesmo um HTML disfarçado.
    content_type = attachment.content_type or "application/octet-stream"
    inline = content_type.startswith("image/") and "svg" not in content_type
    return FileResponse(
        path,
        media_type=content_type,
        filename=attachment.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; sandbox",
        },
    )


@router.post("/tickets/{ticket_id}/unproductive", response_model=TicketDetail)
async def register_unproductive(
    ticket_id: uuid.UUID, body: TicketUnproductive, db: DB, user: CurrentUser
) -> TicketDetail:
    """Visita improdutiva: a OS volta para "Atribuído", sem agenda, para reagendar."""
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.register_unproductive(db, ticket, body, user)
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)

import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, StaffUser
from app.core.config import settings
from app.core.enums import TicketPriority, TicketStatus, TicketType
from app.core.security import InvalidToken, create_download_token, decode_token
from app.models import TicketAttachment, TicketComment, TicketEvent, TicketWorklog, User
from app.schemas.common import Page
from app.schemas.ticket import (
    AttachmentOut,
    CommentCreate,
    CommentOut,
    EventOut,
    TicketAssign,
    TicketCreate,
    TicketDetail,
    TicketFilters,
    TicketListItem,
    TicketTransition,
    TicketUpdate,
    WorklogCreate,
    WorklogOut,
)
from app.services import storage
from app.services import tickets as svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["tickets"])

# Eventos que o solicitante não vê no histórico.
_INTERNAL_EVENT_TYPES = {"worklog_added"}


async def _detail(db: DB, ticket_id: uuid.UUID, user: User) -> TicketDetail:
    return svc.to_detail(await svc.get_ticket(db, ticket_id), user)


@router.get("/tickets", response_model=Page[TicketListItem])
async def list_tickets(
    db: DB,
    user: CurrentUser,
    status_: Annotated[list[TicketStatus] | None, Query(alias="status")] = None,
    priority: Annotated[list[TicketPriority] | None, Query()] = None,
    type_: Annotated[TicketType | None, Query(alias="type")] = None,
    assignee_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    customer_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    q: str | None = None,
    mine: bool = False,
    unassigned: bool = False,
    open_only: bool = False,
    sla_breached: bool = False,
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
        category_id=category_id,
        asset_id=asset_id,
        q=q,
        mine=mine,
        unassigned=unassigned,
        open_only=open_only,
        sla_breached=sla_breached,
    )
    items, total = await svc.list_tickets(
        db, user, filters, page=page, page_size=page_size, order_by=order_by
    )
    return Page(
        items=[TicketListItem.model_validate(t) for t in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/tickets", response_model=TicketDetail, status_code=status.HTTP_201_CREATED)
async def create_ticket(body: TicketCreate, db: DB, user: CurrentUser) -> TicketDetail:
    ticket = await svc.create_ticket(db, body, user)
    await commit_and_publish(db)
    return await _detail(db, ticket.id, user)


@router.get("/tickets/{ticket_id}", response_model=TicketDetail)
async def get_ticket(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> TicketDetail:
    return svc.to_detail(await svc.get_visible_ticket(db, user, ticket_id), user)


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
    )
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)


@router.post("/tickets/{ticket_id}/take", response_model=TicketDetail)
async def take_ticket(ticket_id: uuid.UUID, db: DB, user: StaffUser) -> TicketDetail:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    await svc.take_ticket(db, ticket, user)
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


# ------------------------------------------------------------------ acompanhamentos


@router.get("/tickets/{ticket_id}/comments", response_model=list[CommentOut])
async def list_comments(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> list[TicketComment]:
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
    ticket_id: uuid.UUID, body: CommentCreate, db: DB, user: CurrentUser
) -> TicketComment:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    comment = await svc.add_comment(db, ticket, body, user)
    await commit_and_publish(db)
    return await db.get(TicketComment, comment.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/tickets/{ticket_id}/events", response_model=list[EventOut])
async def list_events(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> list[TicketEvent]:
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
    return list(
        await db.scalars(
            select(TicketWorklog)
            .where(TicketWorklog.ticket_id == ticket_id)
            .order_by(TicketWorklog.started_at)
        )
    )


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
    return [_attachment_out(a, user) for a in rows]


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
) -> AttachmentOut:
    ticket = await svc.get_visible_ticket(db, user, ticket_id)
    attachment = await svc.add_attachment(db, ticket, file, kind, user)
    await commit_and_publish(db)
    loaded = await db.get(TicketAttachment, attachment.id, populate_existing=True)
    return _attachment_out(loaded, user)  # type: ignore[arg-type]


@router.get("/attachments/{attachment_id}/download", include_in_schema=True)
async def download_attachment(attachment_id: uuid.UUID, token: str, db: DB) -> FileResponse:
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
    try:
        path = storage.open_path(attachment.storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo não encontrado") from exc
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo não encontrado")
    disposition = "inline" if attachment.content_type.startswith("image/") else "attachment"
    return FileResponse(
        path,
        media_type=attachment.content_type,
        filename=attachment.filename,
        content_disposition_type=disposition,
    )

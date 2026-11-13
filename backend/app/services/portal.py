"""Portal do cliente: o usuário do cliente abre e acompanha as solicitações da empresa dele.

Antes o cliente mandava tudo pelo WhatsApp ou e-mail e o analista abria a OS à mão. Pelo portal
(navegador ou app instalado no Windows) ele abre direto: escolhe a loja, descreve o problema e
acompanha a visita. A central analisa, combina com um técnico e segue pelo fluxo normal.

O cliente vê só a empresa dele, e só uma lista fechada de campos (schemas.portal): nada de
etiquetas internas, analista, prazos de SLA, custos ou valores do técnico.

Com a solicitação em aberto, o cliente manda fotos do problema ou um PDF (antes iam pelo
WhatsApp, separados da OS). Viram anexos da OS: a central e o técnico veem; o cliente vê só o
nome e a data dos que a empresa dele mandou.
"""

import re
import uuid
from datetime import datetime
from typing import Literal

from fastapi import UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import raiseload, selectinload

from app.core.enums import (
    Impact,
    TicketEventType,
    TicketSource,
    TicketStatus,
    UserRole,
)
from app.db.base import utcnow
from app.models.customer import Customer, Location
from app.models.ticket import Ticket, TicketAttachment, TicketEvent
from app.models.user import User
from app.schemas.common import Ref
from app.schemas.portal import (
    PortalAttachment,
    PortalLocation,
    PortalMe,
    PortalRequestCreate,
    PortalRequestDetail,
    PortalRequestItem,
    PortalTimelineEntry,
)
from app.schemas.ticket import TicketCreate, format_ticket_code
from app.services import client_report, storage
from app.services import tickets as tickets_svc
from app.services.errors import NotFound, PermissionDenied, WorkflowError

S = TicketStatus
NO_COMPANY = "Seu usuário ainda não está ligado a uma empresa. Fale com a central da Maxx."
ONLY_CLIENTS = "O portal de solicitações é para os usuários dos clientes."
COMPANY_SUSPENDED = (
    "O acesso da sua empresa para abrir solicitações está suspenso. Fale com a central da Maxx."
)
# Busca pelo número da OS: o termo inteiro precisa ser o código ("OS-000123", "#123", "123").
_TICKET_CODE = re.compile(r"^(?:os)?[\s#-]*0*(\d{1,9})$", re.IGNORECASE)
# O cliente cancela enquanto ninguém começou a tratar; depois, fala com a central.
CANCELLABLE = (S.NEW, S.TRIAGE)
DONE = (S.RESOLVED, S.CLOSED)
FINAL = (S.RESOLVED, S.CLOSED, S.CANCELLED)
# Arquivos do cliente por solicitação e o tamanho de cada um.
MAX_CLIENT_FILES = 10
MAX_CLIENT_FILE_BYTES = 10 * 1024 * 1024
FILE_TYPES = "Envie uma foto (JPG, PNG ou WebP) ou um PDF"
REQUEST_CLOSED = "Esta solicitação já foi encerrada. Para mandar mais arquivos, fale com a Maxx."

Scope = Literal["open", "done", "all"]


def _like(term: str) -> str:
    """Termo para ILIKE com % e _ escapados (o cliente busca o texto, não um padrão)."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def customer_id_of(user: User) -> uuid.UUID:
    if user.role != UserRole.REQUESTER:
        raise PermissionDenied(ONLY_CLIENTS)
    if user.customer_id is None:
        raise PermissionDenied(NO_COMPANY)
    return user.customer_id


def _address(location: Location) -> str | None:
    return ", ".join(part for part in (location.address_line, location.district) if part) or None


def location_out(location: Location) -> PortalLocation:
    return PortalLocation(
        id=location.id,
        code=location.code,
        name=location.name,
        address=_address(location),
        city=location.city,
        state=location.state,
    )


async def me(db: AsyncSession, user: User) -> PortalMe:
    customer_id = customer_id_of(user)
    customer = await db.get(Customer, customer_id)
    if customer is None:
        raise PermissionDenied(NO_COMPANY)
    count = await db.scalar(
        select(func.count())
        .select_from(Location)
        .where(Location.customer_id == customer_id, Location.is_active.is_(True))
    )
    return PortalMe(
        customer=Ref(id=customer.id, name=customer.name),
        locations=count or 0,
        can_open_requests=customer.is_active,
    )


async def locations(
    db: AsyncSession, user: User, q: str | None = None, limit: int = 50
) -> list[PortalLocation]:
    customer_id = customer_id_of(user)
    stmt = (
        select(Location)
        .where(Location.customer_id == customer_id, Location.is_active.is_(True))
        .order_by(Location.name)
        .limit(limit)
    )
    if q and q.strip():
        term = _like(q.strip())
        stmt = stmt.where(
            or_(
                Location.name.ilike(term, escape="\\"),
                Location.code.ilike(term, escape="\\"),
                Location.city.ilike(term, escape="\\"),
            )
        )
    return [location_out(loc) for loc in await db.scalars(stmt)]


def to_item(ticket: Ticket) -> PortalRequestItem:
    return PortalRequestItem(
        id=ticket.id,
        code=format_ticket_code(ticket.number),
        title=ticket.title,
        status=ticket.status,
        location=location_out(ticket.location) if ticket.location else None,
        requester_name=ticket.requester_name,
        created_at=ticket.created_at,
        updated_at=ticket.updated_at,
        scheduled_start=ticket.scheduled_start,
        scheduled_end=ticket.scheduled_end,
        technician=ticket.assignee.name if ticket.assignee else None,
        arrived_at=ticket.arrived_at,
        resolved_at=ticket.resolved_at,
        cancelled_at=ticket.cancelled_at,
    )


async def list_requests(
    db: AsyncSession,
    user: User,
    *,
    scope: Scope = "open",
    location_id: uuid.UUID | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[Ticket], int]:
    customer_id = customer_id_of(user)
    stmt = select(Ticket).where(Ticket.customer_id == customer_id)
    if scope == "open":
        stmt = stmt.where(Ticket.status.not_in(FINAL))
    elif scope == "done":
        stmt = stmt.where(Ticket.status.in_(FINAL))
    if location_id is not None:
        stmt = stmt.where(Ticket.location_id == location_id)
    if q and q.strip():
        term = q.strip()
        like = _like(term)
        conditions = [
            Ticket.title.ilike(like, escape="\\"),
            Ticket.client_reference.ilike(like, escape="\\"),
        ]
        # Número só quando o termo inteiro é o código da OS: o nº do chamado do cliente
        # (INC20261113001) ou "Loja 41 caixa 2" não viram número de OS.
        code = _TICKET_CODE.match(term)
        if code:
            conditions.append(Ticket.number == int(code.group(1)))
        stmt = stmt.where(or_(*conditions))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    # A lista mostra só a loja e o técnico: as outras relações da OS não são carregadas.
    rows = await db.scalars(
        stmt.options(raiseload("*"), selectinload(Ticket.location), selectinload(Ticket.assignee))
        .order_by(Ticket.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return list(rows), total


async def get_request(db: AsyncSession, user: User, request_id: uuid.UUID) -> Ticket:
    customer_id = customer_id_of(user)
    try:
        ticket = await tickets_svc.get_ticket(db, request_id)
    except NotFound:
        ticket = None
    # OS de outra empresa: para o cliente ela simplesmente não existe.
    if ticket is None or ticket.customer_id != customer_id:
        raise NotFound("Solicitação não encontrada")
    return ticket


async def to_detail(db: AsyncSession, ticket: Ticket) -> PortalRequestDetail:
    events = await db.scalars(
        select(TicketEvent)
        .where(
            TicketEvent.ticket_id == ticket.id,
            TicketEvent.event_type.in_([TicketEventType.CREATED, TicketEventType.STATUS_CHANGED]),
        )
        .order_by(TicketEvent.created_at)
    )
    timeline: list[PortalTimelineEntry] = []
    for event in events:
        if event.event_type == TicketEventType.CREATED:
            timeline.append(PortalTimelineEntry(status="created", at=event.created_at))
        elif event.to_value:
            try:
                timeline.append(PortalTimelineEntry(status=S(event.to_value), at=event.created_at))
            except ValueError:
                continue
    link = client_report.link_out(ticket) if ticket.status in DONE else None
    files = await client_files(db, ticket.id)
    return PortalRequestDetail(
        **to_item(ticket).model_dump(),
        description=ticket.description or "",
        client_reference=ticket.client_reference,
        contact=ticket.requester_contact,
        resolution_notes=ticket.resolution_notes if ticket.status in DONE else None,
        report_url=link.url if link else None,
        can_cancel=ticket.status in CANCELLABLE,
        timeline=timeline,
        attachments=[
            PortalAttachment(id=a.id, filename=a.filename, created_at=a.created_at)
            for a in files
        ],
        can_attach=ticket.status not in FINAL and len(files) < MAX_CLIENT_FILES,
    )


async def client_files(db: AsyncSession, ticket_id: uuid.UUID) -> list[TicketAttachment]:
    """Anexos que os usuários do cliente mandaram nesta solicitação (os da Maxx ficam de fora)."""
    return list(
        await db.scalars(
            select(TicketAttachment)
            .join(User, User.id == TicketAttachment.uploaded_by_id)
            .where(TicketAttachment.ticket_id == ticket_id, User.role == UserRole.REQUESTER)
            .order_by(TicketAttachment.created_at)
        )
    )


async def add_file(db: AsyncSession, user: User, ticket: Ticket, upload: UploadFile) -> None:
    """Foto do problema (JPG, PNG, WebP) ou PDF, até 10 MB e 10 por solicitação, enquanto ela
    não foi encerrada. O tipo vale pelo conteúdo do arquivo, não pelo nome."""
    customer = await db.get(Customer, customer_id_of(user))
    if customer is None or not customer.is_active:
        raise WorkflowError(COMPANY_SUSPENDED)
    if ticket.status in FINAL:
        raise WorkflowError(REQUEST_CLOSED)
    if upload.size is not None and upload.size > MAX_CLIENT_FILE_BYTES:
        raise WorkflowError("Arquivo maior que 10 MB")
    head = await upload.read(16)
    await upload.seek(0)
    if storage.image_extension(head) is not None:
        kind = "photo"
    elif head.startswith(b"%PDF-"):
        kind = "file"
    else:
        raise WorkflowError(FILE_TYPES)
    if len(await client_files(db, ticket.id)) >= MAX_CLIENT_FILES:
        raise WorkflowError(f"Limite de {MAX_CLIENT_FILES} arquivos por solicitação")
    await tickets_svc.add_attachment(db, ticket, upload, kind, user)


async def create_request(db: AsyncSession, user: User, data: PortalRequestCreate) -> Ticket:
    customer_id = customer_id_of(user)
    customer = await db.get(Customer, customer_id)
    # Contrato encerrado (cliente desativado): o histórico continua visível, abrir não.
    if customer is None or not customer.is_active:
        raise WorkflowError(COMPANY_SUSPENDED)
    location = await db.get(Location, data.location_id)
    if location is None or location.customer_id != customer_id or not location.is_active:
        raise WorkflowError("Loja não encontrada. Escolha uma das lojas da sua empresa.")
    payload = TicketCreate(
        title=data.title.strip(),
        description=data.description.strip(),
        impact=Impact.MEDIUM,
        urgency=data.urgency,
        source=TicketSource.PORTAL,
        customer_id=customer_id,
        location_id=location.id,
        requester_contact=(data.contact or "").strip() or None,
        client_reference=(data.client_reference or "").strip() or None,
    )
    return await tickets_svc.create_ticket(db, payload, user)


async def cancel_request(db: AsyncSession, user: User, ticket: Ticket, reason: str) -> Ticket:
    """Qualquer usuário da empresa cancela enquanto a central ainda não começou a tratar."""
    if ticket.status not in CANCELLABLE:
        raise WorkflowError(
            "A central já está cuidando desta solicitação. Para cancelar, fale com a Maxx."
        )
    now: datetime = utcnow()
    tickets_svc.change_status(db, ticket, S.CANCELLED, user, now=now, note=reason.strip())
    ticket.updated_at = now
    await db.flush()
    return ticket


async def inbox_count(db: AsyncSession) -> int:
    """Solicitações do portal esperando a central (novas ou em triagem)."""
    return (
        await db.scalar(
            select(func.count())
            .select_from(Ticket)
            .where(Ticket.source == TicketSource.PORTAL, Ticket.status.in_(CANCELLABLE))
        )
        or 0
    )

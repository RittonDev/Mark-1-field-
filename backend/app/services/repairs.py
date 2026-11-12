"""Assistência externa: etapas do equipamento, da retirada no cliente até a devolução."""

import uuid
from datetime import timedelta

from fastapi import UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import RepairStatus
from app.core.security import create_token
from app.db.base import utcnow
from app.models import Customer, Location, RepairEvent, RepairOrder, RepairPhoto, Ticket, User
from app.schemas.repair import RepairIn, RepairOut, RepairStatusChange, RepairSummary
from app.schemas.ticket import format_ticket_code
from app.services import storage
from app.services.activities import local_today
from app.services.errors import NotFound, WorkflowError

R = RepairStatus
FINAL = (R.DELIVERED, R.CANCELLED)

# Fluxo normal com os desvios comuns (orçamento recusado volta sem conserto, etc.).
NEXT: dict[RepairStatus, tuple[RepairStatus, ...]] = {
    R.WITHDRAWN: (R.RECEIVED, R.CANCELLED),
    R.RECEIVED: (R.SENT_TO_VENDOR, R.BACK_IN_STOCK, R.CANCELLED),
    R.SENT_TO_VENDOR: (R.VENDOR_QUOTE, R.IN_REPAIR, R.READY_AT_VENDOR, R.UNREPAIRABLE),
    R.VENDOR_QUOTE: (R.IN_REPAIR, R.UNREPAIRABLE, R.READY_AT_VENDOR),
    R.IN_REPAIR: (R.READY_AT_VENDOR, R.UNREPAIRABLE),
    R.READY_AT_VENDOR: (R.BACK_IN_STOCK,),
    R.UNREPAIRABLE: (R.BACK_IN_STOCK, R.DELIVERED, R.CANCELLED),
    R.BACK_IN_STOCK: (R.DELIVERED, R.SENT_TO_VENDOR),
    R.DELIVERED: (),
    R.CANCELLED: (),
}


async def get(db: AsyncSession, repair_id: uuid.UUID) -> RepairOrder:
    repair = await db.get(RepairOrder, repair_id)
    if repair is None:
        raise NotFound("Registro de assistência não encontrado")
    return repair


async def _check(db: AsyncSession, data: RepairIn) -> None:
    if data.customer_id and await db.get(Customer, data.customer_id) is None:
        raise WorkflowError("Cliente não encontrado")
    if data.location_id:
        location = await db.get(Location, data.location_id)
        if location is None or (data.customer_id and location.customer_id != data.customer_id):
            raise WorkflowError("O local não é deste cliente")
    if data.ticket_id and await db.get(Ticket, data.ticket_id) is None:
        raise WorkflowError("OS não encontrada")


def _clean(data: RepairIn) -> dict:
    values = data.model_dump()
    for key, value in values.items():
        if isinstance(value, str):
            values[key] = value.strip() or (None if key not in ("problem", "equipment_type") else value)
    return values


async def create(db: AsyncSession, data: RepairIn, actor: User) -> RepairOrder:
    await _check(db, data)
    now = utcnow()
    repair = RepairOrder(
        id=uuid.uuid4(),
        status=R.WITHDRAWN,
        status_changed_at=now,
        created_by_id=actor.id,
        **_clean(data),
    )
    db.add(repair)
    db.add(RepairEvent(id=uuid.uuid4(), repair_id=repair.id, from_status=None, to_status=R.WITHDRAWN, actor_id=actor.id, created_at=now))
    await db.flush()
    return repair


async def update(db: AsyncSession, repair: RepairOrder, data: RepairIn) -> RepairOrder:
    await _check(db, data)
    for key, value in _clean(data).items():
        setattr(repair, key, value)
    await db.flush()
    return repair


async def change_status(
    db: AsyncSession, repair: RepairOrder, data: RepairStatusChange, actor: User
) -> RepairOrder:
    if data.to_status not in NEXT[repair.status]:
        raise WorkflowError("Esta etapa não vem depois da atual")
    now = utcnow()
    db.add(
        RepairEvent(
            id=uuid.uuid4(),
            repair_id=repair.id,
            from_status=repair.status,
            to_status=data.to_status,
            note=(data.note or "").strip() or None,
            actor_id=actor.id,
            created_at=now,
        )
    )
    repair.status = data.to_status
    repair.status_changed_at = now
    if data.vendor_quote_value is not None:
        repair.vendor_quote_value = data.vendor_quote_value
    if data.expected_return_date is not None:
        repair.expected_return_date = data.expected_return_date
    await db.flush()
    return repair


async def add_photo(
    db: AsyncSession, repair: RepairOrder, upload: UploadFile, caption: str | None, actor: User
) -> RepairPhoto:
    raw = await upload.read(5 * 1024 * 1024 + 1)
    if len(raw) > 5 * 1024 * 1024:
        raise WorkflowError("Foto maior que 5 MB")
    ext = storage.image_extension(raw)
    if ext is None:
        raise WorkflowError("Envie uma imagem JPG, PNG ou WebP")
    photo = RepairPhoto(
        id=uuid.uuid4(),
        repair_id=repair.id,
        storage_key=await storage.save_bytes("repairs", ext, raw),
        caption=(caption or "").strip()[:200] or None,
        uploaded_by_id=actor.id,
    )
    db.add(photo)
    await db.flush()
    return photo


def _photo_url(photo: RepairPhoto) -> str:
    token = create_token(f"repair-photo:{photo.id}", "download", timedelta(minutes=60))
    return f"{settings.API_PREFIX}/repair-photos/{photo.id}?token={token}"


async def to_out(db: AsyncSession, repairs: list[RepairOrder], full: bool = False) -> list[RepairOut]:
    ticket_ids = {r.ticket_id for r in repairs if r.ticket_id}
    tickets = {}
    if ticket_ids:
        tickets = {t.id: t for t in await db.scalars(select(Ticket).where(Ticket.id.in_(ticket_ids)))}
    today = local_today()
    now = utcnow()
    out = []
    for r in repairs:
        ticket = tickets.get(r.ticket_id) if r.ticket_id else None
        open_ = r.status not in FINAL
        out.append(
            RepairOut(
                id=r.id,
                number=r.number,
                status=r.status,
                status_changed_at=r.status_changed_at,
                customer={"id": r.customer.id, "name": r.customer.name} if r.customer else None,
                location={"id": r.location.id, "name": r.location.name} if r.location else None,
                ticket={"id": ticket.id, "name": format_ticket_code(ticket.number)} if ticket else None,
                equipment_type=r.equipment_type,
                brand=r.brand,
                model=r.model,
                serial_number=r.serial_number,
                asset_tag=r.asset_tag,
                problem=r.problem,
                accessories=r.accessories,
                vendor_name=r.vendor_name,
                vendor_contact=r.vendor_contact,
                vendor_protocol=r.vendor_protocol,
                vendor_quote_value=r.vendor_quote_value,
                expected_return_date=r.expected_return_date,
                notes=r.notes,
                created_at=r.created_at,
                events=r.events if full else [],
                photos=[
                    {"id": p.id, "caption": p.caption, "created_at": p.created_at, "url": _photo_url(p)}
                    for p in r.photos
                ]
                if full
                else [],
                allowed_next=list(NEXT[r.status]),
                days_open=((now if open_ else r.status_changed_at) - r.created_at).days,
                days_in_status=(now - r.status_changed_at).days,
                overdue=open_ and r.expected_return_date is not None and r.expected_return_date < today,
            )
        )
    return out


async def list_repairs(
    db: AsyncSession,
    status: RepairStatus | None,
    customer_id: uuid.UUID | None,
    q: str | None,
    open_only: bool,
) -> list[RepairOut]:
    stmt = select(RepairOrder).order_by(RepairOrder.status_changed_at.desc())
    if status is not None:
        stmt = stmt.where(RepairOrder.status == status)
    if open_only:
        stmt = stmt.where(RepairOrder.status.not_in(FINAL))
    if customer_id is not None:
        stmt = stmt.where(RepairOrder.customer_id == customer_id)
    if q:
        term = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                RepairOrder.serial_number.ilike(term),
                RepairOrder.model.ilike(term),
                RepairOrder.brand.ilike(term),
                RepairOrder.asset_tag.ilike(term),
                RepairOrder.vendor_protocol.ilike(term),
            )
        )
    return await to_out(db, list(await db.scalars(stmt.limit(500))))


async def summary(db: AsyncSession) -> RepairSummary:
    rows = dict((await db.execute(select(RepairOrder.status, func.count()).group_by(RepairOrder.status))).all())
    overdue = await db.scalar(
        select(func.count()).where(
            RepairOrder.status.not_in(FINAL),
            RepairOrder.expected_return_date < local_today(),
        )
    )
    return RepairSummary(
        by_status={s.value: rows.get(s, 0) for s in RepairStatus},
        open_total=sum(c for s, c in rows.items() if s not in FINAL),
        overdue=overdue or 0,
    )

"""Assistência externa: etapas do equipamento, da retirada no cliente até a devolução.

A etapa clicada por engano volta para a anterior ("Voltar etapa", com motivo): a linha do tempo
guarda a ida e a volta.
"""

import re
import uuid
from collections.abc import Iterable
from datetime import timedelta
from typing import Any

from fastapi import UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

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


BACK_NEEDS_NOTE = "Informe o motivo para voltar à etapa anterior"
_CODE = re.compile(r"^(?:ae)?[\s#-]*0*(\d{1,9})$", re.IGNORECASE)


async def get(db: AsyncSession, repair_id: uuid.UUID) -> RepairOrder:
    repair = await db.get(RepairOrder, repair_id)
    if repair is None:
        raise NotFound("Registro de assistência não encontrado")
    return repair


def _clean(data: RepairIn) -> dict[str, Any]:
    values = data.model_dump()
    for key, value in values.items():
        if isinstance(value, str):
            values[key] = value.strip() or (
                None if key not in ("problem", "equipment_type") else value
            )
    return values


async def _values(db: AsyncSession, data: RepairIn) -> dict[str, Any]:
    """O que gravar, com cliente e loja completados: retirada a partir de uma OS leva o cliente
    e a loja dela (quando não foram escolhidos); só com a loja, o cliente é o da loja."""
    values = _clean(data)
    if data.ticket_id is not None:
        row = (
            await db.execute(
                select(Ticket.customer_id, Ticket.location_id).where(Ticket.id == data.ticket_id)
            )
        ).first()
        if row is None:
            raise WorkflowError("OS não encontrada")
        ticket_customer, ticket_location = row
        if values["customer_id"] is None:
            values["customer_id"] = ticket_customer
        elif ticket_customer is not None and ticket_customer != values["customer_id"]:
            raise WorkflowError("A OS escolhida é de outro cliente")
        if values["location_id"] is None and ticket_customer == values["customer_id"]:
            values["location_id"] = ticket_location
    if values["location_id"] is not None:
        location = await db.get(Location, values["location_id"])
        if location is None:
            raise WorkflowError("Local não encontrado")
        if values["customer_id"] is None:
            values["customer_id"] = location.customer_id
        elif location.customer_id != values["customer_id"]:
            raise WorkflowError("O local não é deste cliente")
    if values["customer_id"] is not None and await db.get(Customer, values["customer_id"]) is None:
        raise WorkflowError("Cliente não encontrado")
    return values


def previous_status(events: Iterable[RepairEvent]) -> RepairStatus | None:
    """Para onde "Voltar etapa" leva: a etapa antes da atual, desfazendo as voltas já feitas
    (cada volta tira a última ida da pilha). Ida é o que NEXT permite; o resto é volta."""
    stack: list[RepairStatus] = []
    for event in events:
        if event.from_status is None or event.to_status in NEXT[event.from_status]:
            stack.append(event.to_status)
        elif len(stack) > 1:
            stack.pop()
    return stack[-2] if len(stack) > 1 else None


async def create(db: AsyncSession, data: RepairIn, actor: User) -> RepairOrder:
    values = await _values(db, data)
    now = utcnow()
    repair = RepairOrder(
        id=uuid.uuid4(),
        status=R.WITHDRAWN,
        status_changed_at=now,
        created_by_id=actor.id,
        **values,
    )
    db.add(repair)
    await db.flush()  # o registro precisa existir antes da 1ª linha do tempo
    db.add(
        RepairEvent(
            id=uuid.uuid4(),
            repair_id=repair.id,
            from_status=None,
            to_status=R.WITHDRAWN,
            actor_id=actor.id,
            created_at=now,
        )
    )
    await db.flush()
    return repair


async def update(db: AsyncSession, repair: RepairOrder, data: RepairIn) -> RepairOrder:
    for key, value in (await _values(db, data)).items():
        setattr(repair, key, value)
    await db.flush()
    return repair


async def change_status(
    db: AsyncSession, repair: RepairOrder, data: RepairStatusChange, actor: User
) -> RepairOrder:
    """Próxima etapa, ou a volta para a anterior (etapa clicada por engano), com motivo."""
    note = (data.note or "").strip() or None
    if data.to_status not in NEXT[repair.status]:
        if data.to_status != previous_status(repair.events):
            raise WorkflowError("Esta etapa não vem depois da atual")
        if note is None:
            raise WorkflowError(BACK_NEEDS_NOTE)
    now = utcnow()
    db.add(
        RepairEvent(
            id=uuid.uuid4(),
            repair_id=repair.id,
            from_status=repair.status,
            to_status=data.to_status,
            note=note,
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


async def to_out(
    db: AsyncSession, repairs: list[RepairOrder], full: bool = False
) -> list[RepairOut]:
    ticket_ids = {r.ticket_id for r in repairs if r.ticket_id}
    # Só o número da OS (a OS inteira traria as ~19 relações dela).
    numbers: dict[uuid.UUID, int] = {}
    if ticket_ids:
        numbers = dict(
            (
                await db.execute(select(Ticket.id, Ticket.number).where(Ticket.id.in_(ticket_ids)))
            ).all()
        )
    today = local_today()
    now = utcnow()
    out = []
    for r in repairs:
        number = numbers.get(r.ticket_id) if r.ticket_id else None
        open_ = r.status not in FINAL
        out.append(
            RepairOut(
                id=r.id,
                number=r.number,
                status=r.status,
                status_changed_at=r.status_changed_at,
                customer={"id": r.customer.id, "name": r.customer.name} if r.customer else None,
                location={"id": r.location.id, "name": r.location.name} if r.location else None,
                ticket={"id": r.ticket_id, "name": format_ticket_code(number)}
                if r.ticket_id and number is not None
                else None,
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
                    {
                        "id": p.id,
                        "caption": p.caption,
                        "created_at": p.created_at,
                        "url": _photo_url(p),
                    }
                    for p in r.photos
                ]
                if full
                else [],
                allowed_next=list(NEXT[r.status]),
                previous_status=previous_status(r.events) if full else None,
                days_open=((now if open_ else r.status_changed_at) - r.created_at).days,
                days_in_status=(now - r.status_changed_at).days,
                overdue=open_
                and r.expected_return_date is not None
                and r.expected_return_date < today,
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
    # A lista não mostra a linha do tempo nem as fotos: não carrega (até 500 registros).
    stmt = (
        select(RepairOrder)
        .options(noload(RepairOrder.events), noload(RepairOrder.photos))
        .order_by(RepairOrder.status_changed_at.desc())
    )
    if status is not None:
        stmt = stmt.where(RepairOrder.status == status)
    if open_only:
        stmt = stmt.where(RepairOrder.status.not_in(FINAL))
    if customer_id is not None:
        stmt = stmt.where(RepairOrder.customer_id == customer_id)
    if q and q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        term = f"%{escaped}%"
        options = [
            column.ilike(term, escape="\\")
            for column in (
                RepairOrder.serial_number,
                RepairOrder.model,
                RepairOrder.brand,
                RepairOrder.asset_tag,
                RepairOrder.vendor_protocol,
            )
        ]
        # Código do registro: "AE-000123", "AE 123" ou "123".
        code = _CODE.match(q.strip())
        if code:
            options.append(RepairOrder.number == int(code.group(1)))
        stmt = stmt.where(or_(*options))
    return await to_out(db, list(await db.scalars(stmt.limit(500))))


async def summary(db: AsyncSession) -> RepairSummary:
    rows = dict(
        (
            await db.execute(select(RepairOrder.status, func.count()).group_by(RepairOrder.status))
        ).all()
    )
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

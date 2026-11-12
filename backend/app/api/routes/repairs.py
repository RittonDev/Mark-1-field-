import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse

from app.api.deps import DB, TicketManagerUser
from app.core.enums import RepairStatus
from app.core.security import InvalidToken, decode_token
from app.models import RepairPhoto
from app.schemas.repair import RepairIn, RepairOut, RepairStatusChange, RepairSummary
from app.services import repairs as svc
from app.services import storage

router = APIRouter(tags=["repairs"])


async def _full(db: DB, repair_id: uuid.UUID) -> RepairOut:
    repair = await svc.get(db, repair_id)
    await db.refresh(repair, ["events", "photos", "customer", "location"])
    return (await svc.to_out(db, [repair], full=True))[0]


@router.get("/repairs", response_model=list[RepairOut])
async def list_repairs(
    db: DB,
    _: TicketManagerUser,
    status_: Annotated[RepairStatus | None, Query(alias="status")] = None,
    customer_id: uuid.UUID | None = None,
    q: str | None = None,
    open_only: bool = False,
) -> list[RepairOut]:
    return await svc.list_repairs(db, status_, customer_id, q, open_only)


@router.get("/repairs/summary", response_model=RepairSummary)
async def repairs_summary(db: DB, _: TicketManagerUser) -> RepairSummary:
    return await svc.summary(db)


@router.post("/repairs", response_model=RepairOut, status_code=status.HTTP_201_CREATED)
async def create_repair(body: RepairIn, db: DB, user: TicketManagerUser) -> RepairOut:
    repair = await svc.create(db, body, user)
    await db.commit()
    return await _full(db, repair.id)


@router.get("/repairs/{repair_id}", response_model=RepairOut)
async def get_repair(repair_id: uuid.UUID, db: DB, _: TicketManagerUser) -> RepairOut:
    return await _full(db, repair_id)


@router.put("/repairs/{repair_id}", response_model=RepairOut)
async def update_repair(
    repair_id: uuid.UUID, body: RepairIn, db: DB, _: TicketManagerUser
) -> RepairOut:
    await svc.update(db, await svc.get(db, repair_id), body)
    await db.commit()
    return await _full(db, repair_id)


@router.post("/repairs/{repair_id}/status", response_model=RepairOut)
async def change_repair_status(
    repair_id: uuid.UUID, body: RepairStatusChange, db: DB, user: TicketManagerUser
) -> RepairOut:
    await svc.change_status(db, await svc.get(db, repair_id), body, user)
    await db.commit()
    return await _full(db, repair_id)


@router.post("/repairs/{repair_id}/photos", response_model=RepairOut)
async def add_repair_photo(
    repair_id: uuid.UUID,
    db: DB,
    user: TicketManagerUser,
    file: Annotated[UploadFile, File()],
    caption: Annotated[str | None, Form(max_length=200)] = None,
) -> RepairOut:
    await svc.add_photo(db, await svc.get(db, repair_id), file, caption, user)
    await db.commit()
    return await _full(db, repair_id)


@router.get("/repair-photos/{photo_id}", include_in_schema=False)
async def repair_photo(photo_id: uuid.UUID, token: str, db: DB) -> FileResponse:
    try:
        payload = decode_token(token, "download")
    except InvalidToken as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link expirado") from exc
    if payload.get("sub") != f"repair-photo:{photo_id}":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link inválido")
    photo = await db.get(RepairPhoto, photo_id)
    if photo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto não encontrada")
    return FileResponse(storage.open_path(photo.storage_key))

import uuid
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse

from app.api.deps import DB, TicketManagerUser
from app.core.security import InvalidToken, decode_token
from app.models import User
from app.schemas.technician import (
    ImportResult,
    TechnicianCreate,
    TechnicianOut,
    TechnicianUpdate,
    TemporaryPassword,
)
from app.services import storage
from app.services import technicians as svc
from app.services.spreadsheet import SpreadsheetError

router = APIRouter(tags=["technicians"])


async def _one(db: DB, user: User) -> TechnicianOut:
    await db.refresh(user, ["team"])
    return (await svc.to_out(db, [user]))[0]


@router.get("/technicians", response_model=list[TechnicianOut])
async def list_technicians(
    db: DB,
    _: TicketManagerUser,
    q: str | None = None,
    team_id: uuid.UUID | None = None,
    active: bool | None = None,
) -> list[TechnicianOut]:
    return await svc.list_technicians(db, q, team_id, active)


@router.post("/technicians", response_model=TemporaryPassword, status_code=status.HTTP_201_CREATED)
async def create_technician(
    body: TechnicianCreate, db: DB, _: TicketManagerUser
) -> TemporaryPassword:
    """Cadastro direto (sem ficha): o técnico recebe uma senha provisória."""
    user, password = await svc.create(db, body)
    await db.commit()
    return TemporaryPassword(technician=await _one(db, user), temporary_password=password)


@router.patch("/technicians/{user_id}", response_model=TechnicianOut)
async def update_technician(
    user_id: uuid.UUID, body: TechnicianUpdate, db: DB, _: TicketManagerUser
) -> TechnicianOut:
    user = await svc.get_technician(db, user_id)
    await svc.update(db, user, body)
    await db.commit()
    return await _one(db, user)


@router.post("/technicians/{user_id}/reset-password", response_model=TemporaryPassword)
async def reset_password(user_id: uuid.UUID, db: DB, _: TicketManagerUser) -> TemporaryPassword:
    """Esqueceu a senha: gera uma provisória e encerra as sessões abertas do técnico."""
    user = await svc.get_technician(db, user_id)
    password = await svc.reset_password(db, user)
    await db.commit()
    return TemporaryPassword(technician=await _one(db, user), temporary_password=password)


@router.post("/technicians/{user_id}/photo", response_model=TechnicianOut)
async def upload_photo(
    user_id: uuid.UUID, db: DB, _: TicketManagerUser, file: Annotated[UploadFile, File()]
) -> TechnicianOut:
    user = await svc.get_technician(db, user_id)
    await svc.set_photo(db, user, file)
    await db.commit()
    return await _one(db, user)


@router.delete("/technicians/{user_id}/photo", response_model=TechnicianOut)
async def remove_photo(user_id: uuid.UUID, db: DB, _: TicketManagerUser) -> TechnicianOut:
    user = await svc.get_technician(db, user_id)
    user.avatar_key = None
    await db.commit()
    return await _one(db, user)


@router.post("/technicians/import", response_model=ImportResult)
async def import_technicians(
    db: DB,
    _: TicketManagerUser,
    file: Annotated[UploadFile, File()],
    dry_run: bool = True,
) -> ImportResult:
    """Planilha CSV ou XLSX. Por padrão só mostra a prévia; dry_run=false grava."""
    data = await file.read()
    try:
        result = await svc.import_file(db, file.filename or "", data, dry_run)
    except SpreadsheetError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    if not dry_run:
        await db.commit()
    return result


@router.get("/users/{user_id}/avatar", include_in_schema=False)
async def avatar(user_id: uuid.UUID, token: str, db: DB) -> Response:
    """Foto do perfil por link assinado (a tag <img> não envia o token de acesso)."""
    try:
        payload = decode_token(token, "download")
    except InvalidToken as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link expirado") from exc
    if payload.get("sub") != f"avatar:{user_id}":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link inválido")
    user = await db.get(User, user_id)
    if user is None or not user.avatar_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sem foto")
    return FileResponse(storage.open_path(user.avatar_key))

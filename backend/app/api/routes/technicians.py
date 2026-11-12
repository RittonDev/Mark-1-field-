import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse

from app.api.deps import DB, TicketManagerUser
from app.core.security import InvalidToken, decode_token
from app.models import Category, Location, Project, ServiceType, User
from app.schemas.technician import (
    ImportResult,
    NearbyOut,
    RegionRefresh,
    RegionState,
    TechnicianCreate,
    TechnicianOut,
    TechnicianSuggestion,
    TechnicianUpdate,
    TemporaryPassword,
)
from app.services import storage, suggestions
from app.services import technician_regions as regions_svc
from app.services import technicians as svc
from app.services import tickets as tickets_svc
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
    state: str | None = None,
    city: str | None = None,
) -> list[TechnicianOut]:
    """Base técnica. `state`/`city` filtram pela região de atuação (histórico) ou pelo endereço."""
    if await regions_svc.refresh_if_stale(db):
        await db.commit()
    return await svc.list_technicians(db, q, team_id, active, state, city)


@router.get("/technicians/regions", response_model=list[RegionState])
async def technician_regions(
    db: DB, _: TicketManagerUser, active: bool | None = None
) -> list[dict]:
    """Estados e cidades com técnicos (região: a base pelo histórico, senão o endereço)."""
    return await regions_svc.regions(db, active)


@router.post("/technicians/regions/refresh", response_model=RegionRefresh)
async def refresh_technician_regions(db: DB, _: TicketManagerUser) -> dict:
    """Recalcula agora a região de atuação de todos os técnicos."""
    counts = await regions_svc.refresh_bases(db)
    await db.commit()
    return counts


@router.get("/technicians/nearby", response_model=NearbyOut)
async def nearby_technicians(
    db: DB,
    _: TicketManagerUser,
    location_id: uuid.UUID | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    city: str | None = None,
    state: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 15,
    include_inactive: bool = True,
    max_km: Annotated[float | None, Query(gt=0)] = None,
) -> dict:
    """Técnicos mais próximos de uma loja, de coordenadas ou do centro de uma cidade."""
    if await regions_svc.refresh_if_stale(db):
        await db.commit()
    point = await regions_svc.resolve_point(
        db, location_id=location_id, latitude=latitude, longitude=longitude, city=city, state=state
    )
    rows = await regions_svc.nearby(
        db, point, limit=limit, include_inactive=include_inactive, max_km=max_km
    )
    return {
        "point": {"latitude": point.latitude, "longitude": point.longitude, "label": point.label},
        "technicians": rows,
    }


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


@router.get(
    "/tickets/{ticket_id}/technician-suggestions", response_model=list[TechnicianSuggestion]
)
async def ticket_suggestions(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> list[dict]:
    """Os 5 técnicos mais indicados para a OS (cidade, distância, agenda, skill, carga)."""
    if await regions_svc.refresh_if_stale(db):
        await db.commit()
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    project = await db.get(Project, ticket.project_id) if ticket.project_id else None
    return await suggestions.suggest(db, suggestions.target_for(ticket, project))


@router.get("/technicians/suggest", response_model=list[TechnicianSuggestion])
async def suggest_for_place(
    db: DB,
    _: TicketManagerUser,
    city: str | None = None,
    state: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    location_id: uuid.UUID | None = None,
    service_type_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    title: Annotated[str | None, Query(max_length=200)] = None,
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    estimated_minutes: Annotated[int | None, Query(gt=0, le=60 * 24 * 7)] = None,
    limit: Annotated[int, Query(ge=1, le=10)] = 5,
) -> list[dict]:
    """Para quem ainda está abrindo a OS: a loja (ou o lugar), o serviço e o horário da visita
    dão o mesmo ranking de uma OS já aberta (distância, histórico na loja, skill, agenda)."""
    if await regions_svc.refresh_if_stale(db):
        await db.commit()
    location = await db.get(Location, location_id) if location_id else None
    service_type = await db.get(ServiceType, service_type_id) if service_type_id else None
    category = await db.get(Category, category_id) if category_id else None
    project = await db.get(Project, project_id) if project_id else None
    if start is not None and start.tzinfo is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Informe o fuso do horário")
    coords = (latitude, longitude) if latitude is not None and longitude is not None else None
    target = suggestions.target_from(
        location=location,
        city=city,
        state=state,
        coords=coords,
        texts=[
            title,
            category.full_name if category else None,
            service_type.name if service_type else None,
        ],
        start=start,
        end=end,
        estimated_minutes=estimated_minutes
        or (service_type.estimated_minutes if service_type else None),
        project=project,
    )
    return await suggestions.suggest(db, target, limit=limit)

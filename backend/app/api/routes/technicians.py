import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import func, select

from app.api.deps import DB, TicketManagerUser, access_user
from app.api.files import stored_file
from app.core.enums import UserRole
from app.core.security import InvalidToken, decode_token
from app.models import Category, Location, Project, ServiceType, User, UserChange
from app.models.user_change import VIA_CENTRAL
from app.schemas.my_profile import UserChangeOut
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
from app.services import suggestions, user_history
from app.services import technician_regions as regions_svc
from app.services import technicians as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish
from app.services.spreadsheet import MAX_BYTES, SpreadsheetError, read_upload

router = APIRouter(tags=["technicians"])

# Tela de Técnicos ("Editar" inclui Liberar acesso). As regiões também aparecem na Homologação
# e os técnicos perto da loja, no detalhe do Local. As sugestões ficam com toda a gestão.
TechniciansView = access_user("base.technicians")
TechniciansEdit = access_user("base.technicians", level="edit")
RegionsView = access_user("base.technicians", "base.onboarding")
NearbyView = access_user("base.technicians", "base.locations")
# Chave PIX do técnico: é dado de Pagamentos. A central só remove (quem cadastra é o técnico).
PixEdit = access_user("commercial.payouts", level="edit")


async def _one(db: DB, user: User) -> TechnicianOut:
    await db.refresh(user, ["team"])
    return (await svc.to_out(db, [user]))[0]


async def _ensure_regions(db: DB) -> None:
    """Regiões de atuação calculadas ao menos uma vez antes de responder. Depois disso, a rotina
    periódica (app.main) mantém em dia: a requisição não recalcula 15 mil OS a cada 6 h."""
    computed = await db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.role == UserRole.TECHNICIAN, User.base_updated_at.is_not(None))
    )
    if not computed and await regions_svc.refresh_if_stale(db):
        await db.commit()


@router.get("/technicians", response_model=list[TechnicianOut])
async def list_technicians(
    db: DB,
    _: TechniciansView,
    response: Response,
    q: str | None = None,
    team_id: uuid.UUID | None = None,
    active: bool | None = None,
    state: str | None = None,
    city: str | None = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 2000,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[TechnicianOut]:
    """Base técnica. `state`/`city` filtram pela região de atuação (histórico) ou pelo endereço.
    O total que bate com os filtros vai no cabeçalho X-Total-Count (a lista é paginada)."""
    await _ensure_regions(db)
    items, total = await svc.list_technicians(
        db, q, team_id, active, state, city, limit=limit, offset=offset
    )
    response.headers["X-Total-Count"] = str(total)
    return items


@router.get("/technicians/regions", response_model=list[RegionState])
async def technician_regions(db: DB, _: RegionsView, active: bool | None = None) -> list[dict]:
    """Estados e cidades com técnicos (região: a base pelo histórico, senão o endereço)."""
    return await regions_svc.regions(db, active)


@router.post("/technicians/regions/refresh", response_model=RegionRefresh)
async def refresh_technician_regions(db: DB, _: TechniciansEdit) -> dict:
    """Recalcula agora a região de atuação de todos os técnicos."""
    counts = await regions_svc.refresh_bases(db)
    await db.commit()
    return counts


@router.get("/technicians/nearby", response_model=NearbyOut)
async def nearby_technicians(
    db: DB,
    _: NearbyView,
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
    await _ensure_regions(db)
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
    body: TechnicianCreate, db: DB, _: TechniciansEdit
) -> TemporaryPassword:
    """Cadastro direto (sem ficha): o técnico recebe uma senha provisória."""
    user, password = await svc.create(db, body)
    await db.commit()
    return TemporaryPassword(technician=await _one(db, user), temporary_password=password)


@router.patch("/technicians/{user_id}", response_model=TechnicianOut)
async def update_technician(
    user_id: uuid.UUID, body: TechnicianUpdate, db: DB, actor: TechniciansEdit
) -> TechnicianOut:
    """Desativar fecha as ofertas em aberto dele (o tempo real das OS sai no commit). O que mudou
    fica no histórico do cadastro (via central)."""
    user = await svc.get_technician(db, user_id)
    before = await user_history.snapshot(db, user)
    await svc.update(db, user, body, actor)
    changes = await user_history.track(db, user, before, via=VIA_CENTRAL, actor=actor)
    await commit_and_publish(db)
    await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return await _one(db, user)


@router.post("/technicians/{user_id}/reset-password", response_model=TemporaryPassword)
async def reset_password(user_id: uuid.UUID, db: DB, actor: TechniciansEdit) -> TemporaryPassword:
    """Esqueceu a senha: gera uma provisória e encerra as sessões abertas do técnico."""
    user = await svc.get_technician(db, user_id)
    password = await svc.reset_password(db, user)
    changes = [dict(user_history.PASSWORD_TEMPORARY)]
    user_history.record(db, user, changes, via=VIA_CENTRAL, actor=actor)
    await db.commit()
    await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return TemporaryPassword(technician=await _one(db, user), temporary_password=password)


@router.post("/technicians/{user_id}/photo", response_model=TechnicianOut)
async def upload_photo(
    user_id: uuid.UUID, db: DB, actor: TechniciansEdit, file: Annotated[UploadFile, File()]
) -> TechnicianOut:
    """A anterior sai do disco quando ninguém mais usa (a ficha da homologação guarda a dela)."""
    user = await svc.get_technician(db, user_id)
    changes, previous = await svc.set_photo(db, user, file, via=VIA_CENTRAL, actor=actor)
    await db.commit()
    await svc.drop_unused_photo(db, previous, user.id)
    await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return await _one(db, user)


@router.delete("/technicians/{user_id}/photo", response_model=TechnicianOut)
async def remove_photo(user_id: uuid.UUID, db: DB, actor: TechniciansEdit) -> TechnicianOut:
    """Tira a foto, também a que veio do Field Control (no lugar ficam as iniciais)."""
    user = await svc.get_technician(db, user_id)
    changes, previous = svc.remove_photo(db, user, via=VIA_CENTRAL, actor=actor)
    if changes:
        await db.commit()
        await svc.drop_unused_photo(db, previous, user.id)
        await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return await _one(db, user)


@router.post("/technicians/import", response_model=ImportResult)
async def import_technicians(
    db: DB,
    _: TechniciansEdit,
    file: Annotated[UploadFile, File()],
    dry_run: bool = True,
) -> ImportResult:
    """Planilha CSV ou XLSX (até 5 MB). Por padrão só mostra a prévia; dry_run=false grava."""
    try:
        data = await read_upload(file, MAX_BYTES)
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
    return stored_file(user.avatar_key)


@router.get(
    "/tickets/{ticket_id}/technician-suggestions", response_model=list[TechnicianSuggestion]
)
async def ticket_suggestions(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> list[dict]:
    """Os 5 técnicos mais indicados para a OS (cidade, distância, agenda, skill, carga)."""
    await _ensure_regions(db)
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
    exclude_ticket_id: uuid.UUID | None = None,
) -> list[dict]:
    """Para quem ainda está abrindo a OS: a loja (ou o lugar), o serviço e o horário da visita
    dão o mesmo ranking de uma OS já aberta (distância, histórico na loja, skill, agenda).
    No editor de uma OS aberta, `exclude_ticket_id` tira a própria OS da agenda e da carga."""
    if any(t is not None and t.tzinfo is None for t in (start, end)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Informe o fuso do horário")
    if start is not None and end is not None and end <= start:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "O fim da visita precisa ser depois do início"
        )
    await _ensure_regions(db)
    location = await db.get(Location, location_id) if location_id else None
    service_type = await db.get(ServiceType, service_type_id) if service_type_id else None
    category = await db.get(Category, category_id) if category_id else None
    project = await db.get(Project, project_id) if project_id else None
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
        exclude_ticket_id=exclude_ticket_id,
    )
    return await suggestions.suggest(db, target, limit=limit)


# ------------------------------------------------- um técnico (sempre depois das rotas fixas)
# GET /technicians/{user_id} declarado antes de /regions, /nearby ou /suggest faria essas rotas
# responderem 422 (o caminho fixo seria lido como id).


@router.get("/technicians/{user_id}/changes", response_model=list[UserChangeOut])
async def technician_changes(
    user_id: uuid.UUID,
    db: DB,
    _: TechniciansView,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[UserChange]:
    """Histórico do cadastro, do mais novo para o mais antigo: pelo técnico (app) e pela central,
    com quem fez. A chave PIX vem só mascarada."""
    user = await svc.get_technician(db, user_id)
    return await user_history.list_changes(db, user.id, limit)


@router.delete("/technicians/{user_id}/pix", status_code=status.HTTP_204_NO_CONTENT)
async def remove_technician_pix(user_id: uuid.UUID, db: DB, actor: PixEdit) -> Response:
    """A central só remove a chave PIX (ex.: chave errada ou suspeita); quem cadastra uma nova é o
    técnico, no app. Sem chave: nada muda."""
    user = await svc.get_technician(db, user_id)
    if svc.has_pix(user):
        before = await user_history.snapshot(db, user)
        svc.clear_pix(user)
        changes = await user_history.track(db, user, before, via=VIA_CENTRAL, actor=actor)
        await db.commit()
        await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/technicians/{user_id}", response_model=TechnicianOut)
async def get_technician(user_id: uuid.UUID, db: DB, _: TechniciansView) -> TechnicianOut:
    """Um técnico (o cadastro aberto por link, ?tecnico= na web). 404 se não for técnico."""
    return await _one(db, await svc.get_technician(db, user_id))

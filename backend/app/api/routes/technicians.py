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
from app.schemas.account import EmailLogOut, EmailQueued
from app.schemas.my_profile import UserChangeOut
from app.schemas.tech_profile import DayPeriod, Weekday
from app.schemas.technician import (
    ImportResult,
    NearbyOut,
    OperationalStatusIn,
    RegionRefresh,
    RegionState,
    TechnicianCreate,
    TechnicianOut,
    TechnicianSuggestion,
    TechnicianUpdate,
    TemporaryPassword,
)
from app.services import login_guard, mail, suggestions, technician_status, user_history
from app.services import technician_levels as levels_svc
from app.services import technician_regions as regions_svc
from app.services import technicians as svc
from app.services import tickets as tickets_svc
from app.services.realtime import commit_and_publish
from app.services.spreadsheet import MAX_BYTES, SpreadsheetError, read_upload

router = APIRouter(tags=["technicians"])

# Tela de Técnicos ("Editar" inclui Liberar acesso, a situação na operação e os e-mails de
# validação e de senha). As regiões também aparecem na Homologação e os técnicos perto da loja,
# no detalhe do Local. As sugestões ficam com toda a gestão. As formas de recebimento do técnico
# são de Pagamentos (api/routes/payouts.py).
TechniciansView = access_user("base.technicians")
TechniciansEdit = access_user("base.technicians", level="edit")
RegionsView = access_user("base.technicians", "base.onboarding")
NearbyView = access_user("base.technicians", "base.locations")

# E-mails da central para um técnico (validação e link de senha): por hora, cada um.
EMAILS_PER_HOUR = 5
# GET /technicians/{id}/changes?field=: um campo do histórico ("operational_status").
HISTORY_FIELD = r"^[a-z_]{1,40}$"


async def _one(db: DB, user: User) -> TechnicianOut:
    """Um técnico com o detalhe do perfil técnico (ferramentas, formação e a data de cada parte)."""
    await db.refresh(user, ["team"])
    return (await svc.to_out(db, [user], detail=True))[0]


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


async def _ensure_levels(db: DB) -> None:
    """Elo dos técnicos calculado ao menos uma vez antes de responder (a lista e as sugestões só
    leem a conta guardada; a rotina periódica mantém em dia)."""
    if await levels_svc.ensure_computed(db):
        await db.commit()


async def _email_limit(scope: str, user_id: uuid.UUID) -> None:
    """Até EMAILS_PER_HOUR e-mails do mesmo tipo por técnico na hora: 429 com Retry-After."""
    try:
        await login_guard.hit(scope, str(user_id), EMAILS_PER_HOUR, 3600)
    except login_guard.RateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc


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
    tool_id: uuid.UUID | None = None,
    day: Weekday | None = None,
    period: DayPeriod | None = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 2000,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[TechnicianOut]:
    """Base técnica. `state`/`city` filtram pela região de atuação (histórico) ou pelo endereço;
    `tool_id`, pela ferramenta marcada no app; `day` e `period` (cada um opcional), pela
    disponibilidade informada no app (quem nunca informou não entra). O total que bate com os
    filtros vai no cabeçalho X-Total-Count (a lista é paginada; a web pede `q` e `limit=5000` e
    filtra na tela). Cada técnico traz o resumo do perfil técnico (com as áreas e as aptidões
    ativas), a certificação vencendo e a média das avaliações; o detalhe (nomes das ferramentas e
    das áreas, formação, datas) fica em GET /technicians/{id}."""
    await _ensure_regions(db)
    await _ensure_levels(db)
    items, total = await svc.list_technicians(
        db,
        q,
        team_id,
        active,
        state,
        city,
        tool_id=tool_id,
        day=day,
        period=period,
        limit=limit,
        offset=offset,
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
    """Só os campos enviados mudam (campo que a ficha não tem é ignorado). Desativar fecha as
    ofertas em aberto dele (o tempo real das OS sai no commit) e invalida os links de senha.
    Trocar o e-mail troca o login na hora, zera a validação e manda o link para o novo (sai depois
    do commit). CPF repetido: 409.

    Perfil profissional (`tool_ids`, `availability`, `unavailability`, `transport`,
    `vehicle_model`, `vehicle_plate`, `education`, `skills` [{skill_id, level}] e `area_ids`):
    cada parte inteira, com as regras e as mensagens do app (422: "Ferramenta não encontrada.
    Atualize a lista.", AREA_NOT_FOUND, SKILL_NOT_FOUND, SKILL_REPEATED, AREAS_LIMIT, turnos,
    placa, períodos) e o carimbo "central" na parte. Uma gravação por vez por técnico (a trava do
    app). O que mudou fica no histórico do cadastro (via central); depois do commit, o aviso à
    central e, quando é algo que o app mostra, o me.profile_changed só para o técnico."""
    user = await svc.get_technician(db, user_id)
    changes = await svc.update(db, user, body, actor)
    await commit_and_publish(db)
    await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return await _one(db, user)


@router.post("/technicians/{user_id}/reset-password", response_model=TemporaryPassword)
async def reset_password(user_id: uuid.UUID, db: DB, actor: TechniciansEdit) -> TemporaryPassword:
    """Esqueceu a senha: gera uma provisória e encerra as sessões abertas do técnico (os links de
    senha mandados por e-mail deixam de valer)."""
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
    """Os 5 técnicos mais indicados para a OS (cidade, distância, agenda, skill, carga e a
    disponibilidade informada no app, um sinal pequeno que não tira ninguém da lista)."""
    await _ensure_regions(db)
    await _ensure_levels(db)
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
    dão o mesmo ranking de uma OS já aberta (distância, histórico na loja, skill, agenda e a
    disponibilidade informada no app). No editor de uma OS aberta, `exclude_ticket_id` tira a
    própria OS da agenda e da carga."""
    if any(t is not None and t.tzinfo is None for t in (start, end)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Informe o fuso do horário")
    if start is not None and end is not None and end <= start:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "O fim da visita precisa ser depois do início"
        )
    await _ensure_regions(db)
    await _ensure_levels(db)
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
    viewer: TechniciansView,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before: str | None = None,
    field: Annotated[str | None, Query(pattern=HISTORY_FIELD)] = None,
) -> list[UserChange] | list[UserChangeOut]:
    """Histórico do cadastro, do mais novo para o mais antigo: pelo técnico (app ou link do
    e-mail), pela central e pela aprovação da ficha, com quem fez e o motivo (`note`). Dados de
    recebimento vêm só mascarados; para quem não tem Pagamentos, nem isso (user_history.for_viewer).
    `field`: só as linhas que mexeram nesse campo (a situação: "operational_status"). Páginas:
    `before` = "{created_at}|{id}" da última linha recebida traz as `limit` linhas seguintes (mais
    antigas); estragado, 422 "Página do histórico inválida. Recarregue a ficha.". Sem ele, as mais
    novas."""
    user = await svc.get_technician(db, user_id)
    rows = await user_history.list_changes(db, user.id, limit, before, field=field)
    return user_history.for_viewer(rows, viewer)


@router.post("/technicians/{user_id}/operational-status", response_model=TechnicianOut)
async def change_operational_status(
    user_id: uuid.UUID, body: OperationalStatusIn, db: DB, actor: TechniciansEdit
) -> TechnicianOut:
    """Situação na operação (Ativo, Inativo, Bloqueado) com o motivo (3 a 500): o motivo e o
    registro são a autorização. A mesma situação: 409. Inativo ou Bloqueado sai das sugestões,
    das ofertas (as em aberto fecham) e da escolha de técnico; as OS que ele já tem ficam.
    `cut_access` corta também o acesso ao app; reativar não devolve o acesso. Histórico via
    central, com o motivo."""
    user, changes = await technician_status.apply(db, user_id, body, actor)
    await commit_and_publish(db)
    await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return await _one(db, user)


@router.post(
    "/technicians/{user_id}/email-verification",
    response_model=EmailQueued,
    status_code=status.HTTP_202_ACCEPTED,
)
async def send_email_verification(
    user_id: uuid.UUID, db: DB, actor: TechniciansEdit
) -> EmailQueued:
    """Manda (de novo) o link de validação: para o e-mail novo pedido no app ou, sem ele, para o
    login ainda não validado. Já validado: 409; sem endereço que recebe mensagens: 422; até 5 por
    hora (429). Com o envio desligado, "not_configured" (nada sai)."""
    user = await svc.get_technician(db, user_id)
    svc.verification_target(user)
    await _email_limit("mail-resend-central", user.id)
    row, queued = await svc.queue_verification(db, user, actor)
    await db.commit()
    if row is not None and queued == "queued":
        mail.deliver_soon([row.id])
    return mail.queued(row, queued)


@router.post(
    "/technicians/{user_id}/password-reset-link",
    response_model=EmailQueued,
    status_code=status.HTTP_202_ACCEPTED,
)
async def send_password_link(user_id: uuid.UUID, db: DB, actor: TechniciansEdit) -> EmailQueued:
    """Manda ao login do técnico o link para criar uma senha nova (vale 2 h; a senha de hoje
    continua até ele usar o link). Sem acesso ao app: 409; sem endereço que recebe mensagens: 422;
    até 5 por hora (429). Histórico "Link para nova senha: enviado para {e-mail}" (via central).
    A senha provisória continua em POST /technicians/{id}/reset-password."""
    user = await svc.get_technician(db, user_id)
    svc.check_password_link(user)
    await _email_limit("password-link", user.id)
    row, queued, changes = await svc.queue_password_link(db, user, actor)
    await db.commit()
    if row is not None and queued == "queued":
        mail.deliver_soon([row.id])
    await user_history.publish_changed(user, changes, via=VIA_CENTRAL, actor=actor)
    return mail.queued(row, queued)


@router.get("/technicians/{user_id}/emails", response_model=list[EmailLogOut])
async def technician_emails(
    user_id: uuid.UUID,
    db: DB,
    _: TechniciansView,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[EmailLogOut]:
    """Os e-mails pedidos para o técnico (validação, boas-vindas, nova senha), o mais novo
    primeiro, com a situação de cada um ("expired": não saiu no prazo, também com o envio
    desligado)."""
    user = await svc.get_technician(db, user_id)
    return await svc.email_log(db, user, limit)


@router.get("/technicians/{user_id}", response_model=TechnicianOut)
async def get_technician(user_id: uuid.UUID, db: DB, _: TechniciansView) -> TechnicianOut:
    """Um técnico (a ficha em /tecnicos/{id} na web), com o detalhe: os nomes das ferramentas e
    das áreas de atuação ativas, a formação, a data de cada parte do perfil técnico, os dados
    pessoais, a empresa e o veículo. 404 se não for técnico."""
    return await _one(db, await svc.get_technician(db, user_id))

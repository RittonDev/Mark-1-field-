"""Base técnica: analistas e gestores cuidam do cadastro e do acesso dos técnicos ao app.

Só mexe em usuários técnicos (analistas e clientes do portal ficam em Usuários). Dados pessoais,
endereço em partes e empresa a central muda (sem senha); o CPF ela muda e limpa. Trocar o e-mail
troca o login na hora e manda o link de validação (services/account.central_email_changed). O
perfil profissional (veículo, indisponibilidade e o perfil técnico: ferramental, disponibilidade,
transporte, aptidões, formação e áreas de atuação) o técnico mantém no app e a central também edita
no mesmo PATCH, com as regras e as mensagens do app e o carimbo "central" (services/tech_profile.py;
o app recebe me.profile_changed e relê o cadastro). Uma gravação por vez por técnico
(`lock_technician`, a mesma trava do app). A lista filtra a base por ferramenta e por dia/turno
(list_technicians) e traz a certificação vencendo e a média das avaliações do cliente. As formas de
recebimento ficam com Pagamentos (services/payout_methods.py): aqui só a contagem.
"""

import asyncio
import re
import secrets
import uuid
from datetime import timedelta
from typing import Any

from fastapi import UploadFile
from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import (
    AccountTokenPurpose,
    ApplicationStatus,
    EmailStatus,
    EmailTemplate,
    UserRole,
)
from app.core.security import create_token, hash_password_async
from app.db.base import utcnow
from app.models import EmailOutbox, ServiceType, Team, TechnicianApplication, Ticket, User
from app.models.user_change import VIA_CENTRAL
from app.schemas import personal
from app.schemas.account import EmailLogOut, EmailQueuedStatus
from app.schemas.common import Ref
from app.schemas.my_profile import PROFESSIONAL_FIELDS
from app.schemas.tech_profile import DayPeriod, Weekday
from app.schemas.technician import (
    Credential,
    ImportResult,
    ImportRow,
    TechnicianCreate,
    TechnicianOut,
    TechnicianUpdate,
)
from app.services import (
    account,
    cities,
    mail,
    payout_methods,
    search,
    storage,
    tech_profile,
    technician_catalogs,
    technician_levels,
    technician_regions,
    unavailability,
    user_history,
)
from app.services.errors import CodedError, NotFound, WorkflowError
from app.services.spreadsheet import read_table
from app.services.technician_regions import fold_text
from app.services.workflow import OPEN_STATUSES

CPF_TAKEN = "Este CPF já está em outro cadastro"
CPF_TAKEN_CODE = "CPF_TAKEN"
# E-mails pela central (Credenciais da ficha).
EMAIL_ALREADY_VERIFIED = "O e-mail deste técnico já está validado"
EMAIL_ALREADY_VERIFIED_CODE = "EMAIL_ALREADY_VERIFIED"
NO_VALID_EMAIL = "Este técnico não tem e-mail válido. Corrija em Contato ou use a senha provisória"
LINK_NEEDS_ACCESS = "Libere o acesso ao app antes de enviar o link"
LINK_NEEDS_ACCESS_CODE = "APP_ACCESS_REQUIRED"

# Sem letras e números que se confundem (O/0, l/1/I) para ditar por telefone.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
MAX_PHOTO_BYTES = 2 * 1024 * 1024
# Senhas provisórias calculadas ao mesmo tempo na importação (bcrypt em threads).
HASH_CONCURRENCY = 4

IMPORT_ALIASES = {
    "nome": "name",
    "nome_completo": "name",
    "tecnico": "name",
    "e_mail": "email",
    "email": "email",
    "telefone": "phone",
    "celular": "phone",
    "whatsapp": "phone",
    "grupo": "team",
    "equipe": "team",
    "cargo": "job_title",
    "funcao": "job_title",
    "cidade": "home_city",
    "uf": "home_state",
    "estado": "home_state",
    "regiao": "coverage_area",
    "regiao_atendida": "coverage_area",
}


def temporary_password() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(12))


def avatar_url(user: User) -> str | None:
    """Foto enviada aqui (link assinado) ou, sem ela, a que veio do Field Control."""
    if not user.avatar_key:
        return user.avatar_external_url or None
    token = create_token(f"avatar:{user.id}", "download", timedelta(hours=12))
    return f"{settings.API_PREFIX}/users/{user.id}/avatar?token={token}"


def has_photo(user: User) -> bool:
    return bool(user.avatar_key or user.avatar_external_url)


def normalize_zip(value: str | None) -> str | None:
    """CEP com 8 dígitos vira "00000-000"; outro tamanho fica só com os dígitos; vazio, None."""
    digits = re.sub(r"\D", "", value or "")
    return f"{digits[:5]}-{digits[5:]}" if len(digits) == 8 else digits or None


async def canonical_home(
    db: AsyncSession, city: str | None, state: str | None
) -> tuple[str | None, str | None]:
    """Cidade de casa com a grafia padrão da base ("SAO PAULO" vira "São Paulo") e a UF."""
    uf = (state or "").strip().upper() or None
    return await cities.canonical_city(db, uf, city), uf


def set_home(user: User, city: str | None, state: str | None) -> bool:
    """Grava a cidade e a UF de casa (já na grafia padrão: canonical_home). Mudou de cidade ou de
    UF (não só a grafia): as coordenadas antigas de casa saem, porque levariam a sugestões e
    distâncias erradas (a região "pelo endereço" volta quando houver coordenada nova)."""
    same_state = fold_text(state) == fold_text(user.home_state)
    moved = not same_state or fold_text(city) != fold_text(user.home_city)
    user.home_city, user.home_state = city, state
    if moved:
        user.home_latitude = None
        user.home_longitude = None
    return moved


async def get_technician(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None or user.role != UserRole.TECHNICIAN:
        raise NotFound("Técnico não encontrado")
    return user


async def lock_technician(db: AsyncSession, user: User) -> None:
    """Trava a linha do técnico até o fim da transação e relê o cadastro do banco: uma gravação
    por vez (a segunda espera a primeira e trabalha sobre o que ela gravou). O app (Meu cadastro)
    e a central (o PATCH da ficha) usam a mesma trava: os dois mexem no perfil profissional e no
    carimbo dele."""
    await db.execute(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def _email_in_use(db: AsyncSession, email: str, exclude: uuid.UUID | None = None) -> bool:
    stmt = select(User.id).where(func.lower(User.email) == email.lower())
    if exclude is not None:
        stmt = stmt.where(User.id != exclude)
    return (await db.scalar(stmt)) is not None


async def _check_team(db: AsyncSession, team_id: uuid.UUID | None) -> None:
    if team_id is not None and await db.get(Team, team_id) is None:
        raise WorkflowError("Grupo não encontrado")


def _detail_fields(user: User) -> dict[str, Any]:
    """Só no detalhe: dados pessoais, endereço em partes, empresa e veículo."""
    return {
        "cpf": user.cpf,
        "rg_number": user.rg_number,
        "rg_issuer": user.rg_issuer,
        "rg_state": user.rg_state,
        "birth_date": user.birth_date,
        "phone_secondary": user.phone_secondary,
        "bio": user.bio,
        "address_number": user.address_number,
        "address_complement": user.address_complement,
        "company_document": user.company_document,
        "company_name": user.company_name,
        "company_trade_name": user.company_trade_name,
        "vehicle_model": user.vehicle_model,
        "vehicle_plate": user.vehicle_plate,
    }


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.name).where(User.id.in_(ids)))
    return {user_id: name for user_id, name in rows.all()}


async def to_out(
    db: AsyncSession, users: list[User], *, detail: bool = False
) -> list[TechnicianOut]:
    """A ficha dos técnicos para a central. `detail` (um técnico: GET /technicians/{id} e as
    respostas do cadastro) traz também os nomes das ferramentas e das áreas, a formação, a data de
    cada parte do perfil técnico, os dados pessoais, a empresa e o veículo; na lista esses vão
    null. Leitura a mais por página: os catálogos (inteiros, só quando alguém tem o item), a
    certificação vencendo e a média das avaliações."""
    # Imports tardios, como nas sugestões: tracking puxa tickets; documentos e avaliações puxam o
    # histórico do cadastro e as OS.
    from app.services import technician_documents, technician_ratings, tracking

    ids = [u.id for u in users]
    if not ids:
        return []
    # Em jornada: aberta e dentro do limite, a regra do mapa e das sugestões (a jornada esquecida
    # aberta não fica "Em jornada" para sempre).
    on_shift = set(await tracking.active_shifts(db, ids))
    open_counts = dict(
        (
            await db.execute(
                select(Ticket.assignee_id, func.count())
                .where(Ticket.assignee_id.in_(ids), Ticket.status.in_(OPEN_STATUSES))
                .group_by(Ticket.assignee_id)
            )
        ).all()
    )
    # O link da ficha aprovada (as áreas são do cadastro: a aprovação e a migração copiaram).
    applications = {
        user_id: application_id
        for user_id, application_id in await db.execute(
            select(TechnicianApplication.user_id, TechnicianApplication.id).where(
                TechnicianApplication.user_id.in_(ids),
                TechnicianApplication.status == ApplicationStatus.APPROVED,
            )
        )
    }
    # Ferramental, Aptidões e Áreas de atuação: o catálogo inteiro (ativos e desativados; ≤ 300
    # linhas cada), só se alguém tem algum item dele.
    catalog = await tech_profile.tool_catalog(db) if any(u.tool_ids for u in users) else {}
    skills = (
        await technician_catalogs.catalog(db, "skill") if any(u.skills for u in users) else {}
    )
    areas = (
        await technician_catalogs.catalog(db, "area") if any(u.service_areas for u in users) else {}
    )
    # A certificação vencendo (ou vencida) e as avaliações do cliente: uma consulta cada.
    due = await technician_documents.due_map(db, ids)
    ratings = await technician_ratings.summaries(db, ids)
    # Serviços que faz (ids gravados na ficha), com o nome atual do tipo de serviço.
    wanted = {sid for u in users for sid in (u.service_type_ids or [])}
    service_names: dict[str, str] = {}
    if wanted:
        valid = []
        for sid in wanted:
            try:
                valid.append(uuid.UUID(str(sid)))
            except ValueError:
                continue
        if valid:
            service_names = {
                str(sid): name
                for sid, name in await db.execute(
                    select(ServiceType.id, ServiceType.name).where(ServiceType.id.in_(valid))
                )
            }
    # Elo: a conta guardada (a rotina refaz a cada 6 h; o cadastro recalcula na hora).
    levels = await technician_levels.summaries(db, ids)
    # Quem mudou a situação por último (o nome) e as formas de recebimento (quantas e a última
    # troca do destino).
    changers = await _names(
        db, {u.operational_changed_by_id for u in users if u.operational_changed_by_id}
    )
    payouts = await payout_methods.counts(db, ids)
    today = personal.local_today()
    out = []
    for u in users:
        education = tech_profile.education_of(u)
        changer = u.operational_changed_by_id
        methods, payout_changed_at = payouts.get(u.id, (0, None))
        rating_average, rating_count = ratings.get(u.id, (None, 0))
        out.append(
            TechnicianOut(
                id=u.id,
                name=u.name,
                email=u.email,
                phone=u.phone,
                job_title=u.job_title,
                team={"id": u.team.id, "name": u.team.name} if u.team else None,
                home_city=u.home_city,
                home_state=u.home_state,
                coverage_area=u.coverage_area,
                is_active=u.is_active,
                last_login_at=u.last_login_at,
                location_consent_at=u.location_consent_at,
                must_change_password=u.must_change_password,
                created_at=u.created_at,
                avatar_url=avatar_url(u),
                on_shift=u.id in on_shift,
                open_tickets=open_counts.get(u.id, 0),
                skills=tech_profile.skills_of(u, skills),
                area_ids=tech_profile.active_area_ids(u, areas),
                areas=tech_profile.areas_of(u, areas) if detail else None,
                certification_due=due.get(u.id),
                rating_average=rating_average,
                rating_count=rating_count,
                application_id=applications.get(u.id),
                base_city=u.base_city,
                base_state=u.base_state,
                base_source=u.base_source,  # type: ignore[arg-type]
                base_visits=u.base_visits or 0,
                last_visit_at=u.last_visit_at,
                address_line=u.address_line,
                address_district=u.address_district,
                address_zip=u.address_zip,
                work_schedule=u.work_schedule or None,
                services=[
                    {"id": sid, "name": service_names[str(sid)]}
                    for sid in (u.service_type_ids or [])
                    if str(sid) in service_names
                ],
                legacy=u.legacy,
                level=technician_levels.summary_of(levels, u.id),
                tool_ids=tech_profile.active_tool_ids(u, catalog),
                availability=tech_profile.sort_slots(u.availability or []),
                transport=tech_profile.transport_of(u),
                education_count=len(education),
                tech_profile_updated_at=tech_profile.latest_stamp(u),
                tools=tech_profile.tool_refs(u, catalog) if detail else None,
                education=education if detail else None,
                tech_profile_updated=tech_profile.stamps_of(u) if detail else None,
                operational_status=u.operational_status,
                operational_reason=u.operational_reason,
                operational_changed_at=u.operational_changed_at,
                operational_changed_by=(
                    Ref(id=changer, name=changers[changer]) if changer in changers else None
                ),
                unavailability=unavailability.current(u.unavailability, today),
                email_verified_at=u.email_verified_at,
                email_pending=u.email_pending,
                payout_methods_count=methods,
                payout_changed_at=payout_changed_at if methods else None,
                **(_detail_fields(u) if detail else {}),
            )
        )
    return out


def availability_filter(
    day: Weekday | None, period: DayPeriod | None
) -> ColumnElement[bool] | None:
    """Disponível no dia e/ou no turno, pelo que o técnico informou no app: os dois, aquele turno
    daquele dia; só o dia, qualquer turno dele; só o turno, em qualquer dia. Quem nunca informou
    não entra. Sem os dois, None (sem filtro)."""
    if day is None and period is None:
        return None
    days = (day,) if day is not None else tech_profile.WEEKDAYS
    periods = (period,) if period is not None else tech_profile.PERIODS
    return or_(*(User.availability.contains([f"{d}:{p}"]) for d in days for p in periods))


async def list_technicians(
    db: AsyncSession,
    q: str | None,
    team_id: uuid.UUID | None,
    active: bool | None,
    state: str | None = None,
    city: str | None = None,
    *,
    tool_id: uuid.UUID | None = None,
    day: Weekday | None = None,
    period: DayPeriod | None = None,
    limit: int = 2000,
    offset: int = 0,
) -> tuple[list[TechnicianOut], int]:
    """Uma página da base técnica e o total que bate com os filtros. `tool_id`: quem marcou a
    ferramenta (a mesma regra da contagem do catálogo); `day`/`period`: availability_filter."""
    conds = [User.role == UserRole.TECHNICIAN]
    region = technician_regions.region_filter(state, city)
    if region is not None:
        conds.append(region)
    if tool_id is not None:
        conds.append(User.tool_ids.contains([str(tool_id)]))
    available = availability_filter(day, period)
    if available is not None:
        conds.append(available)
    # Busca por palavras: cada uma em nome, e-mail ou telefone, em qualquer ordem e sem acento.
    matched = search.all_words(q, [User.name, User.email], digit_columns=[User.phone])
    if matched is not None:
        conds.append(matched)
    if team_id is not None:
        conds.append(User.team_id == team_id)
    if active is not None:
        conds.append(User.is_active.is_(active))
    total = await db.scalar(select(func.count()).select_from(User).where(*conds)) or 0
    order = [search.rank(q, User.name), User.name] if matched is not None else [User.name]
    stmt = select(User).where(*conds).order_by(*order, User.id).offset(offset).limit(limit)
    users = list(await db.scalars(stmt))
    return await to_out(db, users), total


async def create(db: AsyncSession, data: TechnicianCreate) -> tuple[User, str]:
    if await _email_in_use(db, data.email):
        raise WorkflowError("E-mail já cadastrado")
    await _check_team(db, data.team_id)
    password = temporary_password()
    home_state = (data.home_state or "").strip().upper() or None
    user = User(
        id=uuid.uuid4(),
        name=data.name.strip(),
        email=data.email,
        phone=(data.phone or "").strip() or None,
        password_hash=await hash_password_async(password),
        role=UserRole.TECHNICIAN,
        job_title=(data.job_title or "").strip() or "Técnico de campo",
        team_id=data.team_id,
        home_city=await cities.canonical_city(db, home_state, data.home_city),
        home_state=home_state,
        coverage_area=(data.coverage_area or "").strip() or None,
        is_active=True,
        must_change_password=True,
    )
    db.add(user)
    await db.flush()
    return user, password


async def cpf_in_use(db: AsyncSession, cpf: str, exclude: uuid.UUID | None = None) -> bool:
    """O CPF (11 números) já é de outro usuário."""
    stmt = select(User.id).where(User.cpf == cpf)
    if exclude is not None:
        stmt = stmt.where(User.id != exclude)
    return (await db.scalar(stmt.limit(1))) is not None


def _group(fields: dict[str, Any], user: User, keys: tuple[str, str, str], check: Any) -> None:
    """RG e empresa vão em grupo: o enviado com o que está gravado, conferido junto (o grupo
    inteiro entra em `fields`)."""
    if not fields.keys() & set(keys):
        return
    try:
        values = check(*(fields.get(key, getattr(user, key)) for key in keys))
    except ValueError as exc:
        raise WorkflowError(str(exc)) from None
    fields.update(zip(keys, values, strict=True))


async def update(
    db: AsyncSession, user: User, data: TechnicianUpdate, actor: User | None = None
) -> list[dict[str, Any]]:
    """PATCH /technicians/{id} (o commit e os avisos são da rota): grava o que mudou e o histórico
    do cadastro (via central) e devolve as mudanças (vazio: nada mudou). `actor`: quem alterou
    (autor do histórico, do fechamento das ofertas do técnico desativado e do link de validação do
    e-mail novo).

    Uma gravação por vez por técnico (`lock_technician`, a trava do app): o cadastro é relido
    depois da trava. O perfil profissional segue as regras e as mensagens do app: as partes do
    perfil técnico por tech_profile.wanted/apply com o carimbo "central" (e o 1º uso dos itens do
    catálogo), a indisponibilidade por unavailability.wanted e o veículo como veio (os validadores
    são os do app)."""
    from app.services import tickets  # import tardio, como o tracking em to_out

    fields = data.model_dump(exclude_unset=True)
    profile = {key: fields.pop(key) for key in PROFESSIONAL_FIELDS if key in fields}
    if fields.get("is_active") is False:
        # Sem o app, ninguém responde as ofertas dele: fecham como canceladas pela central (a OS
        # volta a "Sem técnico"). Antes da trava do técnico: as OS travam antes da linha dele,
        # como no aceite. Os avisos saem no commit da rota.
        await tickets.close_technician_offers(db, user.id, actor)
    await lock_technician(db, user)
    if (
        fields.get("cpf")
        and fields["cpf"] != user.cpf
        and await cpf_in_use(db, fields["cpf"], user.id)
    ):
        raise CodedError(CPF_TAKEN, CPF_TAKEN_CODE, 409)
    _group(fields, user, ("rg_number", "rg_issuer", "rg_state"), personal.rg_group)
    _group(
        fields,
        user,
        ("company_document", "company_name", "company_trade_name"),
        personal.company_group,
    )
    if fields.get("service_type_ids") is not None:
        wanted = list(dict.fromkeys(fields["service_type_ids"]))
        found = set(await db.scalars(select(ServiceType.id).where(ServiceType.id.in_(wanted))))
        if len(found) != len(wanted):
            raise WorkflowError("Tipo de serviço não encontrado")
        fields["service_type_ids"] = [str(sid) for sid in wanted]
    elif "service_type_ids" in fields:
        fields["service_type_ids"] = []
    if "work_schedule" in fields and fields["work_schedule"] is not None:
        schedule = fields["work_schedule"]
        fields["work_schedule"] = schedule if any(schedule.values()) else None
    if "address_zip" in fields:
        fields["address_zip"] = normalize_zip(fields["address_zip"])
    if fields.get("email") and await _email_in_use(db, fields["email"], exclude=user.id):
        raise WorkflowError("E-mail já cadastrado")
    email_changed = bool(fields.get("email")) and fields["email"] != (user.email or "").lower()
    if "team_id" in fields:
        await _check_team(db, fields["team_id"])
    home = None
    if "home_city" in fields or "home_state" in fields:
        # Uma grafia só por cidade ("SAO PAULO" vira "São Paulo"), como no resto da base; mudou de
        # cidade, as coordenadas antigas de casa saem (set_home, o mesmo do Meu cadastro).
        home = await canonical_home(
            db, fields.pop("home_city", user.home_city), fields.pop("home_state", user.home_state)
        )
    # O perfil profissional: conferido antes de mudar qualquer coisa (422 com as mensagens do app).
    new = await tech_profile.wanted(db, user, data) if profile else {}
    periods = (
        unavailability.wanted(data.unavailability, user.unavailability, personal.local_today())
        if "unavailability" in profile
        else None
    )
    before = await user_history.snapshot(db, user)
    for key, value in fields.items():
        if key in (
            "name",
            "phone",
            "job_title",
            "coverage_area",
            "address_line",
            "address_district",
        ) and isinstance(value, str):
            value = value.strip() or None
        if key == "name" and not value:
            continue
        if key == "email" and not value:
            continue
        setattr(user, key, value)
    if home is not None:
        set_home(user, *home)
    if fields.get("is_active") is False:
        user.sessions_revoked_at = utcnow()  # desativado: sai do app na hora
        # Sem acesso, os links de senha mandados por e-mail deixam de valer.
        await account.revoke(db, user_id=user.id, purpose=AccountTokenPurpose.RESET_PASSWORD)
    if email_changed:
        # O login muda na hora: a validação recomeça e o link vai para o e-mail novo (sai depois
        # do commit; nada quando o endereço não recebe mensagens).
        await account.central_email_changed(db, user, actor)
    tech_profile.apply(user, new, via=tech_profile.VIA_CENTRAL, at=utcnow())
    await tech_profile.mark_used(db, new)
    if periods is not None:
        user.unavailability = [dict(period) for period in periods]
    for key in ("vehicle_model", "vehicle_plate"):
        if key in profile:
            setattr(user, key, profile[key])
    await db.flush()
    return await user_history.track(db, user, before, via=VIA_CENTRAL, actor=actor)


async def reset_password(db: AsyncSession, user: User) -> str:
    """Senha provisória nova; o técnico troca no próximo acesso, as sessões abertas caem e os
    links de senha mandados por e-mail deixam de valer."""
    password = temporary_password()
    user.password_hash = await hash_password_async(password)
    user.must_change_password = True
    user.sessions_revoked_at = utcnow()
    await account.revoke(db, user_id=user.id, purpose=AccountTokenPurpose.RESET_PASSWORD)
    await db.flush()
    return password


# ------------------------------------------------------------------ e-mails pela central


def verification_target(user: User) -> tuple[str, str]:
    """Para onde vai a validação pedida pela central: o e-mail novo pedido no app ("change") ou,
    sem ele, o login ainda não validado ("check"). Já validado e sem pedido: 409; endereço que não
    recebe mensagens: 422."""
    if user.email_pending:
        address, reason = user.email_pending, "change"
    elif user.email_verified_at is not None:
        raise CodedError(EMAIL_ALREADY_VERIFIED, EMAIL_ALREADY_VERIFIED_CODE, 409)
    else:
        address, reason = user.email, "check"
    if not mail.sendable(address):
        raise WorkflowError(NO_VALID_EMAIL)
    return address, reason


def check_password_link(user: User) -> None:
    """O link de senha pede o acesso liberado (409) e um login que recebe mensagens (422)."""
    if not user.is_active:
        raise CodedError(LINK_NEEDS_ACCESS, LINK_NEEDS_ACCESS_CODE, 409)
    if not mail.sendable(user.email):
        raise WorkflowError(NO_VALID_EMAIL)


async def queue_verification(
    db: AsyncSession, user: User, actor: User
) -> tuple[EmailOutbox | None, EmailQueuedStatus]:
    """A validação do e-mail na fila (o commit e o `deliver_soon` são da rota)."""
    address, reason = verification_target(user)
    return await mail.enqueue(
        db,
        template=EmailTemplate.VERIFY_EMAIL,
        to_email=address,
        user=user,
        context={"name": user.name, "reason": reason},
        created_by=actor,
    )


async def queue_password_link(
    db: AsyncSession, user: User, actor: User
) -> tuple[EmailOutbox | None, EmailQueuedStatus, list[dict[str, Any]]]:
    """O link para criar uma senha nova, na fila, e a linha do histórico ("enviado para {e-mail}",
    via central) quando ele vai sair. Não mexe na senha nem nas sessões (isso acontece quando o
    técnico cria a senha pelo link) e não conta como redefinição da central para o aviso de 72 h
    (o campo é `password_link`, não `password`)."""
    check_password_link(user)
    row, status = await mail.enqueue(
        db,
        template=EmailTemplate.PASSWORD_RESET,
        to_email=user.email,
        user=user,
        context={"name": user.name, "origin": "central"},
        created_by=actor,
    )
    changes: list[dict[str, Any]] = []
    if row is not None and status == "queued":
        changes = [{"field": "password_link", "from": None, "to": f"enviado para {row.to_email}"}]
        user_history.record(db, user, changes, via=VIA_CENTRAL, actor=actor)
    return row, status, changes


async def email_log(db: AsyncSession, user: User, limit: int = 20) -> list[EmailLogOut]:
    """Os e-mails pedidos para o técnico, o mais novo primeiro. O pendente que passou do prazo de
    envio sai como "expired" (a fila vence na próxima rodada)."""
    rows = await db.scalars(
        select(EmailOutbox)
        .where(EmailOutbox.user_id == user.id)
        .order_by(EmailOutbox.created_at.desc(), EmailOutbox.id.desc())
        .limit(limit)
    )
    now = utcnow()
    out: list[EmailLogOut] = []
    for row in rows:
        item = EmailLogOut.model_validate(row)
        if item.status == EmailStatus.PENDING and row.send_by < now:
            item.status = EmailStatus.EXPIRED
        out.append(item)
    return out


async def set_photo(
    db: AsyncSession, user: User, upload: UploadFile, *, via: str, actor: User | None
) -> tuple[list[dict[str, Any]], str | None]:
    """Foto nova (até 2 MB; JPG, PNG ou WebP pelo conteúdo), com o histórico do cadastro. Devolve
    as mudanças e a chave da foto anterior, para apagar do disco depois do commit
    (drop_unused_photo)."""
    raw = await upload.read(MAX_PHOTO_BYTES + 1)
    if len(raw) > MAX_PHOTO_BYTES:
        raise WorkflowError("Foto maior que 2 MB")
    ext = storage.image_extension(raw)
    if ext is None:
        raise WorkflowError("Envie uma imagem JPG, PNG ou WebP")
    previous = user.avatar_key
    user.avatar_key = await storage.save_bytes("avatars", ext, raw)
    changes = [dict(user_history.PHOTO_ADDED)]
    user_history.record(db, user, changes, via=via, actor=actor)
    await db.flush()
    return changes, previous


def remove_photo(
    db: AsyncSession, user: User, *, via: str, actor: User | None
) -> tuple[list[dict[str, Any]], str | None]:
    """Tira a foto: a enviada aqui e também a que veio do Field Control (direito do titular); no
    lugar ficam as iniciais. Sem foto, nada muda (sem histórico). Devolve as mudanças e a chave a
    apagar do disco depois do commit (drop_unused_photo)."""
    if not has_photo(user):
        return [], None
    previous = user.avatar_key
    user.avatar_key = None
    user.avatar_external_url = None
    changes = [dict(user_history.PHOTO_REMOVED)]
    user_history.record(db, user, changes, via=via, actor=actor)
    return changes, previous


async def drop_unused_photo(db: AsyncSession, key: str | None, user_id: uuid.UUID) -> None:
    """Depois do commit: a foto antiga sai do disco se nenhum outro usuário nem ficha de homologação
    usa (a ficha aprovada guarda a foto com que ele se cadastrou). O próprio usuário fica de fora
    da busca: com autoflush=False, antes do commit o banco ainda teria a chave antiga dele."""
    if not key:
        return
    other_user = await db.scalar(
        select(User.id).where(User.avatar_key == key, User.id != user_id).limit(1)
    )
    application = await db.scalar(
        select(TechnicianApplication.id).where(TechnicianApplication.photo_key == key).limit(1)
    )
    if other_user is None and application is None:
        storage.delete(key)


async def import_file(db: AsyncSession, filename: str, data: bytes, dry_run: bool) -> ImportResult:
    """Importa a base de técnicos (nome, e-mail, telefone, grupo, cargo).

    E-mail novo cria o técnico com senha provisória; e-mail de técnico existente atualiza
    nome, telefone, grupo e cargo (a senha não muda). Na prévia (dry_run) nada é gravado.
    """
    rows = read_table(filename, data, IMPORT_ALIASES)
    teams = {t.name.strip().lower(): t for t in await db.scalars(select(Team))}
    existing = {
        u.email.lower(): u
        for u in await db.scalars(
            select(User).where(
                func.lower(User.email).in_([r.get("email", "").strip().lower() for r in rows])
            )
        )
    }
    seen: set[str] = set()
    city_cache: dict[tuple[str, str], str] = {}
    new_users: list[tuple[User, str]] = []
    result = ImportResult(dry_run=dry_run, rows=[], created=0, updated=0, errors=0)
    for index, row in enumerate(rows, start=2):  # linha 1 = cabeçalho
        name = " ".join(row.get("name", "").split())[:160]
        email = row.get("email", "").strip().lower()
        phone = row.get("phone", "").strip()[:40] or None
        team_name = row.get("team", "").strip() or None
        job_title = row.get("job_title", "").strip()[:120] or None
        home_state = row.get("home_state", "").strip().upper()[:2] or None
        home_city = await cities.canonical_city(
            db, home_state, row.get("home_city", "")[:120], city_cache
        )
        coverage_area = row.get("coverage_area", "").strip() or None
        errors = []
        if len(name) < 3:
            errors.append("Nome obrigatório")
        if "@" not in email or "." not in email.split("@")[-1] or len(email) > 255:
            errors.append("E-mail inválido")
        elif email in seen:
            errors.append("E-mail repetido na planilha")
        team = teams.get(team_name.lower()) if team_name else None
        if team_name and team is None:
            errors.append(f'Grupo "{team_name}" não existe')
        current = existing.get(email)
        if current is not None and current.role != UserRole.TECHNICIAN:
            errors.append("E-mail já usado por um usuário que não é técnico")
        seen.add(email)

        action = "error" if errors else ("update" if current else "create")
        result.rows.append(
            ImportRow(
                line=index,
                name=name,
                email=email,
                phone=phone,
                team=team_name,
                action=action,
                errors=errors,
            )
        )
        if action == "error":
            result.errors += 1
            continue
        if action == "update":
            result.updated += 1
        else:
            result.created += 1
        if dry_run:
            continue
        if current is not None:
            current.name = name
            current.phone = phone or current.phone
            if team is not None:
                current.team_id = team.id
            if job_title:
                current.job_title = job_title
            if home_city:
                current.home_city = home_city
            if home_state:
                current.home_state = home_state
            if coverage_area:
                current.coverage_area = coverage_area
        else:
            password = temporary_password()
            user = User(
                id=uuid.uuid4(),
                name=name,
                email=email,
                phone=phone,
                role=UserRole.TECHNICIAN,
                job_title=job_title or "Técnico de campo",
                team_id=team.id if team else None,
                home_city=home_city,
                home_state=home_state,
                coverage_area=coverage_area,
                is_active=True,
                must_change_password=True,
            )
            new_users.append((user, password))
            result.credentials.append(
                Credential(name=name, email=email, temporary_password=password)
            )
    if not dry_run:
        # bcrypt é lento de propósito (~0,2 s): as senhas provisórias são calculadas em paralelo,
        # fora do laço de eventos, para a planilha grande não estourar o tempo da requisição.
        limiter = asyncio.Semaphore(HASH_CONCURRENCY)

        async def hashed(password: str) -> str:
            async with limiter:
                return await hash_password_async(password)

        hashes = await asyncio.gather(*(hashed(password) for _, password in new_users))
        for (user, _), password_hash in zip(new_users, hashes, strict=True):
            user.password_hash = password_hash
            db.add(user)
        await db.flush()
    return result

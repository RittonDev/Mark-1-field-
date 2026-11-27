"""Homologação de técnicos: convites, ficha pública e análise (aprovar, reprovar, reabrir).

- Ficha: ao enviar, o link de validação do e-mail vai para a fila (reason "signup"); a gestão
  reenvia enquanto ela está em análise. As áreas de atuação e as aptidões vêm dos catálogos de
  Configurações › Técnicos (services/technician_catalogs.py): a ficha guarda os ids (a aberta antes
  da Entrega 2 manda os códigos e os nomes, trocados pelos ids no envio) e o envio marca o 1º uso.
  Os arquivos (certificações, documentos pessoais e currículo) vão depois do envio, com o token de
  2 h da resposta (services/technician_documents.py).
- Aprovar é um passo só: cria o técnico com tudo o que a ficha coletou (dados pessoais, endereço em
  partes, empresa, veículo, a validação do e-mail e o perfil técnico com as áreas), passa os
  arquivos da ficha para ele, grava a linha "Aprovado na homologação" no histórico do cadastro (via
  ficha, um item por arquivo) e põe a boas-vindas na fila. A ficha de antes (endereço numa linha,
  sem o número) tem o endereço separado com a regra da migração (personal.split_address_line).
- Reprovar guarda o motivo e apaga a senha da ficha. A reprovada pode ser reaberta (com motivo) e
  analisada de novo. Aprovada sem senha: com o e-mail validado, a boas-vindas leva o link para
  criar a senha; sem a validação, não (o link entregaria a conta a quem tem o endereço digitado
  errado): a central gera a senha provisória e manda pelo WhatsApp (`password_link`).
- Cada análise fica em `reviews` (aprovada, reprovada, reaberta, expirada), com quem e quando.

LGPD: a ficha reprovada (ou pendente sem análise) não fica guardada para sempre. Depois de
ONBOARDING_RETENTION_DAYS contados da última análise (a pendente, do envio ou da reabertura) a
rotina periódica apaga a ficha, a foto e os arquivos, com os links e os e-mails dela
(`purge_expired`), e a gestão apaga na hora quando o próprio técnico pede (`delete_application`).
"""

import hashlib
import re
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.config import settings
from app.core.documents import is_valid_cnpj, is_valid_cpf, normalize_document
from app.core.enums import ApplicationStatus, EmailTemplate, OperationalStatus, UserRole
from app.core.security import hash_password_async
from app.core.text import fold
from app.db.base import utcnow
from app.models import EmailOutbox, OnboardingInvite, Team, TechnicianApplication, User
from app.models.user_change import VIA_FICHA
from app.schemas import personal
from app.schemas.account import EmailQueuedStatus
from app.schemas.common import Ref
from app.schemas.onboarding import (
    PRIVACY_VERSION,
    ApplicationApprove,
    ApplicationIn,
    ApplicationSkillOut,
    ApplicationSummary,
    InviteCreate,
    InviteState,
)
from app.services import (
    cities,
    mail,
    storage,
    tech_profile,
    technician_catalogs,
    technician_documents,
    user_history,
)
from app.services.errors import CodedError, NotFound, WorkflowError
from app.services.realtime import bus
from app.services.technician_catalogs import CatalogInfo

MAX_PHOTO_BYTES = 2 * 1024 * 1024
LINK_KIND = "onboarding"
EXPIRED_NOTE = "Expirada sem análise"
COMPANY_EMAIL = "Use um e-mail que não seja da empresa"
# Aprovar, reabrir e reenviar a validação: (texto, code) dos 409.
USER_EMAIL_TAKEN = "Já existe um usuário com este e-mail"
CPF_TAKEN = ("Este CPF já está em outro cadastro", "CPF_TAKEN")
REOPEN_NOT_REJECTED = ("Só a ficha reprovada pode ser reaberta", "APPLICATION_NOT_REJECTED")
REOPEN_EMAIL_TAKEN = (USER_EMAIL_TAKEN, "EMAIL_TAKEN")
OTHER_APPLICATION = ("Há outra ficha desta pessoa em análise ou aprovada", "APPLICATION_DUPLICATE")
RESEND_NOT_PENDING = ("Reenvio só para ficha em análise", "APPLICATION_NOT_PENDING")
EMAIL_ALREADY_VERIFIED = ("E-mail já validado", "EMAIL_ALREADY_VERIFIED")
APPROVED_LINE = "Aprovado na homologação ({protocol})"


def _conflict(pair: tuple[str, str]) -> CodedError:
    message, code = pair
    return CodedError(message, code, 409)


class InviteUnavailable(Exception):
    """Link inexistente, expirado, revogado ou já usado."""


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def token_of(invite: OnboardingInvite) -> str:
    """Token do link: id do convite + HMAC com o segredo da API (core/links.py). O banco guarda só
    o hash, mas o link pode ser copiado de novo enquanto estiver ativo."""
    return links.token_for(LINK_KIND, invite.id.hex)


def invite_url(invite: OnboardingInvite) -> str | None:
    """Link para copiar; None nos convites antigos (token aleatório, só o hash no banco)."""
    token = token_of(invite)
    if hash_token(token) != invite.token_hash:
        return None
    return f"{settings.WEB_URL.rstrip('/')}/cadastro-tecnico/{token}"


def invite_state(invite: OnboardingInvite) -> InviteState:
    if invite.revoked_at is not None:
        return "revoked"
    if invite.max_uses is not None and invite.use_count >= invite.max_uses:
        return "used"
    if invite.expires_at <= utcnow():
        return "expired"
    return "active"


async def create_invite(
    db: AsyncSession, data: InviteCreate, actor: User
) -> tuple[OnboardingInvite, str]:
    invite = OnboardingInvite(
        id=uuid.uuid4(),
        label=(data.label or "").strip() or None,
        max_uses=data.max_uses if data.reusable else 1,
        use_count=0,
        expires_at=utcnow() + timedelta(days=data.days_valid),
        created_by_id=actor.id,
    )
    token = token_of(invite)
    invite.token_hash = hash_token(token)
    db.add(invite)
    await db.flush()
    await db.refresh(invite, ["created_by"])
    return invite, token


async def active_invite(db: AsyncSession, token: str, *, lock: bool = False) -> OnboardingInvite:
    """Convite ativo do token. `lock` segura a linha até o fim da transação: duas fichas ao
    mesmo tempo no link de uso único não passam juntas."""
    stmt = select(OnboardingInvite).where(OnboardingInvite.token_hash == hash_token(token))
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    invite = await db.scalar(stmt)
    if invite is None or invite_state(invite) != "active":
        raise InviteUnavailable
    return invite


def _decode_photo(data_url: str) -> tuple[bytes, str]:
    try:
        return storage.decode_image_data_url(data_url, MAX_PHOTO_BYTES)
    except storage.InvalidImage as exc:
        raise WorkflowError(str(exc)) from exc


def company_email(email: str) -> bool:
    """E-mail de um domínio da empresa (os do login Microsoft, settings.entra_domains). O técnico é
    terceiro: com um desses no login dele, a pessoa contratada com esse e-mail não entraria pela
    Microsoft (o login acha o técnico pelo e-mail) e a central não conseguiria cadastrá-la. Mesma
    comparação do login Microsoft (services/entra.py): o domínio exato."""
    if "@" not in email:
        return False
    return email.rsplit("@", 1)[1].strip().lower() in settings.entra_domains


async def email_taken(db: AsyncSession, email: str, exclude_id: uuid.UUID | None = None) -> bool:
    if await db.scalar(select(User.id).where(func.lower(User.email) == email.lower())):
        return True
    stmt = select(TechnicianApplication.id).where(
        func.lower(TechnicianApplication.email) == email.lower(),
        TechnicianApplication.status == ApplicationStatus.PENDING,
    )
    if exclude_id is not None:
        stmt = stmt.where(TechnicianApplication.id != exclude_id)
    return (await db.scalar(stmt)) is not None


async def document_taken(db: AsyncSession, document: str) -> bool:
    """CPF já numa ficha pendente ou aprovada, ou no cadastro de um usuário (a mesma pessoa não se
    cadastra duas vezes)."""
    found = await db.scalar(
        select(TechnicianApplication.id)
        .where(
            TechnicianApplication.document == document,
            TechnicianApplication.status.in_(
                (ApplicationStatus.PENDING, ApplicationStatus.APPROVED)
            ),
        )
        .limit(1)
    )
    return found is not None or await cpf_in_use(db, document)


async def cpf_in_use(db: AsyncSession, cpf: str | None) -> bool:
    """O CPF já é de um usuário (users.cpf, único)."""
    if not cpf:
        return False
    return (await db.scalar(select(User.id).where(User.cpf == cpf).limit(1))) is not None


def _ficha_cpf(application: TechnicianApplication) -> str | None:
    """O CPF da ficha como o cadastro grava (11 números válidos); senão nada."""
    digits = re.sub(r"\D", "", application.document or "")
    return digits if len(digits) == 11 and is_valid_cpf(digits) else None


def _ficha_cnpj(application: TechnicianApplication) -> str | None:
    """O CNPJ da ficha como o cadastro grava (14 caracteres válidos); senão nada."""
    value = application.company_document or ""
    if not value.strip() or not is_valid_cnpj(value):
        return None
    normalized = normalize_document(value)
    return normalized if normalized and len(normalized) == 14 else None


def ficha_address(
    application: TechnicianApplication,
) -> tuple[str | None, str | None, str | None]:
    """Logradouro, número e complemento que a aprovação grava. Ficha com o logradouro e sem o
    número (a de antes, com a linha inteira "Rua Exemplo, 123 - Apto 4", ou o número digitado no
    logradouro): separado com a regra da migração (personal.split_address_line), com o complemento
    da ficha depois do que veio na linha. O que não separa com segurança (ou os dois complementos
    juntos passariam de 60) fica como está."""
    street = application.address
    number = application.address_number
    complement = application.address_complement
    if not street or number:
        return street, number, complement
    parts = personal.split_address_line(street)
    if parts is None:
        return street, number, complement
    split_street, split_number, split_complement = parts
    joined = " - ".join(dict.fromkeys(p for p in (split_complement, complement) if p)) or None
    if joined and len(joined) > personal.ADDRESS_COMPLEMENT_MAX:
        return street, number, complement
    return split_street, split_number, joined


def welcome_password_link(user: User) -> bool:
    """`password_link` do ApplicationApproved: a boas-vindas leva o link para criar a senha (o
    técnico está sem senha e o e-mail dele está validado). É a regra de mail.sends_password_link,
    que monta a boas-vindas: as duas andam juntas (tests/test_onboarding_v2.py confere a resposta
    e o e-mail)."""
    return bool(user.must_change_password) and user.email_verified_at is not None


def review_entry(
    action: str, actor: User | None, note: str | None, at: datetime | None = None
) -> dict[str, Any]:
    """Uma entrada de `reviews`: {action, at (ISO, UTC), by: {id, name} | null, note}."""
    return {
        "action": action,
        "at": (at or utcnow()).isoformat(),
        "by": {"id": str(actor.id), "name": actor.name} if actor is not None else None,
        "note": note,
    }


def _add_review(
    application: TechnicianApplication,
    action: str,
    actor: User | None,
    note: str | None,
    at: datetime,
) -> None:
    # Uma lista nova: mudar a lista no lugar não grava (JSONB).
    application.reviews = [*(application.reviews or []), review_entry(action, actor, note, at)]


async def submit(
    db: AsyncSession, invite: OnboardingInvite, data: ApplicationIn
) -> TechnicianApplication:
    """Grava a ficha (o commit é da rota). As áreas e as aptidões pelo catálogo: o id ou, na ficha
    aberta antes da Entrega 2, o código e o nome (technician_catalogs.resolve_areas e
    resolve_skills: desconhecida ou desativada recusa, e a área é obrigatória com o catálogo tendo
    alguma ativa); depois, o 1º uso delas fica marcado."""
    if company_email(data.email):
        raise WorkflowError(COMPANY_EMAIL)
    if await email_taken(db, data.email):
        raise WorkflowError(
            "Já existe um cadastro com este e-mail. Se você já enviou a ficha, aguarde a análise."
        )
    if await document_taken(db, data.document):
        raise WorkflowError(
            "Já existe um cadastro com este CPF. Se você já enviou a ficha, aguarde a análise."
        )
    areas = await technician_catalogs.resolve_areas(db, data.service_areas, [], ficha=True)
    skills = await technician_catalogs.resolve_skills(db, data.skills, [], today=None)
    # Valida a foto antes do bcrypt e de gravar qualquer arquivo.
    photo = _decode_photo(data.photo) if data.photo else None
    password_hash = await hash_password_async(data.password)
    photo_key = await storage.save_bytes("onboarding", photo[1], photo[0]) if photo else None

    application = TechnicianApplication(
        id=uuid.uuid4(),
        invite_id=invite.id,
        status=ApplicationStatus.PENDING,
        full_name=data.full_name,
        email=data.email,
        phone=data.phone.strip(),
        phone_secondary=data.phone_secondary,
        document=data.document,
        rg_number=data.rg_number,
        rg_issuer=data.rg_issuer,
        rg_state=data.rg_state,
        birth_date=data.birth_date,
        bio=data.bio,
        postal_code=(data.postal_code or "").strip() or None,
        address=" ".join((data.address or "").split()) or None,
        address_number=data.address_number,
        address_complement=data.address_complement,
        address_district=data.address_district,
        city=data.city,
        state=data.state,
        company_document=data.company_document,
        company_name=data.company_name,
        company_trade_name=data.company_trade_name,
        years_experience=data.years_experience,
        service_areas=areas,
        skills=skills,
        certifications=(data.certifications or "").strip() or None,
        tools=(data.tools or "").strip() or None,
        has_vehicle=data.has_vehicle,
        vehicle_type=data.vehicle_type if data.has_vehicle else None,
        vehicle_model=data.vehicle_model if data.has_vehicle else None,
        vehicle_plate=data.vehicle_plate if data.has_vehicle else None,
        has_driver_license=data.has_driver_license,
        coverage_area=data.coverage_area,
        availability=data.availability,
        notes=(data.notes or "").strip() or None,
        photo_key=photo_key,
        password_hash=password_hash,
        privacy_consent_at=utcnow(),
        privacy_version=PRIVACY_VERSION,
        reviews=[],
    )
    db.add(application)
    invite.use_count += 1
    await db.flush()
    await _mark_used(db, areas, skills)
    return application


def _skill_ids(items: Any) -> list[Any]:
    """Os `skill_id` de uma lista de aptidões guardada (o item estragado fica de fora)."""
    if not isinstance(items, list):
        return []
    return [item.get("skill_id") for item in items if isinstance(item, Mapping)]


async def _mark_used(db: AsyncSession, areas: Any, skills: Any) -> None:
    """O 1º uso das áreas e das aptidões que a ficha (ou o técnico aprovado) gravou: com ele, o
    item não sai mais do catálogo (desativa)."""
    await technician_catalogs.mark_used(db, "area", areas if isinstance(areas, list) else [])
    await technician_catalogs.mark_used(db, "skill", _skill_ids(skills))


def _area_ids(application: TechnicianApplication) -> list[Any]:
    areas = application.service_areas
    return list(areas) if isinstance(areas, list) else []


def summary(
    application: TechnicianApplication, areas: Mapping[str, CatalogInfo]
) -> ApplicationSummary:
    """A ficha na lista da Homologação, com as áreas gravadas (também as desativadas) pelo nome
    atual do catálogo (`areas`: technician_catalogs.catalog, uma leitura para a lista toda)."""
    out = ApplicationSummary.model_validate(application)
    out.areas = technician_catalogs.refs(_area_ids(application), areas, inactive=True)
    return out


def application_skills(raw: Any, info: Mapping[str, CatalogInfo]) -> list[ApplicationSkillOut]:
    """As aptidões da ficha ([{skill_id, level}]) com o nome atual do catálogo, também as
    desativadas (é o que o candidato escolheu), sem repetir, em ordem alfabética. Item estragado
    ou sem a aptidão no catálogo não sai."""
    seen: set[str] = set()
    out: list[ApplicationSkillOut] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        try:
            key = str(uuid.UUID(str(item.get("skill_id"))))
        except ValueError:
            continue
        found, level = info.get(key), item.get("level")
        if found is None or key in seen or not isinstance(level, str):
            continue
        seen.add(key)
        out.append(ApplicationSkillOut(skill_id=uuid.UUID(key), name=found.name, level=level))
    return sorted(out, key=lambda skill: (fold(skill.name), skill.name, str(skill.skill_id)))


async def catalog_parts(
    db: AsyncSession, application: TechnicianApplication
) -> tuple[list[Ref], list[ApplicationSkillOut]]:
    """As áreas (Ref, também as desativadas) e as aptidões da ficha pelo nome atual do catálogo:
    o detalhe da Homologação (duas leituras, só dos ids da ficha)."""
    areas = await technician_catalogs.picked(db, "area", _area_ids(application))
    skills = await technician_catalogs.picked(db, "skill", _skill_ids(application.skills))
    return (
        technician_catalogs.refs(_area_ids(application), areas, inactive=True),
        application_skills(application.skills, skills),
    )


async def queue_verification(
    db: AsyncSession, application: TechnicianApplication, actor: User | None = None
) -> tuple[EmailOutbox | None, EmailQueuedStatus]:
    """O link de validação do e-mail da ficha na fila (reason "signup"); o commit e o
    `mail.deliver_soon` são da rota."""
    return await mail.enqueue(
        db,
        template=EmailTemplate.VERIFY_EMAIL,
        to_email=application.email,
        application=application,
        context={"name": application.full_name, "reason": "signup"},
        created_by=actor,
    )


def check_resend(application: TechnicianApplication) -> None:
    """Reenviar a validação: só a ficha em análise e ainda não validada (409)."""
    if application.status != ApplicationStatus.PENDING:
        raise _conflict(RESEND_NOT_PENDING)
    if application.email_verified_at is not None:
        raise _conflict(EMAIL_ALREADY_VERIFIED)


def protocol(application: TechnicianApplication) -> str:
    return f"HOM-{application.id.hex[:8].upper()}"


async def publish_submitted(application: TechnicianApplication) -> None:
    """Avisa a gestão em tempo real: chegou uma ficha nova."""
    await bus.publish(
        {
            "type": "onboarding.submitted",
            "application_id": str(application.id),
            "name": application.full_name,
            "audience": {"managers_only": True},
        }
    )


async def get_application(
    db: AsyncSession, application_id: uuid.UUID, *, lock: bool = False
) -> TechnicianApplication:
    """A ficha. `lock` (aprovar, reprovar, reabrir) trava a linha até o fim da transação e relê:
    duas análises juntas não passam as duas."""
    if lock:
        application = await db.scalar(
            select(TechnicianApplication)
            .where(TechnicianApplication.id == application_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    else:
        application = await db.get(TechnicianApplication, application_id)
    if application is None:
        raise NotFound("Ficha não encontrada")
    return application


def _ensure_pending(application: TechnicianApplication) -> None:
    if application.status != ApplicationStatus.PENDING:
        raise WorkflowError("Esta ficha já foi analisada")


def purge_at(application: TechnicianApplication) -> datetime | None:
    """Reprovada: quando a rotina apaga a ficha (ONBOARDING_RETENTION_DAYS da última análise; a de
    antes sem análise, do envio ou da reabertura). As outras: None."""
    if application.status != ApplicationStatus.REJECTED:
        return None
    base = application.reviewed_at or application.reopened_at or application.created_at
    return base + timedelta(days=settings.ONBOARDING_RETENTION_DAYS) if base else None


@dataclass
class Approval:
    """O técnico criado na aprovação, a linha do histórico e a boas-vindas na fila."""

    user: User
    changes: list[dict[str, Any]]
    welcome: EmailOutbox | None
    welcome_status: EmailQueuedStatus


async def approve(
    db: AsyncSession, application: TechnicianApplication, data: ApplicationApprove, actor: User
) -> Approval:
    """Aprovação num passo (trave a ficha antes: get_application(lock=True)). Cria o técnico com
    tudo o que a ficha coletou: contato, a senha (sem ela, uma aleatória e a troca obrigatória: com
    o e-mail validado, a boas-vindas leva o link para criar a dele; sem a validação, a central
    manda a provisória), a foto, a cidade na grafia padrão, o endereço em partes (ficha_address),
    CPF, nascimento, RG, empresa, veículo, mini biografia, a validação do e-mail e o perfil técnico
    (disponibilidade, transporte e CNH, aptidões e áreas de atuação, pelos ids do catálogo;
    tech_profile.from_ficha, via "ficha"). Os arquivos da ficha passam a ser do técnico, sem copiar
    (technician_documents.attach_to_user). Ferramentas e certificações (texto livre) ficam só na
    ficha. O histórico do cadastro começa com "Aprovado na homologação (HOM-…)", com um item por
    arquivo (via ficha, ator = quem aprovou), e a boas-vindas vai para a fila (o commit, o
    `deliver_soon` e os avisos são da rota)."""
    _ensure_pending(application)
    if await db.scalar(select(User.id).where(func.lower(User.email) == application.email)):
        raise WorkflowError(USER_EMAIL_TAKEN)
    cpf = _ficha_cpf(application)
    if await cpf_in_use(db, cpf):
        raise _conflict(CPF_TAKEN)
    if data.team_id is not None and await db.get(Team, data.team_id) is None:
        raise WorkflowError("Grupo não encontrado")
    zip_digits = re.sub(r"\D", "", application.postal_code or "")
    company_document = _ficha_cnpj(application)
    street, number, complement = ficha_address(application)
    now = utcnow()
    user = User(
        id=uuid.uuid4(),
        name=application.full_name,
        email=application.email,
        phone=application.phone,
        phone_secondary=application.phone_secondary,
        # Ficha sem senha (antiga ou reprovada e reaberta): senha aleatória e troca obrigatória.
        password_hash=application.password_hash
        or await hash_password_async(secrets.token_urlsafe(24)),
        role=UserRole.TECHNICIAN,
        job_title=(data.job_title or "").strip() or "Técnico de campo",
        team_id=data.team_id,
        is_active=True,
        # Ele mesmo escolheu a senha na ficha: não precisa trocar no primeiro acesso.
        must_change_password=application.password_hash is None,
        avatar_key=application.photo_key,
        home_city=await cities.canonical_city(db, application.state, application.city),
        home_state=application.state,
        coverage_area=application.coverage_area,
        # Endereço em partes e CEP da ficha: a distância casa → loja usa mais que só a cidade.
        address_line=street,
        address_number=number,
        address_complement=complement,
        address_district=application.address_district,
        address_zip=f"{zip_digits[:5]}-{zip_digits[5:]}" if len(zip_digits) == 8 else None,
        cpf=cpf,
        birth_date=application.birth_date,
        rg_number=application.rg_number,
        rg_issuer=application.rg_issuer,
        rg_state=application.rg_state,
        bio=application.bio,
        company_document=company_document,
        company_name=application.company_name if company_document else None,
        company_trade_name=application.company_trade_name if company_document else None,
        vehicle_model=application.vehicle_model,
        vehicle_plate=application.vehicle_plate,
        email_verified_at=application.email_verified_at,
        operational_status=OperationalStatus.ACTIVE,
        **tech_profile.from_ficha(application),
    )
    db.add(user)
    note = (data.note or "").strip() or None
    application.status = ApplicationStatus.APPROVED
    application.user_id = user.id
    application.reviewed_by_id = actor.id
    application.reviewed_at = now
    application.review_note = note
    application.password_hash = None  # a senha passa a existir só no usuário
    _add_review(application, "approved", actor, note, now)
    await db.flush()
    documents = await technician_documents.attach_to_user(db, application, user)
    await _mark_used(db, user.service_areas, user.skills)
    changes = [
        {
            "field": "application",
            "from": None,
            "to": APPROVED_LINE.format(protocol=protocol(application)),
        },
        *documents,
    ]
    user_history.record(db, user, changes, via=VIA_FICHA, actor=actor)
    welcome, status = await mail.enqueue(
        db,
        template=EmailTemplate.WELCOME,
        to_email=user.email,
        user=user,
        context={"name": user.name, "email": user.email},
        created_by=actor,
    )
    return Approval(user=user, changes=changes, welcome=welcome, welcome_status=status)


async def reject(
    db: AsyncSession, application: TechnicianApplication, reason: str, actor: User
) -> None:
    """Reprova (trave a ficha antes): guarda o motivo, apaga a senha e anota a análise."""
    _ensure_pending(application)
    now = utcnow()
    note = reason.strip()
    application.status = ApplicationStatus.REJECTED
    application.reviewed_by_id = actor.id
    application.reviewed_at = now
    application.review_note = note
    application.password_hash = None
    _add_review(application, "rejected", actor, note, now)
    await db.flush()


async def reopen(
    db: AsyncSession, application: TechnicianApplication, reason: str, actor: User
) -> None:
    """Reabre a ficha reprovada (também a expirada) para uma nova análise (trave a ficha antes).
    409 quando não está reprovada, quando já há usuário com o e-mail ou com o CPF dela, ou outra
    ficha da mesma pessoa (e-mail ou CPF) em análise ou aprovada. Volta a pendente, sem a última
    análise (fica em `reviews`, com a reabertura e o motivo); a retenção passa a contar daqui."""
    if application.status != ApplicationStatus.REJECTED:
        raise _conflict(REOPEN_NOT_REJECTED)
    email = (application.email or "").strip().lower()
    if await db.scalar(select(User.id).where(func.lower(User.email) == email).limit(1)):
        raise _conflict(REOPEN_EMAIL_TAKEN)
    other = await db.scalar(
        select(TechnicianApplication.id)
        .where(
            TechnicianApplication.id != application.id,
            TechnicianApplication.status.in_(
                (ApplicationStatus.PENDING, ApplicationStatus.APPROVED)
            ),
            or_(
                func.lower(TechnicianApplication.email) == email,
                TechnicianApplication.document == application.document,
            ),
        )
        .limit(1)
    )
    if other is not None:
        raise _conflict(OTHER_APPLICATION)
    if await cpf_in_use(db, _ficha_cpf(application)):
        raise _conflict(CPF_TAKEN)
    now = utcnow()
    application.status = ApplicationStatus.PENDING
    application.reopened_at = now
    application.reopened_by_id = actor.id
    application.reviewed_by_id = None
    application.reviewed_at = None
    application.review_note = None
    _add_review(application, "reopened", actor, reason, now)
    await db.flush()


# ------------------------------------------------------------------- LGPD


async def _drop(db: AsyncSession, application: TechnicianApplication) -> list[str]:
    """Apaga a ficha com os documentos só dela (antes da ficha: a FK SET NULL os deixaria sem
    dono). Devolve as chaves a tirar do disco depois do commit (technician_documents.remove_files):
    os arquivos dos documentos e a foto, menos a que é de algum usuário (ex.: ficha aprovada)."""
    keys = list(await technician_documents.drop_for_application(db, application.id))
    photo = application.photo_key
    await db.delete(application)
    await db.flush()
    if photo and await db.scalar(select(User.id).where(User.avatar_key == photo)) is None:
        keys.append(photo)
    return keys


async def delete_application(db: AsyncSession, application: TechnicianApplication) -> list[str]:
    """Pedido do titular (LGPD, art. 18): apaga a ficha pendente ou reprovada, com a foto e os
    arquivos. Devolve as chaves a tirar do disco depois do commit
    (technician_documents.remove_files). A aprovada virou o cadastro do técnico e sai pela ficha
    dele, não por aqui."""
    if application.status == ApplicationStatus.APPROVED:
        raise WorkflowError("Ficha aprovada faz parte do cadastro do técnico e não é apagada aqui")
    return await _drop(db, application)


async def purge_expired(db: AsyncSession) -> int:
    """Rotina periódica: ficha pendente sem análise além do prazo (contado do envio ou da
    reabertura) vira reprovada ("Expirada sem análise", sem a senha, anotada em `reviews`);
    reprovada além do prazo (contado da última análise) é apagada com a foto, os arquivos, os
    links e os e-mails dela. Grava (os arquivos só saem do disco com a exclusão gravada) e devolve
    quantas mudaram.
    """
    cutoff = utcnow() - timedelta(days=settings.ONBOARDING_RETENTION_DAYS)
    since = func.coalesce(TechnicianApplication.reopened_at, TechnicianApplication.created_at)
    stale = list(
        await db.scalars(
            select(TechnicianApplication).where(
                TechnicianApplication.status == ApplicationStatus.PENDING,
                since < cutoff,
            )
        )
    )
    now = utcnow()
    for application in stale:
        application.status = ApplicationStatus.REJECTED
        application.reviewed_by_id = None
        application.reviewed_at = now
        application.review_note = EXPIRED_NOTE
        application.password_hash = None
        _add_review(application, "expired", None, EXPIRED_NOTE, now)
    old = list(
        await db.scalars(
            select(TechnicianApplication).where(
                TechnicianApplication.status == ApplicationStatus.REJECTED,
                or_(
                    TechnicianApplication.reviewed_at < cutoff,
                    TechnicianApplication.reviewed_at.is_(None) & (since < cutoff),
                ),
            )
        )
    )
    keys: list[str] = []
    for application in old:
        keys.extend(await _drop(db, application))
    await db.commit()
    technician_documents.remove_files(keys)
    return len(stale) + len(old)

"""Homologação de técnicos: convites, ficha pública e análise (aprovar/reprovar).

LGPD: a ficha reprovada (ou pendente sem análise) não fica guardada para sempre. Depois de
ONBOARDING_RETENTION_DAYS a rotina periódica apaga a ficha e a foto (`purge_expired`), e a gestão
apaga na hora quando o próprio técnico pede (`delete_application`).
"""

import hashlib
import re
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.config import settings
from app.core.enums import ApplicationStatus, UserRole
from app.core.security import hash_password_async
from app.db.base import utcnow
from app.models import OnboardingInvite, Team, TechnicianApplication, User
from app.schemas.onboarding import (
    PRIVACY_VERSION,
    ApplicationApprove,
    ApplicationIn,
    InviteCreate,
    InviteState,
)
from app.services import storage
from app.services.errors import NotFound, WorkflowError
from app.services.realtime import bus

MAX_PHOTO_BYTES = 2 * 1024 * 1024
LINK_KIND = "onboarding"
EXPIRED_NOTE = "Expirada sem análise"


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
    """CPF já numa ficha pendente ou aprovada (a mesma pessoa não se cadastra duas vezes)."""
    found = await db.scalar(
        select(TechnicianApplication.id).where(
            TechnicianApplication.document == document,
            TechnicianApplication.status.in_(
                (ApplicationStatus.PENDING, ApplicationStatus.APPROVED)
            ),
        )
    )
    return found is not None


async def submit(
    db: AsyncSession, invite: OnboardingInvite, data: ApplicationIn
) -> TechnicianApplication:
    if await email_taken(db, data.email):
        raise WorkflowError(
            "Já existe um cadastro com este e-mail. Se você já enviou a ficha, aguarde a análise."
        )
    if await document_taken(db, data.document):
        raise WorkflowError(
            "Já existe um cadastro com este CPF. Se você já enviou a ficha, aguarde a análise."
        )
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
        document=data.document,
        birth_date=data.birth_date,
        postal_code=(data.postal_code or "").strip() or None,
        address=(data.address or "").strip() or None,
        city=data.city,
        state=data.state,
        company_document=data.company_document,
        years_experience=data.years_experience,
        service_areas=data.service_areas,
        skills=[s.model_dump() for s in data.skills],
        certifications=(data.certifications or "").strip() or None,
        tools=(data.tools or "").strip() or None,
        has_vehicle=data.has_vehicle,
        vehicle_type=data.vehicle_type if data.has_vehicle else None,
        has_driver_license=data.has_driver_license,
        coverage_area=data.coverage_area,
        availability=data.availability,
        notes=(data.notes or "").strip() or None,
        photo_key=photo_key,
        password_hash=password_hash,
        privacy_consent_at=utcnow(),
        privacy_version=PRIVACY_VERSION,
    )
    db.add(application)
    invite.use_count += 1
    await db.flush()
    return application


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


async def get_application(db: AsyncSession, application_id: uuid.UUID) -> TechnicianApplication:
    application = await db.get(TechnicianApplication, application_id)
    if application is None:
        raise NotFound("Ficha não encontrada")
    return application


def _ensure_pending(application: TechnicianApplication) -> None:
    if application.status != ApplicationStatus.PENDING:
        raise WorkflowError("Esta ficha já foi analisada")


async def approve(
    db: AsyncSession, application: TechnicianApplication, data: ApplicationApprove, actor: User
) -> User:
    _ensure_pending(application)
    if await db.scalar(select(User.id).where(func.lower(User.email) == application.email)):
        raise WorkflowError("Já existe um usuário com este e-mail")
    if data.team_id is not None and await db.get(Team, data.team_id) is None:
        raise WorkflowError("Grupo não encontrado")
    zip_digits = re.sub(r"\D", "", application.postal_code or "")
    user = User(
        id=uuid.uuid4(),
        name=application.full_name,
        email=application.email,
        phone=application.phone,
        # Ficha sem senha (antiga): senha aleatória e troca obrigatória no primeiro acesso.
        password_hash=application.password_hash
        or await hash_password_async(secrets.token_urlsafe(24)),
        role=UserRole.TECHNICIAN,
        job_title=(data.job_title or "").strip() or "Técnico de campo",
        team_id=data.team_id,
        is_active=True,
        # Ele mesmo escolheu a senha na ficha: não precisa trocar no primeiro acesso.
        must_change_password=application.password_hash is None,
        avatar_key=application.photo_key,
        home_city=application.city,
        home_state=application.state,
        coverage_area=application.coverage_area,
        # Endereço e CEP da ficha: a distância casa → loja usa mais que só a cidade.
        address_line=application.address,
        address_zip=f"{zip_digits[:5]}-{zip_digits[5:]}" if len(zip_digits) == 8 else None,
    )
    db.add(user)
    application.status = ApplicationStatus.APPROVED
    application.user_id = user.id
    application.reviewed_by_id = actor.id
    application.reviewed_at = utcnow()
    application.review_note = (data.note or "").strip() or None
    application.password_hash = None  # a senha passa a existir só no usuário
    await db.flush()
    return user


async def reject(
    db: AsyncSession, application: TechnicianApplication, reason: str, actor: User
) -> None:
    _ensure_pending(application)
    application.status = ApplicationStatus.REJECTED
    application.reviewed_by_id = actor.id
    application.reviewed_at = utcnow()
    application.review_note = reason.strip()
    application.password_hash = None
    await db.flush()


# ------------------------------------------------------------------- LGPD


async def _drop(db: AsyncSession, application: TechnicianApplication) -> None:
    """Apaga a ficha e a foto (a foto fica se for a de algum usuário, ex.: ficha aprovada)."""
    key = application.photo_key
    await db.delete(application)
    await db.flush()
    if key and await db.scalar(select(User.id).where(User.avatar_key == key)) is None:
        storage.delete(key)


async def delete_application(db: AsyncSession, application: TechnicianApplication) -> None:
    """Pedido do titular (LGPD, art. 18): apaga a ficha pendente ou reprovada com a foto.
    A aprovada virou o cadastro do técnico e sai pela ficha dele, não por aqui."""
    if application.status == ApplicationStatus.APPROVED:
        raise WorkflowError("Ficha aprovada faz parte do cadastro do técnico e não é apagada aqui")
    await _drop(db, application)


async def purge_expired(db: AsyncSession) -> int:
    """Rotina periódica: ficha pendente sem análise além do prazo vira reprovada ("Expirada sem
    análise", sem a senha); reprovada além do prazo é apagada com a foto. Devolve quantas mudaram.
    """
    cutoff = utcnow() - timedelta(days=settings.ONBOARDING_RETENTION_DAYS)
    stale = list(
        await db.scalars(
            select(TechnicianApplication).where(
                TechnicianApplication.status == ApplicationStatus.PENDING,
                TechnicianApplication.created_at < cutoff,
            )
        )
    )
    now = utcnow()
    for application in stale:
        application.status = ApplicationStatus.REJECTED
        application.reviewed_at = now
        application.review_note = EXPIRED_NOTE
        application.password_hash = None
    old = list(
        await db.scalars(
            select(TechnicianApplication).where(
                TechnicianApplication.status == ApplicationStatus.REJECTED,
                or_(
                    TechnicianApplication.reviewed_at < cutoff,
                    TechnicianApplication.reviewed_at.is_(None)
                    & (TechnicianApplication.created_at < cutoff),
                ),
            )
        )
    )
    for application in old:
        await _drop(db, application)
    await db.flush()
    return len(stale) + len(old)

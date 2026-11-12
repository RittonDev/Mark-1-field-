"""Homologação de técnicos: convites, ficha pública e análise (aprovar/reprovar)."""

import base64
import binascii
import hashlib
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import ApplicationStatus, UserRole
from app.core.security import hash_password
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
# Assinaturas dos formatos aceitos: o tipo vem do conteúdo, não do que o navegador diz.
_IMAGE_MAGIC = {b"\xff\xd8\xff": "jpg", b"\x89PNG\r\n\x1a\n": "png"}


class InviteUnavailable(Exception):
    """Link inexistente, expirado, revogado ou já usado."""


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


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
    token = secrets.token_urlsafe(32)
    invite = OnboardingInvite(
        id=uuid.uuid4(),
        token_hash=hash_token(token),
        label=(data.label or "").strip() or None,
        max_uses=None if data.reusable else 1,
        use_count=0,
        expires_at=utcnow() + timedelta(days=data.days_valid),
        created_by_id=actor.id,
    )
    db.add(invite)
    await db.flush()
    await db.refresh(invite, ["created_by"])
    return invite, token


async def active_invite(db: AsyncSession, token: str) -> OnboardingInvite:
    invite = await db.scalar(
        select(OnboardingInvite).where(OnboardingInvite.token_hash == hash_token(token))
    )
    if invite is None or invite_state(invite) != "active":
        raise InviteUnavailable
    return invite


def _decode_photo(data_url: str) -> tuple[bytes, str]:
    header, _, payload = data_url.partition(",")
    if not header.startswith("data:image/") or ";base64" not in header:
        raise WorkflowError("Foto inválida: envie uma imagem JPG ou PNG")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise WorkflowError("Foto inválida") from exc
    if len(raw) > MAX_PHOTO_BYTES:
        raise WorkflowError("Foto maior que 2 MB")
    for magic, ext in _IMAGE_MAGIC.items():
        if raw.startswith(magic):
            return raw, ext
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return raw, "webp"
    raise WorkflowError("Foto inválida: envie uma imagem JPG, PNG ou WebP")


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


async def submit(
    db: AsyncSession, invite: OnboardingInvite, data: ApplicationIn
) -> TechnicianApplication:
    if await email_taken(db, data.email):
        raise WorkflowError(
            "Já existe um cadastro com este e-mail. Se você já enviou a ficha, aguarde a análise."
        )
    photo_key = None
    if data.photo:
        raw, ext = _decode_photo(data.photo)
        photo_key = await storage.save_bytes("onboarding", ext, raw)

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
        password_hash=hash_password(data.password),
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
    user = User(
        id=uuid.uuid4(),
        name=application.full_name,
        email=application.email,
        phone=application.phone,
        password_hash=application.password_hash or hash_password(secrets.token_urlsafe(24)),
        role=UserRole.TECHNICIAN,
        job_title=(data.job_title or "").strip() or "Técnico de campo",
        team_id=data.team_id,
        is_active=True,
        # Ele mesmo escolheu a senha na ficha: não precisa trocar no primeiro acesso.
        must_change_password=application.password_hash is None,
        avatar_key=application.photo_key,
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

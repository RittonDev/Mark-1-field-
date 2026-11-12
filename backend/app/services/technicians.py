"""Base técnica: analistas e gestores cuidam do acesso dos técnicos ao app.

Só mexe em usuários técnicos (quem cuida de analistas e gestores é o admin, em Usuários).
"""

import secrets
import uuid
from datetime import timedelta

from fastapi import UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.enums import ApplicationStatus, UserRole
from app.core.security import create_token, hash_password
from app.db.base import utcnow
from app.models import Team, TechnicianApplication, TechnicianShift, Ticket, User
from app.schemas.onboarding import SkillOut
from app.schemas.technician import (
    Credential,
    ImportResult,
    ImportRow,
    TechnicianCreate,
    TechnicianOut,
    TechnicianUpdate,
)
from app.services import storage
from app.services.errors import NotFound, WorkflowError
from app.services.spreadsheet import read_table
from app.services.workflow import OPEN_STATUSES

# Sem letras e números que se confundem (O/0, l/1/I) para ditar por telefone.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
MAX_PHOTO_BYTES = 2 * 1024 * 1024

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
    if not user.avatar_key:
        return None
    token = create_token(f"avatar:{user.id}", "download", timedelta(hours=12))
    return f"{settings.API_PREFIX}/users/{user.id}/avatar?token={token}"


async def get_technician(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None or user.role != UserRole.TECHNICIAN:
        raise NotFound("Técnico não encontrado")
    return user


async def _email_in_use(db: AsyncSession, email: str, exclude: uuid.UUID | None = None) -> bool:
    stmt = select(User.id).where(func.lower(User.email) == email.lower())
    if exclude is not None:
        stmt = stmt.where(User.id != exclude)
    return (await db.scalar(stmt)) is not None


async def _check_team(db: AsyncSession, team_id: uuid.UUID | None) -> None:
    if team_id is not None and await db.get(Team, team_id) is None:
        raise WorkflowError("Grupo não encontrado")


async def to_out(db: AsyncSession, users: list[User]) -> list[TechnicianOut]:
    ids = [u.id for u in users]
    if not ids:
        return []
    on_shift = set(
        await db.scalars(
            select(TechnicianShift.user_id).where(
                TechnicianShift.user_id.in_(ids), TechnicianShift.ended_at.is_(None)
            )
        )
    )
    open_counts = dict(
        (
            await db.execute(
                select(Ticket.assignee_id, func.count())
                .where(Ticket.assignee_id.in_(ids), Ticket.status.in_(OPEN_STATUSES))
                .group_by(Ticket.assignee_id)
            )
        ).all()
    )
    profiles = {
        a.user_id: a
        for a in await db.scalars(
            select(TechnicianApplication).where(
                TechnicianApplication.user_id.in_(ids),
                TechnicianApplication.status == ApplicationStatus.APPROVED,
            )
        )
    }
    out = []
    for u in users:
        profile = profiles.get(u.id)
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
                service_areas=profile.service_areas if profile else [],
                skills=[SkillOut(**s) for s in profile.skills] if profile else [],
                application_id=profile.id if profile else None,
            )
        )
    return out


async def list_technicians(
    db: AsyncSession, q: str | None, team_id: uuid.UUID | None, active: bool | None
) -> list[TechnicianOut]:
    stmt = select(User).where(User.role == UserRole.TECHNICIAN)
    if q:
        term = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(User.name.ilike(term), User.email.ilike(term), User.phone.ilike(term))
        )
    if team_id is not None:
        stmt = stmt.where(User.team_id == team_id)
    if active is not None:
        stmt = stmt.where(User.is_active.is_(active))
    users = list(await db.scalars(stmt.order_by(User.name).limit(1000)))
    return await to_out(db, users)


async def create(db: AsyncSession, data: TechnicianCreate) -> tuple[User, str]:
    if await _email_in_use(db, data.email):
        raise WorkflowError("E-mail já cadastrado")
    await _check_team(db, data.team_id)
    password = temporary_password()
    user = User(
        id=uuid.uuid4(),
        name=data.name.strip(),
        email=data.email,
        phone=(data.phone or "").strip() or None,
        password_hash=hash_password(password),
        role=UserRole.TECHNICIAN,
        job_title=(data.job_title or "").strip() or "Técnico de campo",
        team_id=data.team_id,
        home_city=(data.home_city or "").strip() or None,
        home_state=(data.home_state or "").strip().upper() or None,
        coverage_area=(data.coverage_area or "").strip() or None,
        is_active=True,
        must_change_password=True,
    )
    db.add(user)
    await db.flush()
    return user, password


async def update(db: AsyncSession, user: User, data: TechnicianUpdate) -> User:
    fields = data.model_dump(exclude_unset=True)
    if fields.get("email") and await _email_in_use(db, fields["email"], exclude=user.id):
        raise WorkflowError("E-mail já cadastrado")
    if "team_id" in fields:
        await _check_team(db, fields["team_id"])
    for key, value in fields.items():
        if key == "home_state" and isinstance(value, str):
            value = value.strip().upper()
        if key in (
            "name",
            "phone",
            "job_title",
            "home_city",
            "home_state",
            "coverage_area",
        ) and isinstance(value, str):
            value = value.strip() or None
        if key == "name" and not value:
            continue
        if key == "email" and not value:
            continue
        setattr(user, key, value)
    if fields.get("is_active") is False:
        user.sessions_revoked_at = utcnow()  # desativado: sai do app na hora
    await db.flush()
    return user


async def reset_password(db: AsyncSession, user: User) -> str:
    """Senha provisória nova; o técnico troca no próximo acesso e as sessões abertas caem."""
    password = temporary_password()
    user.password_hash = hash_password(password)
    user.must_change_password = True
    user.sessions_revoked_at = utcnow()
    await db.flush()
    return password


async def set_photo(db: AsyncSession, user: User, upload: UploadFile) -> User:
    raw = await upload.read(MAX_PHOTO_BYTES + 1)
    if len(raw) > MAX_PHOTO_BYTES:
        raise WorkflowError("Foto maior que 2 MB")
    ext = storage.image_extension(raw)
    if ext is None:
        raise WorkflowError("Envie uma imagem JPG, PNG ou WebP")
    user.avatar_key = await storage.save_bytes("avatars", ext, raw)
    await db.flush()
    return user


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
    result = ImportResult(dry_run=dry_run, rows=[], created=0, updated=0, errors=0)
    for index, row in enumerate(rows, start=2):  # linha 1 = cabeçalho
        name = " ".join(row.get("name", "").split())
        email = row.get("email", "").strip().lower()
        phone = row.get("phone", "").strip() or None
        team_name = row.get("team", "").strip() or None
        job_title = row.get("job_title", "").strip() or None
        home_city = row.get("home_city", "").strip() or None
        home_state = row.get("home_state", "").strip().upper()[:2] or None
        coverage_area = row.get("coverage_area", "").strip() or None
        errors = []
        if len(name) < 3:
            errors.append("Nome obrigatório")
        if "@" not in email or "." not in email.split("@")[-1]:
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
            # bcrypt é lento de propósito: fora do event loop para não travar a API.
            password_hash = await run_in_threadpool(hash_password, password)
            db.add(
                User(
                    id=uuid.uuid4(),
                    name=name,
                    email=email,
                    phone=phone,
                    password_hash=password_hash,
                    role=UserRole.TECHNICIAN,
                    job_title=job_title or "Técnico de campo",
                    team_id=team.id if team else None,
                    home_city=home_city,
                    home_state=home_state,
                    coverage_area=coverage_area,
                    is_active=True,
                    must_change_password=True,
                )
            )
            result.credentials.append(
                Credential(name=name, email=email, temporary_password=password)
            )
    if not dry_run:
        await db.flush()
    return result

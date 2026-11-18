"""Perfis de acesso: o acesso efetivo de cada request, os perfis e o acesso de cada usuário.

O cálculo é puro (core/permissions.py). Aqui ficam as consultas: o perfil padrão do papel, os
perfis padrão que faltarem, o acesso pendurado no usuário do request (`attach`), a validação do que
a tela envia, o teto do supervisor e o aviso de tempo real `access.changed` (a web relê o /auth/me e
o socket reconecta com o acesso novo).
"""

import logging
import uuid
from types import SimpleNamespace
from typing import Any

from sqlalchemy import func, select
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.enums import UserRole
from app.core.permissions import ITEM_BY_KEY, PROFILE_ROLES, RANK, Access
from app.db.base import utcnow
from app.models.access import AccessProfile
from app.models.user import User
from app.services.errors import AccessDenied, WorkflowError

log = logging.getLogger(__name__)

# Os dois perfis padrão (iguais aos da migração a6d3f9b2c8e4).
SYSTEM_PROFILES: tuple[tuple[str, str, str], ...] = (
    (UserRole.SUPERVISOR.value, "Supervisor", "Padrão dos supervisores"),
    (UserRole.ANALYST.value, "Analista", "Padrão dos analistas"),
)
NO_PROFILE_ROLE = "Este papel não usa perfil de acesso"
PROFILE_NOT_FOUND = "Perfil de acesso não encontrado"
ACCESS_CAP = "Você não pode dar mais acesso do que tem."


def _role_key(role: UserRole | str) -> str:
    return role.value if isinstance(role, UserRole) else str(role)


async def system_profile(db: AsyncSession, role: UserRole | str) -> AccessProfile | None:
    return await db.scalar(select(AccessProfile).where(AccessProfile.system_key == _role_key(role)))


async def ensure_system_profiles(db: AsyncSession) -> None:
    """Cria os perfis padrão que faltarem (banco dos testes, seed). Concorrente sem erro: o
    nome e a chave são únicos e o INSERT ignora o que já existe."""
    existing = set(
        await db.scalars(
            select(AccessProfile.system_key).where(AccessProfile.system_key.is_not(None))
        )
    )
    now = utcnow()
    for key, name, description in SYSTEM_PROFILES:
        if key in existing:
            continue
        await db.execute(
            pg_insert(AccessProfile)
            .values(
                id=uuid.uuid4(),
                name=name,
                description=description,
                system_key=key,
                items={},
                queue_scope="all",
                queue_unowned=True,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_nothing()
        )


async def _profile_of(db: AsyncSession, user: User) -> AccessProfile | None:
    """O perfil do usuário: já vem com ele (selectin); num objeto criado nesta sessão, carrega."""
    if "access_profile" not in sa_inspect(user).unloaded:
        return user.access_profile
    return await db.run_sync(lambda _: user.access_profile)


async def effective(db: AsyncSession, user: User) -> Access:
    """Acesso efetivo da pessoa como está no banco (sem guardar no objeto)."""
    if user.role not in PROFILE_ROLES:
        return permissions.resolve(user, None)
    profile = await _profile_of(db, user)
    if profile is None:
        # Supervisor ou analista sem perfil (criado fora da tela): o padrão do papel.
        profile = await system_profile(db, user.role)
    return permissions.resolve(user, profile)


async def attach(db: AsyncSession, user: User) -> Access:
    """Calcula o acesso efetivo e o guarda no usuário (`permissions.of` lê dele, sem I/O)."""
    acc = await effective(db, user)
    user._access = acc  # type: ignore[attr-defined]
    return acc


# ------------------------------------------------------------------ validação do que vem da tela


def _levels_text(levels: tuple[str, ...]) -> str:
    names = [permissions.LEVEL_LABELS[lv] for lv in levels]
    return ", ".join(names[:-1]) + f" ou {names[-1]}" if len(names) > 1 else names[0]


def check_items(items: dict[str, Any] | None, *, allow_null: bool = False) -> dict[str, Any]:
    """Chaves do catálogo e níveis que a tela aceita (422 com o motivo)."""
    out: dict[str, Any] = {}
    for key, value in (items or {}).items():
        spec = ITEM_BY_KEY.get(key)
        if spec is None:
            raise WorkflowError(f"Tela desconhecida: {key}")
        if value is None and allow_null:
            out[key] = None
            continue
        if value not in spec.levels:
            raise WorkflowError(f"{spec.label} só tem {_levels_text(spec.levels)}")
        out[key] = value
    return out


def check_queue(scope: str | None, unowned: bool | None) -> None:
    if scope is not None and scope not in permissions.QUEUE_SCOPES:
        raise WorkflowError("Visibilidade de filas inválida")
    if unowned is not None and not isinstance(unowned, bool):
        raise WorkflowError("Visibilidade de filas inválida")


# ----------------------------------------------------------------------------------- perfis


def effective_items(profile: AccessProfile) -> dict[str, str]:
    return dict(permissions.profile_items(profile))


async def users_count(db: AsyncSession, profile_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Quantas pessoas usam cada perfil (ativas e inativas)."""
    if not profile_ids:
        return {}
    rows = await db.execute(
        select(User.access_profile_id, func.count())
        .where(User.access_profile_id.in_(profile_ids))
        .group_by(User.access_profile_id)
    )
    return {pid: int(n) for pid, n in rows.all()}


def profile_out(profile: AccessProfile, count: int) -> dict[str, Any]:
    scope, _ = permissions.profile_queue(profile)
    return {
        "id": profile.id,
        "name": profile.name,
        "description": profile.description,
        "system_key": profile.system_key,
        "items": dict(profile.items or {}),
        "effective_items": effective_items(profile),
        "queue_scope": scope,
        # O valor gravado (com "todas as filas" a sem analista já entra de qualquer jeito).
        "queue_unowned": bool(profile.queue_unowned),
        "users_count": count,
        "updated_at": profile.updated_at,
    }


def _profile_order(profile: AccessProfile) -> tuple[int, str]:
    rank = {UserRole.SUPERVISOR.value: 0, UserRole.ANALYST.value: 1}
    return (rank.get(profile.system_key or "", 2), profile.name.lower())


async def list_profiles(db: AsyncSession) -> list[dict[str, Any]]:
    """Supervisor, Analista e depois os criados na tela, por nome."""
    profiles = sorted(await db.scalars(select(AccessProfile)), key=_profile_order)
    counts = await users_count(db, [p.id for p in profiles])
    return [profile_out(p, counts.get(p.id, 0)) for p in profiles]


async def profile_users(db: AsyncSession, profile: AccessProfile) -> list[uuid.UUID]:
    """Quem é afetado por uma mudança no perfil: quem o usa e, num perfil padrão, também o
    supervisor/analista do mesmo papel sem perfil (cai no padrão do papel)."""
    stmt = select(User.id).where(User.access_profile_id == profile.id)
    ids = list(await db.scalars(stmt))
    if profile.system_key:
        ids += list(
            await db.scalars(
                select(User.id).where(
                    User.access_profile_id.is_(None), User.role == profile.system_key
                )
            )
        )
    return ids


# ------------------------------------------------------------------------ acesso do usuário


def clean_overrides(
    profile: AccessProfile | None, role: UserRole | str, overrides: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Tira os ajustes iguais ao perfil (não acumula ajuste inútil). None quando não sobra nada."""
    if not overrides:
        return None
    base_items = permissions.profile_items(profile, role)
    base_scope, base_unowned = permissions.profile_queue(profile)
    items = {
        key: permissions.clamp(key, value)
        for key, value in (overrides.get("items") or {}).items()
        if key in ITEM_BY_KEY and value in RANK
    }
    items = {key: value for key, value in items.items() if value != base_items[key]}
    scope = overrides.get("queue_scope")
    scope = scope if scope in permissions.QUEUE_SCOPES else None
    unowned = overrides.get("queue_unowned")
    unowned = unowned if isinstance(unowned, bool) else None
    final_scope = scope or base_scope
    if scope == base_scope:
        scope = None
    if final_scope == "all":
        # "Todas as filas" já inclui a "Sem analista".
        unowned = None
    elif scope is None and unowned == base_unowned:
        unowned = None
    out: dict[str, Any] = {}
    if items:
        out["items"] = items
    if scope is not None:
        out["queue_scope"] = scope
    if unowned is not None:
        out["queue_unowned"] = unowned
    return out or None


def preview(role: UserRole | str, profile: AccessProfile | None, overrides: Any) -> Access:
    """Acesso que a pessoa teria com este perfil e estes ajustes (sem gravar nada)."""
    return permissions.resolve(SimpleNamespace(role=role, access_overrides=overrides), profile)


def check_cap(actor: User, before: Access, after: Access) -> None:
    """O supervisor não dá mais acesso do que tem: nenhuma tela acima do nível dele (a não ser
    que a pessoa já tivesse esse nível) e, se ele só vê a própria fila, nada de "todas as filas"
    nem de "sem analista" que ele não vê. O administrador não tem teto."""
    if actor.role == UserRole.ADMIN:
        return
    mine = permissions.of(actor)
    for key in permissions.ITEM_KEYS:
        new = RANK[after.level(key)]
        if new > max(RANK[mine.level(key)], RANK[before.level(key)]):
            raise AccessDenied(ACCESS_CAP, code="ACCESS_CAP")
    if not mine.all_queues:
        if after.all_queues and not before.all_queues:
            raise AccessDenied(ACCESS_CAP, code="ACCESS_CAP")
        if (
            after.queue_unowned
            and not mine.queue_unowned
            and not (before.queue_unowned or before.all_queues)
        ):
            raise AccessDenied(ACCESS_CAP, code="ACCESS_CAP")


async def resolve_profile(
    db: AsyncSession, role: UserRole | str, profile_id: uuid.UUID | None
) -> AccessProfile | None:
    """O perfil escolhido ou, sem escolha, o padrão do papel."""
    if profile_id is None:
        profile = await system_profile(db, role)
        if profile is None:
            await ensure_system_profiles(db)
            profile = await system_profile(db, role)
        return profile
    profile = await db.get(AccessProfile, profile_id)
    if profile is None:
        raise WorkflowError(PROFILE_NOT_FOUND)
    return profile


async def apply_user_access(
    db: AsyncSession,
    actor: User,
    target: User,
    data: Any,
    *,
    role: UserRole,
    before: Access,
) -> Access:
    """Grava o perfil e os ajustes da pessoa (o _can_manage já foi conferido na rota).

    `data` é o UserAccessIn ({profile_id, overrides}); `role`, o papel final (pode mudar no
    mesmo PATCH); `before`, o acesso de antes da mudança (NO_ACCESS para quem não tinha). Devolve
    o acesso novo."""
    if role not in PROFILE_ROLES:
        raise WorkflowError(NO_PROFILE_ROLE)
    overrides_in = getattr(data, "overrides", None)
    raw = overrides_in.model_dump() if hasattr(overrides_in, "model_dump") else overrides_in
    raw = raw or {}
    check_items(raw.get("items"), allow_null=True)
    check_queue(raw.get("queue_scope"), raw.get("queue_unowned"))
    profile = await resolve_profile(db, role, getattr(data, "profile_id", None))
    cleaned = clean_overrides(profile, role, raw)
    after = preview(role, profile, cleaned)
    check_cap(actor, before, after)
    target.access_profile_id = profile.id if profile is not None else None
    target.access_overrides = cleaned
    if after.fingerprint != before.fingerprint or after.profile_id != before.profile_id:
        log.info(
            "Acesso: %s alterou %s (perfil %s, ajustes %s, fila %s)",
            actor.id,
            target.id,
            profile.name if profile is not None else "-",
            ", ".join(sorted((cleaned or {}).get("items", {}))) or "-",
            after.queue_scope + ("+sem analista" if after.queue_unowned else ""),
        )
    return after


async def follow_role(
    db: AsyncSession,
    actor: User,
    target: User,
    *,
    old_role: UserRole,
    new_role: UserRole,
    before: Access,
) -> Access:
    """Troca de papel sem `access` no corpo: quem estava no padrão do papel antigo (ou sem
    perfil) passa ao padrão do novo; papel fora da matriz fica sem perfil e sem ajustes."""
    if new_role not in PROFILE_ROLES:
        target.access_profile_id = None
        target.access_overrides = None
        return permissions.resolve(SimpleNamespace(role=new_role), None)
    current = target.access_profile_id
    old_default = await system_profile(db, old_role) if old_role in PROFILE_ROLES else None
    if current is None or (old_default is not None and current == old_default.id):
        profile = await resolve_profile(db, new_role, None)
        target.access_profile_id = profile.id if profile is not None else None
    else:
        profile = await db.get(AccessProfile, current)
    after = preview(new_role, profile, target.access_overrides)
    check_cap(actor, before, after)
    return after


async def publish_changed(user_ids: list[uuid.UUID]) -> None:
    """Depois do commit: avisa as pessoas (a web relê o /auth/me e o socket reconecta)."""
    from app.services.realtime import bus

    ids = sorted({str(i) for i in user_ids})
    if not ids:
        return
    try:
        await bus.publish({"type": "access.changed", "audience": {"user_ids": ids}})
    except Exception:
        log.exception("Falha ao avisar a mudança de acesso")

"""Perfis de acesso: catálogo das telas, perfis (matriz Tela x Nível e filas) e quem usa cada um.

Só o administrador cria, altera e exclui perfis. Quem tem Usuários em Visualizar vê a lista; o
catálogo é aberto a toda a gestão (a tela da OS e o menu usam os rótulos).
"""

import logging
import uuid

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select

from app.api.deps import DB, AdminUser, TicketManagerUser, access_user
from app.core import permissions
from app.models.access import AccessProfile
from app.models.user import User
from app.schemas.access import (
    AccessCatalogOut,
    AccessProfileCreate,
    AccessProfileOut,
    AccessProfileUpdate,
)
from app.services import access as svc

log = logging.getLogger(__name__)

router = APIRouter(prefix="/access", tags=["access"])

UsersView = access_user("setup.users")

SYSTEM_NAME = "O nome dos perfis padrão não muda"
SYSTEM_DELETE = "Perfis padrão não são excluídos."
RESET_ONLY_SYSTEM = "Só os perfis padrão voltam ao padrão. Ajuste as telas deste perfil na matriz."


async def _get(db: DB, profile_id: uuid.UUID) -> AccessProfile:
    profile = await db.get(AccessProfile, profile_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, svc.PROFILE_NOT_FOUND)
    return profile


async def _out(db: DB, profile: AccessProfile) -> dict:
    counts = await svc.users_count(db, [profile.id])
    return svc.profile_out(profile, counts.get(profile.id, 0))


async def _commit_and_notify(db: DB, profile: AccessProfile) -> None:
    """Grava e avisa quem usa o perfil (a web relê o acesso, o socket reconecta)."""
    affected = await svc.profile_users(db, profile)
    await db.commit()
    await db.refresh(profile)
    await svc.publish_changed(affected)


@router.get("/catalog", response_model=AccessCatalogOut)
async def access_catalog(_: TicketManagerUser) -> dict:
    return permissions.catalog()


@router.get("/profiles", response_model=list[AccessProfileOut])
async def list_profiles(db: DB, _: UsersView) -> list[dict]:
    await svc.ensure_system_profiles(db)
    await db.commit()
    return await svc.list_profiles(db)


@router.post("/profiles", response_model=AccessProfileOut, status_code=status.HTTP_201_CREATED)
async def create_profile(body: AccessProfileCreate, db: DB, actor: AdminUser) -> dict:
    """Perfil novo: começa igual a outro perfil (sem escolha, igual ao Analista) com as telas
    enviadas por cima. Grava o dicionário completo: mudar o padrão do código depois não muda o
    que este perfil libera."""
    svc.check_items(body.items)
    if body.copy_from_id is not None:
        source = await _get(db, body.copy_from_id)
    else:
        await svc.ensure_system_profiles(db)
        source = await svc.system_profile(db, "analyst")
    items = permissions.profile_items(source, "analyst")
    items.update(body.items or {})
    scope, unowned = permissions.profile_queue(source)
    if body.queue_scope is not None:
        scope = body.queue_scope
    if body.queue_unowned is not None:
        unowned = body.queue_unowned
    name = " ".join(body.name.split())
    if await db.scalar(
        select(AccessProfile.id).where(func.lower(AccessProfile.name) == name.lower())
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "Já existe um perfil com este nome")
    profile = AccessProfile(
        name=name,
        description=(body.description or "").strip() or None,
        system_key=None,
        items=items,
        queue_scope=scope,
        queue_unowned=True if scope == "all" else bool(unowned),
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    log.info("Acesso: %s criou o perfil %s", actor.id, profile.id)
    return svc.profile_out(profile, 0)


@router.patch("/profiles/{profile_id}", response_model=AccessProfileOut)
async def update_profile(
    profile_id: uuid.UUID, body: AccessProfileUpdate, db: DB, actor: AdminUser
) -> dict:
    profile = await _get(db, profile_id)
    fields = body.model_dump(exclude_unset=True)
    if fields.get("name") is not None:
        name = " ".join(fields["name"].split())
        if name != profile.name:
            if profile.system_key:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, SYSTEM_NAME)
            taken = await db.scalar(
                select(AccessProfile.id).where(
                    func.lower(AccessProfile.name) == name.lower(), AccessProfile.id != profile.id
                )
            )
            if taken:
                raise HTTPException(status.HTTP_409_CONFLICT, "Já existe um perfil com este nome")
            profile.name = name
    if "description" in fields:
        profile.description = (fields["description"] or "").strip() or None
    if fields.get("items") is not None:
        changes = svc.check_items(fields["items"], allow_null=True)
        items = dict(profile.items or {})
        for key, value in changes.items():
            if value is None:
                items.pop(key, None)  # volta ao padrão
            else:
                items[key] = value
        profile.items = items
    if fields.get("queue_scope") is not None:
        profile.queue_scope = fields["queue_scope"]
    if fields.get("queue_unowned") is not None:
        profile.queue_unowned = fields["queue_unowned"]
    await _commit_and_notify(db, profile)
    log.info("Acesso: %s alterou o perfil %s", actor.id, profile.id)
    return await _out(db, profile)


@router.post("/profiles/{profile_id}/reset", response_model=AccessProfileOut)
async def reset_profile(profile_id: uuid.UUID, db: DB, actor: AdminUser) -> dict:
    """Perfil padrão de volta ao acesso de antes dos perfis: telas no padrão e todas as filas."""
    profile = await _get(db, profile_id)
    if not profile.system_key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, RESET_ONLY_SYSTEM)
    profile.items = {}
    profile.queue_scope = "all"
    profile.queue_unowned = True
    await _commit_and_notify(db, profile)
    log.info("Acesso: %s restaurou o perfil %s", actor.id, profile.id)
    return await _out(db, profile)


@router.delete("/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_profile(profile_id: uuid.UUID, db: DB, actor: AdminUser) -> Response:
    profile = await _get(db, profile_id)
    if profile.system_key:
        raise HTTPException(status.HTTP_409_CONFLICT, SYSTEM_DELETE)
    in_use = await db.scalar(
        select(func.count()).select_from(User).where(User.access_profile_id == profile.id)
    )
    if in_use:
        people = "1 usuário" if in_use == 1 else f"{in_use} usuários"
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Perfil em uso por {people}. Troque o perfil deles antes."
        )
    await db.delete(profile)
    await db.commit()
    log.info("Acesso: %s excluiu o perfil %s", actor.id, profile_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

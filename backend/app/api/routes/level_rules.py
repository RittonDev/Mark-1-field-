"""Configurações › Elo: as regras do elo por pontos (services/level_rules.py).

Lê quem tem Configurações (padrão: administrador e supervisor; o analista só com o perfil); grava e
aprova o administrador ou o supervisor com Configurações em Editar. Técnico e cliente: 403 (nunca
recebem pontos). Nesta etapa o livro de pontos não tem rota: o elo de 12 meses continua valendo.
"""

from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DB, MANAGER_ROLES, access_user
from app.core import permissions
from app.models import LevelRuleChange, User
from app.schemas.level_rules import (
    LevelRuleChangeOut,
    LevelRulesApprove,
    LevelRulesIn,
    LevelRulesOut,
)
from app.services import access
from app.services import level_rules as svc

router = APIRouter(tags=["settings"])

SettingsView = access_user("setup.settings")
SettingsManager = access_user("setup.settings", level="edit", roles=MANAGER_ROLES)


def _can_edit(user: User) -> bool:
    return user.role in MANAGER_ROLES and permissions.of(user).can("setup.settings", "edit")


@router.get("/level-rules", response_model=LevelRulesOut)
async def get_level_rules(db: DB, user: SettingsView) -> LevelRulesOut:
    """As 13 regras com o valor, o estado (falta definir, a validar, aprovado), quem alterou e quem
    aprovou, o que falta para ativar e quem confirma. Sem gravação, as sugestões do QA e os
    padrões (versão 1). Cria os perfis padrão que faltarem (quem confirma sai deles)."""
    await access.ensure_system_profiles(db)
    out = await svc.read(db, can_edit=_can_edit(user))
    await db.commit()
    return out


@router.put("/level-rules", response_model=LevelRulesOut)
async def put_level_rules(body: LevelRulesIn, db: DB, user: SettingsManager) -> LevelRulesOut:
    """Grava os 12 valores com a versão lida: 409 LEVEL_RULES_CHANGED (outra versão) e 422
    LEVEL_RULE_INVALID ("{rótulo}: {problema}"). O que mudou fica "a validar"."""
    out = await svc.save(db, body, user)
    await db.commit()
    return out


@router.post("/level-rules/approve", response_model=LevelRulesOut)
async def approve_level_rules(
    body: LevelRulesApprove, db: DB, user: SettingsManager
) -> LevelRulesOut:
    """Aprova as regras a validar, com quem e quando: 422 LEVEL_RULE_EMPTY "Falta definir:
    {rótulo}" e 409 LEVEL_RULES_CHANGED; a já aprovada fica como está."""
    out = await svc.approve(db, body, user)
    await db.commit()
    return out


@router.get("/level-rules/history", response_model=list[LevelRuleChangeOut])
async def level_rules_history(
    db: DB,
    _: SettingsView,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before: str | None = None,
) -> list[LevelRuleChange]:
    """O histórico das regras, do mais novo para o mais antigo. Páginas: `before` =
    "{created_at}|{id}" da última linha recebida; estragado, 422 "Página do histórico inválida.
    Recarregue a tela"."""
    return await svc.history(db, limit=limit, before=before)

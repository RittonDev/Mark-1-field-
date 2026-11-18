"""Perfis de acesso por tela e visibilidade das filas (core/permissions.py)."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.core.permissions import Level, QueueScope
from app.schemas.common import Ref


class AccessItemOut(BaseModel):
    key: str
    label: str
    href: str
    # Níveis que a tela aceita: ["none", "view", "edit"] ou, nas só de leitura, ["none", "view"].
    levels: list[Level]
    hint: str | None = None


class AccessModuleOut(BaseModel):
    key: str
    label: str
    items: list[AccessItemOut]


class AccessCatalogOut(BaseModel):
    modules: list[AccessModuleOut]
    # Nível de cada tela nos perfis padrão (o acesso de antes dos perfis).
    defaults: dict[str, dict[str, Level]]


class AccessProfileOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    # "supervisor" | "analyst" nos perfis padrão; null nos criados na tela.
    system_key: str | None
    # Só os níveis gravados (o resto segue o padrão); effective_items traz todas as telas.
    items: dict[str, Level]
    effective_items: dict[str, Level]
    queue_scope: QueueScope
    queue_unowned: bool
    # Pessoas no perfil, ativas e inativas.
    users_count: int
    updated_at: datetime


class AccessProfileCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    # Começa igual a este perfil (sem ele, igual ao "Analista").
    copy_from_id: uuid.UUID | None = None
    items: dict[str, Level] | None = None
    queue_scope: QueueScope | None = None
    queue_unowned: bool | None = None


class AccessProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    # Parcial: só as telas enviadas mudam; null tira a chave (a tela volta ao padrão).
    items: dict[str, Level | None] | None = None
    queue_scope: QueueScope | None = None
    queue_unowned: bool | None = None


class AccessOverrides(BaseModel):
    """Ajustes da pessoa por cima do perfil (null = igual ao perfil)."""

    items: dict[str, Level | None] | None = None
    queue_scope: QueueScope | None = None
    queue_unowned: bool | None = None


class UserAccessIn(BaseModel):
    # null = perfil padrão do papel.
    profile_id: uuid.UUID | None = None
    overrides: AccessOverrides | None = None


class EffectiveQueuesOut(BaseModel):
    scope: QueueScope
    # Vê também as OS sem analista (sempre true com "all").
    unowned: bool


class EffectiveAccessOut(BaseModel):
    """O acesso que vale para a pessoa: perfil + ajustes (administrador: tudo, full=true)."""

    full: bool
    profile: Ref | None
    # Tem ajuste próprio que muda o resultado do perfil.
    customized: bool
    # Todas as telas do catálogo, com o nível de cada uma.
    items: dict[str, Level]
    queues: EffectiveQueuesOut

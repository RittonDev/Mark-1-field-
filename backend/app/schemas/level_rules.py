"""Configurações › Elo: as 13 regras do elo por pontos (services/level_rules.py).

O PUT manda os 12 valores com a versão lida (`LevelRulesIn`); null = falta definir. Os números são
inteiros estritos (10.0, "10" e true não passam) e as faixas guardam só o início de cada categoria:
na contagem o Bronze começa em 0, o fim de cada uma é o início da próxima menos 1 e o Diamante não
tem fim. Faixa, mínimo e obrigatório vazio saem do serviço (422 LEVEL_RULE_INVALID, com o rótulo
da regra). `confirmers` não entra: sai dos perfis de acesso.

Só a central lê (Configurações): técnico e cliente nunca recebem pontos.
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from app.schemas.common import ORMModel, Ref

LevelRuleKey = Literal[
    "count_bands",
    "points_bands",
    "opening_bonus",
    "completion_gain",
    "on_time_gain",
    "late",
    "abandonment_loss",
    "rework_loss",
    "min_balance",
    "arrival_tolerance",
    "arrival_time",
    "confirmers",
    "app_reasons",
]
LevelRuleState = Literal["pending", "to_validate", "approved"]
LevelRuleOrigin = Literal["qa", "default", "central"]
LevelLateMode = Literal["deduct", "no_gain"]
LevelMinBalance = Literal["negative", "zero"]
LevelArrivalTime = Literal["server", "device"]
LevelRuleAction = Literal["seed", "save", "approve"]

# O nome de cada regra, na ordem da tela (= LEVEL_RULE_LABEL e LEVEL_RULE_ORDER em
# lib/constants.ts; a sonda frontend/tests/level-rules.test.mjs lê este bloco).
RULE_LABELS: dict[str, str] = {
    "count_bands": "Abertura por atendimentos",
    "points_bands": "Faixas de pontos",
    "opening_bonus": "Bônus de abertura",
    "completion_gain": "Atendimento concluído",
    "on_time_gain": "Chegada dentro do SLA",
    "late": "Chegada fora do SLA",
    "abandonment_loss": "Abandono confirmado",
    "rework_loss": "Retorno com falha confirmada",
    "min_balance": "Saldo mínimo",
    "arrival_tolerance": "Tolerância do SLA de chegada",
    "arrival_time": "Hora da chegada",
    "confirmers": "Quem confirma abandono e retorno",
    "app_reasons": "Motivos no app",
}
RULE_KEYS: tuple[str, ...] = tuple(RULE_LABELS)


# ------------------------------------------------------------------ entrada (PUT e aprovar)


class LevelCountBandsIn(BaseModel):
    """Início da Prata, do Ouro e do Diamante pela quantidade de atendimentos (Bronze em 0)."""

    silver: StrictInt | None
    gold: StrictInt | None
    diamond: StrictInt | None


class LevelPointsBandsIn(BaseModel):
    """Início de cada categoria pelo saldo (abaixo da Prata é Bronze, mesmo negativo)."""

    bronze: StrictInt | None
    silver: StrictInt | None
    gold: StrictInt | None
    diamond: StrictInt | None


class LevelLateRuleIn(BaseModel):
    """Chegada fora do SLA: desconta `points` ou só deixa de ganhar (`no_gain` grava null)."""

    mode: LevelLateMode | None
    points: StrictInt | None = None


class LevelRulesIn(BaseModel):
    """PUT /level-rules: os 12 valores (todos, mesmo os que não mudaram) e a versão lida."""

    version: StrictInt = Field(ge=1)
    count_bands: LevelCountBandsIn
    points_bands: LevelPointsBandsIn
    opening_bonus: StrictInt | None
    completion_gain: StrictInt | None
    on_time_gain: StrictInt | None
    late: LevelLateRuleIn | None
    abandonment_loss: StrictInt | None
    rework_loss: StrictInt | None
    min_balance: LevelMinBalance | None
    arrival_tolerance: StrictInt | None
    arrival_time: LevelArrivalTime | None
    app_reasons: StrictBool


class LevelRulesApprove(BaseModel):
    """POST /level-rules/approve: as regras a aprovar (1 a 13) e a versão lida."""

    version: StrictInt = Field(ge=1)
    keys: list[LevelRuleKey] = Field(min_length=1, max_length=len(RULE_KEYS))


# ------------------------------------------------------------------ saída


class LevelCountBands(BaseModel):
    silver: int
    gold: int
    diamond: int


class LevelPointsBands(BaseModel):
    bronze: int
    silver: int
    gold: int
    diamond: int


class LevelLateRule(BaseModel):
    mode: LevelLateMode
    points: int | None


class LevelRuleValues(BaseModel):
    """Os valores gravados (null = falta definir)."""

    count_bands: LevelCountBands
    points_bands: LevelPointsBands
    opening_bonus: int
    completion_gain: int | None
    on_time_gain: int | None
    late: LevelLateRule | None
    abandonment_loss: int
    rework_loss: int
    min_balance: LevelMinBalance | None
    arrival_tolerance: int | None
    arrival_time: LevelArrivalTime | None
    app_reasons: bool


class LevelRuleStamp(BaseModel):
    at: datetime
    by: Ref | None


class LevelRuleApproval(LevelRuleStamp):
    """A última aprovação, com o texto aprovado."""

    text: str


class LevelRuleStatus(BaseModel):
    """O estado de uma regra. `origin` null em quem confirma (vem dos perfis de acesso); `text`
    null = falta definir; `changed` = a última alteração pela central; `approved` = a última
    aprovação (em "to_validate", o valor mudou depois dela)."""

    state: LevelRuleState
    origin: LevelRuleOrigin | None
    text: str | None
    changed: LevelRuleStamp | None
    approved: LevelRuleApproval | None


class LevelRulesMissing(BaseModel):
    """O que falta para ativar, na ordem da tela: definir (vazias) e aprovar (a validar)."""

    define: list[LevelRuleKey]
    approve: list[LevelRuleKey]


class LevelConfirmers(BaseModel):
    """Quem confirma abandono e retorno, além do administrador: os perfis com "Elo: confirmar
    ocorrências" em Editar e as pessoas com o ajuste próprio."""

    profiles: list[Ref]
    people: list[Ref]


class LevelRulesOut(BaseModel):
    """GET /level-rules (e a resposta do PUT e da aprovação). `active` falso: vale o elo de 12
    meses. `can_edit`: grava e aprova (administrador ou supervisor com Configurações em Editar)."""

    version: int
    active: bool
    activated_at: datetime | None
    values: LevelRuleValues
    items: dict[LevelRuleKey, LevelRuleStatus]
    missing: LevelRulesMissing
    confirmers: LevelConfirmers
    can_edit: bool


class LevelRuleChangeItem(BaseModel):
    """Uma regra no histórico, com o texto da tela (null = em branco). No JSON, "from"."""

    model_config = ConfigDict(populate_by_name=True)

    item: LevelRuleKey
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None


class LevelRuleChangeOut(ORMModel):
    """GET /level-rules/history: uma gravação, do mais novo para o mais antigo (actor null =
    Sistema)."""

    id: uuid.UUID
    created_at: datetime
    action: LevelRuleAction
    actor: Ref | None
    note: str | None = None
    changes: list[LevelRuleChangeItem]

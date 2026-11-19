"""Elo dos técnicos (services/technician_levels.py): o selo nas listas, o "Meu elo" do app e o
detalhe da central. Os textos (critérios, risco, ocorrências, regras) chegam prontos do servidor:
a web e o app mostram como estão, sem repetir números.

Também as Estatísticas do técnico (GET /me/stats no app e GET /technicians/{id}/stats na ficha da
central): o total desde sempre, os 12 meses corridos do elo e 12 meses de calendário. Só
contagens, sem OS."""

import datetime as dt
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints

from app.core.enums import LevelOccurrenceKind, LevelTier
from app.schemas.common import Ref

# Motivo de desconsiderar uma ocorrência.
WAIVER_NOTE_MAX = 300

LevelCriterionKey = Literal["services", "measured", "on_time", "rework", "lost"]


class LevelSummary(BaseModel):
    """O selo nas listas (Técnicos, sugestões, oferta): a faixa em vigor, desde quando e se está
    em risco de descer. Sem conta ainda: Bronze, sem data."""

    tier: LevelTier = LevelTier.BRONZE
    since: dt.datetime | None = None
    at_risk: bool = False


class LevelCriterion(BaseModel):
    key: LevelCriterionKey
    label: str
    met: bool
    # Taxas: com menos de 5 casos ainda não há dados suficientes, e o critério conta como cumprido.
    # Nas contagens (atendimentos), sempre true.
    enough_data: bool
    # Contagem: atendimentos. Taxas: os casos (chegadas no horário, retornos, visitas perdidas).
    value: int
    # Base da taxa (chegadas, atendimentos medidos, visitas); null nas contagens.
    base: int | None
    # Mínimo da contagem, meta da chegada no horário (% mínimo) ou limite da taxa (% máximo).
    target: int
    # "38 de 50", "92% (23 de 25) · meta 90% ou mais" ou
    # "Ainda sem dados suficientes (3 de 5 chegadas)".
    text: str
    # O que falta para cumprir ("Faltam 12 atendimentos"); null quando cumprido.
    missing: str | None


class LevelRisk(BaseModel):
    """Abaixo do critério da faixa em vigor: desce em `until` se não voltar a cumprir."""

    since: dt.datetime
    until: dt.datetime
    falls_to: LevelTier
    # Rótulos dos critérios não cumpridos.
    failing: list[str]
    text: str


class LevelNext(BaseModel):
    tier: LevelTier
    criteria: list[LevelCriterion]


class LevelTierRule(BaseModel):
    """Uma faixa e o que ela pede (TIERS no serviço). Taxas em %; null no Bronze."""

    tier: LevelTier
    services: int
    measured: int
    on_time_pct: int | None
    rework_pct: int | None
    lost_pct: int | None
    summary: str


class LevelMetrics(BaseModel):
    """Os números dos últimos 12 meses. As taxas ficam null com menos de 5 casos (chegada no
    horário arredondada para baixo; retorno e visitas perdidas, para cima)."""

    window_start: dt.datetime
    window_end: dt.datetime
    services: int
    as_assignee: int
    as_helper: int
    measured: int
    arrivals: int
    on_time: int
    late: int
    reworks: int
    lost: int
    visits: int
    on_time_pct: int | None
    rework_pct: int | None
    lost_pct: int | None


class LevelTicketRef(BaseModel):
    """A OS da ocorrência no app (sempre do próprio técnico)."""

    id: uuid.UUID
    code: str
    title: str


class CentralLevelTicketRef(BaseModel):
    """A OS da ocorrência na central. `hidden`: OS de outra fila (quem pede vê só a própria
    fila): sem id e sem código, com o título "OS de outra fila", como no calendário."""

    id: uuid.UUID | None
    code: str | None
    title: str
    hidden: bool = False


class LevelOccurrence(BaseModel):
    """O que pesou: chegada fora do horário (`ref_id` = a OS), retorno ou visita perdida
    (`ref_id` = o evento do histórico)."""

    kind: LevelOccurrenceKind
    ref_id: uuid.UUID
    ticket: LevelTicketRef
    at: dt.datetime
    detail: str


class LevelWaiverOut(BaseModel):
    id: uuid.UUID
    # O motivo; null na OS de outra fila (fica só quem desconsiderou e quando).
    note: str | None
    created_by: Ref | None
    created_at: dt.datetime


class CentralLevelOccurrence(LevelOccurrence):
    """Na central: também as desconsideradas, com quem desconsiderou e o motivo. Na OS de outra
    fila (`ticket.hidden`), o detalhe vem sem a nota da reabertura e a desconsideração sem o
    motivo; desconsiderar ou voltar a contar dá 403 QUEUE_FORBIDDEN."""

    ticket: CentralLevelTicketRef  # type: ignore[assignment]
    waiver: LevelWaiverOut | None = None


class MyLevel(BaseModel):
    """GET /me/level: o elo do próprio técnico."""

    tier: LevelTier
    since: dt.datetime
    at_risk: LevelRisk | None
    computed_at: dt.datetime
    metrics: LevelMetrics
    # Os critérios da faixa em vigor (vazio no Bronze).
    criteria: list[LevelCriterion]
    # A próxima faixa e os critérios dela (null no Diamante).
    next: LevelNext | None
    tiers: list[LevelTierRule]
    # "Como funciona".
    rules: list[str]
    # As que contam (sem as desconsideradas), as mais recentes primeiro, até 30.
    occurrences: list[LevelOccurrence]
    occurrences_total: int


class TechnicianLevelDetail(MyLevel):
    """GET /technicians/{id}/level: o elo do técnico na central."""

    technician: Ref
    computed_tier: LevelTier
    # Ocorrências desconsideradas pela central dentro da janela.
    waived: int
    # Motivos de visita improdutiva ativos com responsabilidade "Técnico" (0: visitas perdidas
    # não contam).
    technician_reasons: int
    # Todas, inclusive as desconsideradas, as mais recentes primeiro, até 200 (o total em
    # occurrences_total).
    occurrences: list[CentralLevelOccurrence]  # type: ignore[assignment]


class StatsMonth(BaseModel):
    """Um mês de calendário das Estatísticas, no fuso da operação. Atendimentos, medidos e
    chegadas pelo mês da conclusão; chegada fora do horário pelo da chegada; retorno pelo da
    reabertura; visita perdida pelo da visita. Sem as ocorrências desconsideradas pela central."""

    month: str  # "2026-11"
    current: bool  # o mês de hoje, ainda em andamento (só o último)
    services: int
    as_assignee: int
    as_helper: int
    legacy: int  # atendimentos do sistema antigo (Field Control)
    legacy_only: bool  # services > 0 e todos do sistema antigo: o mês não mede a qualidade
    measured: int
    arrivals: int
    late: int
    reworks: int
    lost: int


class StatsLifetime(BaseModel):
    """Desde sempre: o atendimento do elo sem a janela de 12 meses."""

    services: int
    as_assignee: int
    as_helper: int
    legacy: int
    first_month: str | None  # "2019-03": o mês da conclusão mais antiga; null sem atendimento


class MyStats(BaseModel):
    """GET /me/stats: só leitura."""

    computed_at: dt.datetime
    lifetime: StatsLifetime
    metrics: LevelMetrics  # os 12 meses corridos do elo (a mesma conta de Meu elo)
    months: list[StatsMonth]  # 12, do mais antigo ao atual


class TechnicianStats(MyStats):
    """GET /technicians/{id}/stats: o mesmo, na ficha da central."""

    technician: Ref


class LevelWaiverCreate(BaseModel):
    kind: LevelOccurrenceKind
    ref_id: uuid.UUID
    note: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=WAIVER_NOTE_MAX)
    ]


class LevelRefresh(BaseModel):
    technicians: int
    bronze: int
    silver: int
    gold: int
    diamond: int
    at_risk: int

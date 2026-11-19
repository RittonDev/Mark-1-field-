"""Elo dos técnicos: Bronze, Prata, Ouro e Diamante pela quantidade e pela qualidade dos
atendimentos dos últimos 12 meses (na interface, o "elo" com o brasão; no código e na API,
"level").

O que conta (janela rolando de 365 dias até agora):
- Atendimento: OS resolvida ou fechada, concluída na janela, com visita (chegada registrada ou OS
  migrada do Field Control), em que o técnico foi o responsável ou outro técnico da visita. 1 por
  OS.
- Atendimento medido: o mesmo, só como responsável e só OS deste sistema. A qualidade é medida
  nele: nas OS migradas a agenda sem hora virou 08:00 e o Field Control não trouxe reaberturas nem
  os motivos das improdutivas.
- Chegada no horário combinado: medidos com agenda e chegada. Atraso é chegar mais de 30 min
  depois do horário agendado (field.SCHEDULE_TOLERANCE, a regra do "Atrasada"). OS sem agenda não
  entram (atraso de despacho é da central).
- Retorno: OS concluída e reaberta (de resolvida ou fechada) em até 30 dias da conclusão. Reabrir
  a cancelada não conta.
- Visita perdida: visita improdutiva com motivo de responsabilidade "Técnico", pela classificação
  atual do catálogo.
- A central pode desconsiderar uma ocorrência, com motivo: o atraso vira chegada no horário, o
  retorno e a visita perdida deixam de contar.

Taxas só com 5 casos ou mais (abaixo disso, "ainda sem dados suficientes" e o critério conta como
cumprido). A faixa calculada é a mais alta com todos os critérios cumpridos (TIERS). Sobe na hora;
abaixo da faixa em vigor, fica 30 dias em risco e depois desce direto para a calculada.

O elo é só o selo: não muda a pontuação nem a ordem das sugestões. Este módulo não importa
technicians, suggestions nem tickets (eles importam este).
"""

from __future__ import annotations

import logging
import math
import uuid
from collections import Counter, defaultdict
from collections.abc import Collection, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, NamedTuple
from zoneinfo import ZoneInfo

from sqlalchemy import String, and_, cast, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import settings
from app.core.enums import (
    LevelOccurrenceKind,
    LevelTier,
    Responsibility,
    TicketEventType,
    TicketStatus,
    UserRole,
)
from app.core.labels import LEVEL_TIER_LABELS
from app.db.base import utcnow
from app.models import Ticket, TicketEvent, UnproductiveReason, User
from app.models.technician_level import TechnicianLevel, TechnicianLevelWaiver
from app.models.ticket import ticket_helpers
from app.schemas.common import Ref
from app.schemas.technician_level import (
    CentralLevelOccurrence,
    LevelCriterion,
    LevelMetrics,
    LevelNext,
    LevelOccurrence,
    LevelRisk,
    LevelSummary,
    LevelTicketRef,
    LevelTierRule,
    LevelWaiverCreate,
    LevelWaiverOut,
    MyLevel,
    TechnicianLevelDetail,
)
from app.schemas.ticket import format_ticket_code
from app.services import field as field_rules
from app.services.errors import NotFound, WorkflowError

log = logging.getLogger(__name__)

WINDOW = timedelta(days=365)
REWORK_WINDOW = timedelta(days=30)
LATE_TOLERANCE = field_rules.SCHEDULE_TOLERANCE
MIN_SAMPLE = 5
GRACE = timedelta(days=30)
STALE_AFTER = timedelta(hours=6)
APP_OCCURRENCES = 30
CENTRAL_OCCURRENCES = 200
UPSERT_CHUNK = 500
# Trecho da nota da reabertura no detalhe da central.
REWORK_NOTE_MAX = 200

_RANK = {tier: index for index, tier in enumerate(LevelTier)}
_CONCLUDED = (TicketStatus.RESOLVED, TicketStatus.CLOSED)
# O mesmo predicado do índice parcial ix_ticket_events_reopened (models/ticket.py), escrito por
# extenso: o asyncpg prepara a consulta com parâmetros e o plano genérico só usa o índice parcial
# com o predicado literal.
_REOPENED = text("ticket_events.event_type = 'status_changed' AND ticket_events.to_value = 'reopened'")

LABELS: dict[str, str] = {
    "services": "Atendimentos nos últimos 12 meses",
    "measured": "Atendimentos medidos",
    "on_time": "Chegada no horário combinado",
    "rework": "Retorno (OS reaberta em até 30 dias)",
    "lost": "Visitas perdidas por motivo do técnico",
}

_TOLERANCE_MIN = int(LATE_TOLERANCE.total_seconds() // 60)
RULES: tuple[str, ...] = (
    "Conta o que foi feito nos últimos 12 meses.",
    "Atendimento: OS concluída em que o técnico esteve, como responsável ou junto.",
    "Atendimento medido: OS concluída como responsável no Maxx Field. A qualidade é medida nele; "
    "as OS do sistema antigo contam só na quantidade.",
    f"Chegada no horário combinado: até {_TOLERANCE_MIN} min depois do horário agendado. OS sem "
    "horário agendado não entram.",
    f"Retorno: OS concluída que foi reaberta em até {REWORK_WINDOW.days} dias.",
    "Visita perdida: visita improdutiva com motivo de responsabilidade do técnico.",
    f"Com menos de {MIN_SAMPLE} casos, a taxa ainda não conta.",
    f"Ao deixar de cumprir um critério, o elo fica por mais {GRACE.days} dias. Se não voltar a "
    "cumprir, desce.",
    "Ofertas recusadas, cancelamentos e tempo na loja não contam.",
)


# ------------------------------------------------------------------ regras (sem banco)


@dataclass
class Counts:
    """Os números de um técnico na janela (depois das desconsiderações da central)."""

    services: int = 0
    measured: int = 0
    arrivals: int = 0
    late: int = 0
    reworks: int = 0
    lost: int = 0
    as_assignee: int = 0
    as_helper: int = 0
    waived: int = 0

    @property
    def on_time(self) -> int:
        return self.arrivals - self.late

    @property
    def visits(self) -> int:
        return self.measured + self.lost


@dataclass(frozen=True)
class TierRule:
    tier: LevelTier
    services: int = 0
    measured: int = 0
    on_time_pct: int | None = None  # chegada no horário: meta (mínimo, %)
    rework_pct: int | None = None  # retorno: limite (máximo, %)
    lost_pct: int | None = None  # visitas perdidas: limite (máximo, %)


# As metas ficam aqui (não em Configurações): a mesma régua para todos e mudança deliberada. A API
# devolve os números (tiers) e as telas não os repetem.
TIERS: tuple[TierRule, ...] = (
    TierRule(LevelTier.BRONZE),
    TierRule(LevelTier.SILVER, services=15, on_time_pct=80, rework_pct=10, lost_pct=8),
    TierRule(LevelTier.GOLD, services=50, measured=15, on_time_pct=90, rework_pct=5, lost_pct=4),
    TierRule(
        LevelTier.DIAMOND, services=120, measured=30, on_time_pct=95, rework_pct=3, lost_pct=2
    ),
)
RULE_BY_TIER: dict[LevelTier, TierRule] = {rule.tier: rule for rule in TIERS}


class Standing(NamedTuple):
    """A faixa em vigor: desde quando e desde quando está abaixo do critério."""

    tier: LevelTier
    since: datetime
    at_risk_since: datetime | None


def rank(tier: LevelTier) -> int:
    return _RANK[tier]


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def _on_time_ok(rule: TierRule, c: Counts) -> bool:
    if rule.on_time_pct is None or c.arrivals < MIN_SAMPLE:
        return True
    return 100 * c.on_time >= rule.on_time_pct * c.arrivals


def _rework_ok(rule: TierRule, c: Counts) -> bool:
    if rule.rework_pct is None or c.measured < MIN_SAMPLE:
        return True
    return 100 * c.reworks <= rule.rework_pct * c.measured


def _lost_ok(rule: TierRule, c: Counts) -> bool:
    if rule.lost_pct is None or c.visits < MIN_SAMPLE:
        return True
    return 100 * c.lost <= rule.lost_pct * c.visits


def meets(rule: TierRule, counts: Counts) -> bool:
    """Todos os critérios da faixa cumpridos (comparação em inteiros, sem arredondamento)."""
    return (
        counts.services >= rule.services
        and counts.measured >= rule.measured
        and _on_time_ok(rule, counts)
        and _rework_ok(rule, counts)
        and _lost_ok(rule, counts)
    )


def computed_tier(counts: Counts) -> LevelTier:
    """A faixa mais alta com todos os critérios cumpridos (o Bronze não pede nada)."""
    for rule in reversed(TIERS):
        if meets(rule, counts):
            return rule.tier
    return LevelTier.BRONZE


def apply_grace(prev: Standing | None, computed: LevelTier, now: datetime) -> Standing:
    """Carência: sobe na hora; abaixo da faixa em vigor, mantém a faixa e marca o risco; com 30
    dias seguidos abaixo, desce direto para a calculada; voltando a cumprir, o risco sai. No
    primeiro cálculo, vale a calculada (sem carência)."""
    if prev is None or rank(computed) > rank(prev.tier):
        return Standing(computed, now, None)
    if computed == prev.tier:
        return Standing(prev.tier, prev.since, None)
    if prev.at_risk_since is None:
        return Standing(prev.tier, prev.since, now)
    if now - prev.at_risk_since >= GRACE:
        return Standing(computed, now, None)
    return Standing(prev.tier, prev.since, prev.at_risk_since)


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _count_criterion(key: str, value: int, target: int, one: str, many: str) -> LevelCriterion:
    missing = None
    if value < target:
        gap = target - value
        missing = f"Falta 1 {one}" if gap == 1 else f"Faltam {gap} {many}"
    return LevelCriterion(
        key=key,  # type: ignore[arg-type]
        label=LABELS[key],
        met=value >= target,
        enough_data=True,
        value=value,
        base=None,
        target=target,
        text=f"{value} de {target}",
        missing=missing,
    )


def _not_enough(key: str, value: int, base: int, target: int, unit: str) -> LevelCriterion:
    return LevelCriterion(
        key=key,  # type: ignore[arg-type]
        label=LABELS[key],
        met=True,
        enough_data=False,
        value=value,
        base=base,
        target=target,
        text=f"Ainda sem dados suficientes ({base} de {MIN_SAMPLE} {unit})",
        missing=None,
    )


def _on_time_criterion(c: Counts, goal: int) -> LevelCriterion:
    if c.arrivals < MIN_SAMPLE:
        return _not_enough("on_time", c.on_time, c.arrivals, goal, "chegadas")
    met = 100 * c.on_time >= goal * c.arrivals
    missing = None
    if not met:
        # x chegadas no horário seguidas: 100 * (on_time + x) >= meta * (chegadas + x).
        x = _ceil_div(goal * c.arrivals - 100 * c.on_time, max(100 - goal, 1))
        missing = (
            "Falta 1 chegada no horário"
            if x == 1
            else f"Faltam {x} chegadas no horário seguidas"
        )
    return LevelCriterion(
        key="on_time",
        label=LABELS["on_time"],
        met=met,
        enough_data=True,
        value=c.on_time,
        base=c.arrivals,
        target=goal,
        # Para baixo: o número mostrado nunca passa da meta sem cumprir.
        text=f"{100 * c.on_time // c.arrivals}% ({c.on_time} de {c.arrivals}) · meta {goal}% ou mais",
        missing=missing,
    )


def _limit_criterion(
    key: str, value: int, base: int, limit: int, unit: str, without: str
) -> LevelCriterion:
    if base < MIN_SAMPLE:
        return _not_enough(key, value, base, limit, unit)
    met = 100 * value <= limit * base
    missing = None
    if not met:
        # y atendimentos a mais sem ocorrência: 100 * casos <= limite * (base + y).
        y = _ceil_div(100 * value - limit * base, max(limit, 1))
        noun = _plural(y, "atendimento", "atendimentos")
        missing = f"Com mais {y} {noun} sem {without}, volta ao limite"
    return LevelCriterion(
        key=key,  # type: ignore[arg-type]
        label=LABELS[key],
        met=met,
        enough_data=True,
        value=value,
        base=base,
        target=limit,
        # Para cima: o número mostrado nunca fica dentro do limite sem cumprir.
        text=f"{_ceil_div(100 * value, base)}% ({value} em {base}) · limite {limit}%",
        missing=missing,
    )


def criteria(rule: TierRule, counts: Counts) -> list[LevelCriterion]:
    """Os critérios da faixa, com o texto e o que falta (vazio no Bronze)."""
    out: list[LevelCriterion] = []
    if rule.services:
        out.append(
            _count_criterion(
                "services", counts.services, rule.services, "atendimento", "atendimentos"
            )
        )
    if rule.measured:
        out.append(
            _count_criterion(
                "measured",
                counts.measured,
                rule.measured,
                "atendimento medido",
                "atendimentos medidos",
            )
        )
    if rule.on_time_pct is not None:
        out.append(_on_time_criterion(counts, rule.on_time_pct))
    if rule.rework_pct is not None:
        out.append(
            _limit_criterion(
                "rework",
                counts.reworks,
                counts.measured,
                rule.rework_pct,
                "atendimentos medidos",
                "retorno",
            )
        )
    if rule.lost_pct is not None:
        out.append(
            _limit_criterion(
                "lost", counts.lost, counts.visits, rule.lost_pct, "visitas", "visita perdida"
            )
        )
    return out


def _tz() -> ZoneInfo:
    return ZoneInfo(settings.TIMEZONE)


def _day(value: datetime) -> str:
    return value.astimezone(_tz()).strftime("%d/%m")


def _join(parts: list[str]) -> str:
    """ "a", "a e b", "a, b e c"."""
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " e " + parts[-1]


def risk(
    tier: LevelTier, computed: LevelTier, at_risk_since: datetime | None, counts: Counts
) -> LevelRisk | None:
    """O aviso do risco: o que deixou de cumprir e quando desce (datas no fuso da operação)."""
    if at_risk_since is None:
        return None
    failing = [c.label for c in criteria(RULE_BY_TIER[tier], counts) if not c.met]
    until = at_risk_since + GRACE
    what = _join([label[:1].lower() + label[1:] for label in failing])
    head = f"Abaixo do critério desde {_day(at_risk_since)}" + (f": {what}" if what else "")
    text_ = (
        f"{head}. Se não voltar a cumprir até {_day(until)}, passa para "
        f"{LEVEL_TIER_LABELS[computed]}."
    )
    return LevelRisk(since=at_risk_since, until=until, falls_to=computed, failing=failing, text=text_)


def tier_summary(rule: TierRule) -> str:
    if rule.on_time_pct is None:
        return "Todo técnico começa aqui."
    amount = f"{rule.services} atendimentos" + (f", {rule.measured} medidos" if rule.measured else "")
    return " · ".join(
        (
            amount,
            f"chegada no horário em {rule.on_time_pct}% ou mais",
            f"retorno até {rule.rework_pct}%",
            f"visitas perdidas até {rule.lost_pct}%",
        )
    )


def tier_rules() -> list[LevelTierRule]:
    return [
        LevelTierRule(
            tier=rule.tier,
            services=rule.services,
            measured=rule.measured,
            on_time_pct=rule.on_time_pct,
            rework_pct=rule.rework_pct,
            lost_pct=rule.lost_pct,
            summary=tier_summary(rule),
        )
        for rule in TIERS
    ]


def next_rule(tier: LevelTier) -> TierRule | None:
    position = rank(tier) + 1
    return TIERS[position] if position < len(TIERS) else None


def _duration_text(minutes: int) -> str:
    """Duração: "52 min", "1h", "2h10" (o mesmo formato de home.duration_text)."""
    if minutes < 60:
        return f"{minutes} min"
    hours, rest = divmod(minutes, 60)
    return f"{hours}h{rest:02d}" if rest else f"{hours}h"


def late_detail(scheduled_start: datetime, arrived_at: datetime) -> str:
    seconds = (arrived_at - scheduled_start).total_seconds()
    # Atraso é passar da tolerância: nunca aparece como "30 min" por arredondamento.
    minutes = max(round(seconds / 60), _TOLERANCE_MIN + 1)
    local = scheduled_start.astimezone(_tz())
    return (
        f"Chegou {_duration_text(minutes)} depois do horário combinado "
        f"({local:%H:%M} de {local:%d/%m})"
    )


def rework_detail(concluded_at: datetime, reopened_at: datetime) -> str:
    """Dias no calendário da operação entre a conclusão e a reabertura."""
    tz = _tz()
    days = (reopened_at.astimezone(tz).date() - concluded_at.astimezone(tz).date()).days
    if days <= 0:
        return "Reaberta no mesmo dia da conclusão"
    return f"Reaberta {days} {_plural(days, 'dia', 'dias')} depois da conclusão"


def _short_note(note: str | None) -> str | None:
    note = " ".join((note or "").split())
    if not note:
        return None
    return note if len(note) <= REWORK_NOTE_MAX else note[: REWORK_NOTE_MAX - 1] + "…"


def _pct_floor(value: int, base: int) -> int | None:
    return 100 * value // base if base >= MIN_SAMPLE else None


def _pct_ceil(value: int, base: int) -> int | None:
    return _ceil_div(100 * value, base) if base >= MIN_SAMPLE else None


# ------------------------------------------------------------------ contas no banco


@dataclass
class Occurrence:
    """Uma ocorrência que pesa (ou pesaria, se desconsiderada) no elo de um técnico."""

    kind: LevelOccurrenceKind
    ref_id: uuid.UUID
    technician_id: uuid.UUID
    ticket_id: uuid.UUID
    number: int
    title: str
    at: datetime
    detail: str
    # Nota da reabertura (só a central vê).
    note: str | None = None
    waiver: TechnicianLevelWaiver | None = None


@dataclass
class Collected:
    window_start: datetime
    window_end: datetime
    counts: dict[uuid.UUID, Counts]
    # Por técnico, as mais recentes primeiro (inclusive as desconsideradas).
    occurrences: dict[uuid.UUID, list[Occurrence]]


def _as_uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


async def collect(db: AsyncSession, now: datetime, user_id: uuid.UUID | None = None) -> Collected:
    """Os números e as ocorrências da janela: de todos os técnicos ou só de `user_id`.

    Seis consultas: responsável (contagens), junto (contagens), atrasos (lista), reaberturas (e as
    conclusões delas), visitas perdidas e desconsiderações. As de OS filtram pelo técnico quando
    há `user_id` (índices de assignee e de ticket_helpers); reaberturas e visitas perdidas são
    poucas e ficam com o técnico depois da atribuição, aqui no Python.
    """
    start = now - WINDOW
    counts: dict[uuid.UUID, Counts] = defaultdict(Counts)
    found: dict[uuid.UUID, list[Occurrence]] = defaultdict(list)

    done = (
        Ticket.status.in_(_CONCLUDED),
        Ticket.resolved_at >= start,
        Ticket.resolved_at <= now,
        or_(Ticket.arrived_at.is_not(None), Ticket.legacy.is_not(None)),
    )
    native = Ticket.legacy.is_(None)
    timed = and_(native, Ticket.scheduled_start.is_not(None), Ticket.arrived_at.is_not(None))
    is_late = and_(timed, Ticket.arrived_at > Ticket.scheduled_start + LATE_TOLERANCE)

    # 1) Como responsável: atendimentos, medidos (deste sistema) e chegadas com agenda.
    own = (
        select(
            Ticket.assignee_id,
            func.count(),
            func.count().filter(native),
            func.count().filter(timed),
        )
        .where(Ticket.assignee_id.is_not(None), *done)
        .group_by(Ticket.assignee_id)
    )
    if user_id is not None:
        own = own.where(Ticket.assignee_id == user_id)
    for tech_id, total, measured, arrivals in (await db.execute(own)).all():
        c = counts[tech_id]
        c.as_assignee, c.measured, c.arrivals = total, measured, arrivals

    # 2) Junto (outros técnicos da visita), sem contar duas vezes quem também é o responsável.
    helper = ticket_helpers.c.user_id
    joined = (
        select(helper, func.count(func.distinct(Ticket.id)))
        .join(Ticket, Ticket.id == ticket_helpers.c.ticket_id)
        .where(*done, or_(Ticket.assignee_id.is_(None), Ticket.assignee_id != helper))
        .group_by(helper)
    )
    if user_id is not None:
        joined = joined.where(helper == user_id)
    for tech_id, total in (await db.execute(joined)).all():
        counts[tech_id].as_helper = total

    # 3) Chegadas fora do horário (a lista: a central pode desconsiderar cada uma).
    late = select(
        Ticket.id,
        Ticket.number,
        Ticket.title,
        Ticket.scheduled_start,
        Ticket.arrived_at,
        Ticket.assignee_id,
    ).where(Ticket.assignee_id.is_not(None), *done, is_late)
    if user_id is not None:
        late = late.where(Ticket.assignee_id == user_id)
    for row in (await db.execute(late)).all():
        found[row.assignee_id].append(
            Occurrence(
                kind=LevelOccurrenceKind.LATE,
                ref_id=row.id,
                technician_id=row.assignee_id,
                ticket_id=row.id,
                number=row.number,
                title=row.title,
                at=row.arrived_at,
                detail=late_detail(row.scheduled_start, row.arrived_at),
            )
        )

    # 4) Retornos: reaberturas de OS concluída na janela, até 30 dias depois da conclusão.
    for occ in await _reworks(db, start, now):
        if user_id is None or occ.technician_id == user_id:
            found[occ.technician_id].append(occ)

    # 5) Visitas perdidas: improdutivas com motivo de responsabilidade do técnico.
    for occ in await _lost_visits(db, start, now):
        if user_id is None or occ.technician_id == user_id:
            found[occ.technician_id].append(occ)

    # 6) O que a central desconsiderou.
    waivers_stmt = select(TechnicianLevelWaiver)
    if user_id is not None:
        waivers_stmt = waivers_stmt.where(TechnicianLevelWaiver.technician_id == user_id)
    waivers = {(w.technician_id, w.kind, w.ref_id): w for w in await db.scalars(waivers_stmt)}

    for tech_id, items in found.items():
        c = counts[tech_id]
        for occ in items:
            occ.waiver = waivers.get((tech_id, occ.kind, occ.ref_id))
            if occ.waiver is not None:
                c.waived += 1
            elif occ.kind == LevelOccurrenceKind.LATE:
                c.late += 1
            elif occ.kind == LevelOccurrenceKind.REWORK:
                c.reworks += 1
            else:
                c.lost += 1
        items.sort(key=lambda o: (o.at, str(o.ref_id)), reverse=True)
    for c in counts.values():
        c.services = c.as_assignee + c.as_helper
    return Collected(start, now, dict(counts), dict(found))


async def _reworks(db: AsyncSession, start: datetime, now: datetime) -> list[Occurrence]:
    """Reaberturas na janela de OS resolvida ou fechada, ligadas à conclusão que reabriram (a
    última "resolvida" antes delas) e atribuídas: ao técnico gravado no evento (daqui em diante),
    senão ao autor da conclusão se for técnico, senão ao responsável atual."""
    reopened = (
        _REOPENED,
        TicketEvent.from_value.in_([s.value for s in _CONCLUDED]),
        TicketEvent.created_at >= start,
        TicketEvent.created_at <= now,
    )
    rows = (
        await db.execute(
            select(
                TicketEvent.id,
                TicketEvent.ticket_id,
                TicketEvent.created_at,
                TicketEvent.note,
                TicketEvent.data["technician_id"].astext.label("technician"),
                Ticket.assignee_id,
                Ticket.number,
                Ticket.title,
            )
            .join(Ticket, Ticket.id == TicketEvent.ticket_id)
            .where(*reopened)
        )
    ).all()
    if not rows:
        return []
    # As conclusões das OS reabertas (a consulta de dentro usa a tabela sem apelido, como o
    # predicado literal do índice).
    concluded = aliased(TicketEvent, name="concluded")
    conclusions: dict[uuid.UUID, list[tuple[datetime, uuid.UUID | None, UserRole | None]]] = (
        defaultdict(list)
    )
    for ticket_id, at, actor_id, role in (
        await db.execute(
            select(concluded.ticket_id, concluded.created_at, concluded.actor_id, User.role)
            .outerjoin(User, User.id == concluded.actor_id)
            .where(
                concluded.ticket_id.in_(select(TicketEvent.ticket_id).where(*reopened)),
                concluded.event_type == TicketEventType.STATUS_CHANGED,
                concluded.to_value == TicketStatus.RESOLVED.value,
                concluded.created_at >= start - REWORK_WINDOW,
                concluded.created_at <= now,
            )
            .order_by(concluded.created_at)
        )
    ).all():
        conclusions[ticket_id].append((at, actor_id, role))

    out: list[Occurrence] = []
    for row in rows:
        before = [c for c in conclusions.get(row.ticket_id, ()) if c[0] < row.created_at]
        if not before:
            continue
        concluded_at, author_id, author_role = before[-1]
        if row.created_at - concluded_at > REWORK_WINDOW:
            continue
        tech_id = (
            _as_uuid(row.technician)
            or (author_id if author_role == UserRole.TECHNICIAN else None)
            or row.assignee_id
        )
        if tech_id is None:
            continue
        out.append(
            Occurrence(
                kind=LevelOccurrenceKind.REWORK,
                ref_id=row.id,
                technician_id=tech_id,
                ticket_id=row.ticket_id,
                number=row.number,
                title=row.title,
                at=row.created_at,
                detail=rework_detail(concluded_at, row.created_at),
                note=row.note,
            )
        )
    return out


async def _lost_visits(db: AsyncSession, start: datetime, now: datetime) -> list[Occurrence]:
    """Improdutivas na janela cujo motivo está hoje com responsabilidade "Técnico", atribuídas ao
    técnico gravado no evento, senão ao autor se for técnico, senão ao responsável atual. O motivo
    é comparado como texto: um reason_id fora do formato não derruba a conta."""
    rows = (
        await db.execute(
            select(
                TicketEvent.id,
                TicketEvent.ticket_id,
                TicketEvent.created_at,
                TicketEvent.actor_id,
                User.role.label("actor_role"),
                TicketEvent.data["technician_id"].astext.label("technician"),
                Ticket.assignee_id,
                Ticket.number,
                Ticket.title,
                UnproductiveReason.name.label("reason"),
            )
            .join(Ticket, Ticket.id == TicketEvent.ticket_id)
            .join(
                UnproductiveReason,
                and_(
                    cast(UnproductiveReason.id, String) == TicketEvent.data["reason_id"].astext,
                    UnproductiveReason.responsibility == Responsibility.TECHNICIAN,
                ),
            )
            .outerjoin(User, User.id == TicketEvent.actor_id)
            .where(
                TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
                TicketEvent.created_at >= start,
                TicketEvent.created_at <= now,
            )
        )
    ).all()
    out: list[Occurrence] = []
    for row in rows:
        tech_id = (
            _as_uuid(row.technician)
            or (row.actor_id if row.actor_role == UserRole.TECHNICIAN else None)
            or row.assignee_id
        )
        if tech_id is None:
            continue
        out.append(
            Occurrence(
                kind=LevelOccurrenceKind.UNPRODUCTIVE,
                ref_id=row.id,
                technician_id=tech_id,
                ticket_id=row.ticket_id,
                number=row.number,
                title=row.title,
                at=row.created_at,
                detail=f"Visita improdutiva: {row.reason}",
            )
        )
    return out


# ------------------------------------------------------------------ gravação (technician_levels)


@dataclass
class Snapshot:
    """O elo de um técnico recém-calculado: a faixa em vigor, os números e as ocorrências."""

    user_id: uuid.UUID
    standing: Standing
    computed: LevelTier
    computed_at: datetime
    window_start: datetime
    counts: Counts
    occurrences: list[Occurrence]


def _metrics_json(counts: Counts, start: datetime, end: datetime) -> dict[str, Any]:
    return {
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "services": counts.services,
        "as_assignee": counts.as_assignee,
        "as_helper": counts.as_helper,
        "measured": counts.measured,
        "arrivals": counts.arrivals,
        "late": counts.late,
        "reworks": counts.reworks,
        "lost": counts.lost,
        "waived": counts.waived,
    }


def _row(
    user_id: uuid.UUID,
    standing: Standing,
    computed: LevelTier,
    counts: Counts,
    start: datetime,
    now: datetime,
) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "tier": standing.tier,
        "computed_tier": computed,
        "tier_since": standing.since,
        "at_risk_since": standing.at_risk_since,
        "metrics": _metrics_json(counts, start, now),
        "computed_at": now,
        "created_at": now,
        "updated_at": now,
    }


async def _upsert(db: AsyncSession, rows: list[dict[str, Any]]) -> None:
    for i in range(0, len(rows), UPSERT_CHUNK):
        stmt = pg_insert(TechnicianLevel).values(rows[i : i + UPSERT_CHUNK])
        await db.execute(
            stmt.on_conflict_do_update(
                index_elements=[TechnicianLevel.user_id],
                set_={
                    key: stmt.excluded[key]
                    for key in (
                        "tier",
                        "computed_tier",
                        "tier_since",
                        "at_risk_since",
                        "metrics",
                        "computed_at",
                        "updated_at",
                    )
                },
            )
        )


async def refresh_all(db: AsyncSession, now: datetime | None = None) -> dict[str, int]:
    """Recalcula o elo de todos os técnicos (também os sem acesso ao app) e devolve quantos ficaram
    em cada faixa. As linhas ficam travadas até o fim da transação (um recálculo de um técnico no
    meio espera)."""
    now = now or utcnow()
    tech_ids = list(await db.scalars(select(User.id).where(User.role == UserRole.TECHNICIAN)))
    previous = {
        row.user_id: Standing(row.tier, row.tier_since, row.at_risk_since)
        for row in (
            await db.execute(
                select(
                    TechnicianLevel.user_id,
                    TechnicianLevel.tier,
                    TechnicianLevel.tier_since,
                    TechnicianLevel.at_risk_since,
                ).with_for_update()
            )
        ).all()
    }
    collected = await collect(db, now)
    tally: Counter[str] = Counter()
    rows = []
    for user_id in tech_ids:
        counts = collected.counts.get(user_id) or Counts()
        computed = computed_tier(counts)
        standing = apply_grace(previous.get(user_id), computed, now)
        rows.append(_row(user_id, standing, computed, counts, collected.window_start, now))
        tally[standing.tier.value] += 1
        if standing.at_risk_since is not None:
            tally["at_risk"] += 1
    await _upsert(db, rows)
    result = {
        "technicians": len(tech_ids),
        **{tier.value: tally[tier.value] for tier in LevelTier},
        "at_risk": tally["at_risk"],
    }
    log.info(
        "Elos dos técnicos: %d técnicos (bronze %d, prata %d, ouro %d, diamante %d; em risco %d)",
        result["technicians"],
        result["bronze"],
        result["silver"],
        result["gold"],
        result["diamond"],
        result["at_risk"],
    )
    return result


async def refresh_one(
    db: AsyncSession, user_id: uuid.UUID, now: datetime | None = None
) -> Snapshot:
    """Recalcula um técnico agora (app, cadastro na central, desconsiderar), com a linha dele
    travada até o fim da transação."""
    now = now or utcnow()
    row = await db.scalar(
        select(TechnicianLevel)
        .where(TechnicianLevel.user_id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    collected = await collect(db, now, user_id)
    counts = collected.counts.get(user_id) or Counts()
    computed = computed_tier(counts)
    prev = Standing(row.tier, row.tier_since, row.at_risk_since) if row is not None else None
    standing = apply_grace(prev, computed, now)
    await _upsert(db, [_row(user_id, standing, computed, counts, collected.window_start, now)])
    return Snapshot(
        user_id=user_id,
        standing=standing,
        computed=computed,
        computed_at=now,
        window_start=collected.window_start,
        counts=counts,
        occurrences=collected.occurrences.get(user_id, []),
    )


async def refresh_if_stale(db: AsyncSession, now: datetime | None = None) -> bool:
    """A rotina periódica (app.main): recalcula todos se algum técnico ainda não tem a conta ou se
    a conta mais antiga tem 6 h ou mais. Vale a mais antiga: o app recalcula um técnico por vez o
    tempo todo, e a mais nova estaria sempre em dia."""
    now = now or utcnow()
    total, missing, oldest = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(TechnicianLevel.user_id.is_(None)),
                func.min(TechnicianLevel.computed_at),
            )
            .select_from(User)
            .outerjoin(TechnicianLevel, TechnicianLevel.user_id == User.id)
            .where(User.role == UserRole.TECHNICIAN)
        )
    ).one()
    if not total:
        return False
    if not missing and oldest is not None and now - oldest < STALE_AFTER:
        return False
    await refresh_all(db, now)
    return True


async def ensure_computed(db: AsyncSession) -> bool:
    """Antes da primeira lista de Técnicos ou das sugestões: sem nenhuma conta ainda, calcula
    todos. Depois disso, a rotina periódica mantém em dia (a requisição só lê)."""
    if await db.scalar(select(TechnicianLevel.user_id).limit(1)) is not None:
        return False
    if await db.scalar(select(User.id).where(User.role == UserRole.TECHNICIAN).limit(1)) is None:
        return False
    await refresh_all(db)
    return True


async def mark_stale(db: AsyncSession, now: datetime | None = None) -> None:
    """Pede o recálculo de todos na próxima rodada da rotina (ex.: a responsabilidade de um motivo
    de improdutiva mudou e as visitas antigas passam a contar ou não)."""
    now = now or utcnow()
    await db.execute(
        update(TechnicianLevel)
        .values(computed_at=func.least(TechnicianLevel.computed_at, now - STALE_AFTER))
        .execution_options(synchronize_session=False)
    )


async def summaries(db: AsyncSession, ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, LevelSummary]:
    """O selo de cada técnico pela conta guardada (uma consulta). Sem linha: fica de fora (use
    summary_of, que devolve Bronze)."""
    wanted = list(dict.fromkeys(ids))
    if not wanted:
        return {}
    rows = await db.execute(
        select(
            TechnicianLevel.user_id,
            TechnicianLevel.tier,
            TechnicianLevel.tier_since,
            TechnicianLevel.at_risk_since,
        ).where(TechnicianLevel.user_id.in_(wanted))
    )
    return {
        user_id: LevelSummary(tier=tier, since=since, at_risk=at_risk is not None)
        for user_id, tier, since, at_risk in rows.all()
    }


def summary_of(levels: dict[uuid.UUID, LevelSummary], user_id: uuid.UUID) -> LevelSummary:
    return levels.get(user_id) or LevelSummary()


# ------------------------------------------------------------------ respostas


def _metrics(snapshot: Snapshot) -> LevelMetrics:
    c = snapshot.counts
    return LevelMetrics(
        window_start=snapshot.window_start,
        window_end=snapshot.computed_at,
        services=c.services,
        as_assignee=c.as_assignee,
        as_helper=c.as_helper,
        measured=c.measured,
        arrivals=c.arrivals,
        on_time=c.on_time,
        late=c.late,
        reworks=c.reworks,
        lost=c.lost,
        visits=c.visits,
        on_time_pct=_pct_floor(c.on_time, c.arrivals),
        rework_pct=_pct_ceil(c.reworks, c.measured),
        lost_pct=_pct_ceil(c.lost, c.visits),
    )


def _common(snapshot: Snapshot) -> dict[str, Any]:
    """Os campos de MyLevel menos as ocorrências."""
    tier = snapshot.standing.tier
    following = next_rule(tier)
    return {
        "tier": tier,
        "since": snapshot.standing.since,
        "at_risk": risk(tier, snapshot.computed, snapshot.standing.at_risk_since, snapshot.counts),
        "computed_at": snapshot.computed_at,
        "metrics": _metrics(snapshot),
        "criteria": criteria(RULE_BY_TIER[tier], snapshot.counts),
        "next": (
            LevelNext(tier=following.tier, criteria=criteria(following, snapshot.counts))
            if following is not None
            else None
        ),
        "tiers": tier_rules(),
        "rules": list(RULES),
    }


def _ticket_ref(occ: Occurrence) -> LevelTicketRef:
    return LevelTicketRef(id=occ.ticket_id, code=format_ticket_code(occ.number), title=occ.title)


def _occurrence(occ: Occurrence) -> LevelOccurrence:
    """Para o técnico: sem a nota da central e sem desconsideração."""
    return LevelOccurrence(
        kind=occ.kind, ref_id=occ.ref_id, ticket=_ticket_ref(occ), at=occ.at, detail=occ.detail
    )


def _central_occurrence(occ: Occurrence) -> CentralLevelOccurrence:
    detail = occ.detail
    note = _short_note(occ.note) if occ.kind == LevelOccurrenceKind.REWORK else None
    if note:
        detail = f"{detail} · Motivo: {note}"
    waiver = occ.waiver
    return CentralLevelOccurrence(
        kind=occ.kind,
        ref_id=occ.ref_id,
        ticket=_ticket_ref(occ),
        at=occ.at,
        detail=detail,
        waiver=(
            LevelWaiverOut(
                id=waiver.id,
                note=waiver.note,
                created_by=(
                    Ref(id=waiver.created_by.id, name=waiver.created_by.name)
                    if waiver.created_by is not None
                    else None
                ),
                created_at=waiver.created_at,
            )
            if waiver is not None
            else None
        ),
    )


async def my_level(db: AsyncSession, user: User, now: datetime | None = None) -> MyLevel:
    """O elo do próprio técnico, recalculado agora. Só as ocorrências que contam, sem notas da
    central nem desconsiderações, e nada de outros técnicos."""
    snapshot = await refresh_one(db, user.id, now)
    counting = [o for o in snapshot.occurrences if o.waiver is None]
    return MyLevel(
        **_common(snapshot),
        occurrences=[_occurrence(o) for o in counting[:APP_OCCURRENCES]],
        occurrences_total=len(counting),
    )


async def technician_reasons(db: AsyncSession) -> int:
    """Motivos de improdutiva ativos com responsabilidade "Técnico" (sem nenhum, visitas perdidas
    não contam: a central é avisada no cadastro)."""
    return (
        await db.scalar(
            select(func.count())
            .select_from(UnproductiveReason)
            .where(
                UnproductiveReason.is_active.is_(True),
                UnproductiveReason.responsibility == Responsibility.TECHNICIAN,
            )
        )
        or 0
    )


async def central_detail(
    db: AsyncSession, technician: User, now: datetime | None = None
) -> TechnicianLevelDetail:
    """O elo do técnico na central, recalculado agora, com as desconsiderações."""
    snapshot = await refresh_one(db, technician.id, now)
    return TechnicianLevelDetail(
        **_common(snapshot),
        technician=Ref(id=technician.id, name=technician.name),
        computed_tier=snapshot.computed,
        waived=snapshot.counts.waived,
        technician_reasons=await technician_reasons(db),
        occurrences=[_central_occurrence(o) for o in snapshot.occurrences[:CENTRAL_OCCURRENCES]],
        occurrences_total=len(snapshot.occurrences),
    )


async def occurrences(
    db: AsyncSession, technician_id: uuid.UUID, now: datetime | None = None
) -> list[Occurrence]:
    """As ocorrências do técnico na janela (inclusive as desconsideradas), sem gravar nada."""
    collected = await collect(db, now or utcnow(), technician_id)
    return collected.occurrences.get(technician_id, [])


async def add_waiver(
    db: AsyncSession,
    technician: User,
    body: LevelWaiverCreate,
    actor: User,
    now: datetime | None = None,
) -> TechnicianLevelDetail:
    """Desconsidera uma ocorrência do técnico (com o motivo) e recalcula. Só vale uma ocorrência
    dele na janela; a repetida cai na restrição única (409 em app.main)."""
    now = now or utcnow()
    match = next(
        (
            o
            for o in await occurrences(db, technician.id, now)
            if o.kind == body.kind and o.ref_id == body.ref_id
        ),
        None,
    )
    if match is None:
        raise WorkflowError("Ocorrência não encontrada nos últimos 12 meses")
    db.add(
        TechnicianLevelWaiver(
            technician_id=technician.id,
            kind=body.kind,
            ticket_id=match.ticket_id,
            ref_id=body.ref_id,
            note=body.note,
            created_by_id=actor.id,
            created_at=now,
        )
    )
    await db.flush()
    return await central_detail(db, technician, now)


async def remove_waiver(
    db: AsyncSession, technician: User, waiver_id: uuid.UUID, now: datetime | None = None
) -> TechnicianLevelDetail:
    """A ocorrência volta a contar (apaga a desconsideração) e o técnico é recalculado."""
    waiver = await db.get(TechnicianLevelWaiver, waiver_id)
    if waiver is None or waiver.technician_id != technician.id:
        raise NotFound("Ocorrência desconsiderada não encontrada")
    await db.delete(waiver)
    await db.flush()
    return await central_detail(db, technician, now)


def tiers_count(levels: Collection[LevelSummary]) -> dict[str, int]:
    """Quantos em cada faixa (para conferências e testes)."""
    tally = Counter(level.tier.value for level in levels)
    return {tier.value: tally[tier.value] for tier in LevelTier}

"""Regras de campo da Maxx Field: dois relógios de 4 horas.

- Chegada: nas capitais o técnico chega em até 4 horas da solicitação (no interior, o prazo
  configurado). Visita combinada com o cliente para depois desse prazo (agenda) muda o prazo
  para o horário combinado, com 30 minutos de tolerância. Nas OS antigas que tiveram a
  autorização do cliente registrada (função retirada), o relógio começa na autorização.
- Permanência: cada chamado inclui até 4 horas de técnico na loja, somando as visitas (o tempo
  em "Em atendimento"). A cada entrada o limite é o que sobrou dessas horas.

Aqui também ficam as regras únicas usadas pelos cartões, pelas filas, pelas Atividades do dia,
pela Início e pelo Mapa ao vivo: "em campo agora" (a caminho ou em atendimento há até 12 h; no
mapa, a OS atual do técnico), "atrasada para começar"
(30 min depois do horário, sem improdutiva no horário ou depois) e "esperando data nova" (a
última visita deu improdutiva e nenhuma outra foi marcada depois dela).
"""

import unicodedata
import uuid
from collections.abc import Collection
from datetime import datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import ColumnElement, and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import AuthorizationStatus, TicketEventType, TicketStatus
from app.models import Location, SystemSetting, Ticket, TicketEvent, User
from app.schemas.field import FieldRules

RULES_KEY = "field.rules"
AT_RISK = timedelta(minutes=60)
# Visita agendada para depois do prazo de chegada: o prazo passa a ser o horário combinado mais
# esta tolerância (trânsito, estacionamento, portaria).
SCHEDULE_TOLERANCE = timedelta(minutes=30)
S = TicketStatus
FINISHED = (S.RESOLVED, S.CLOSED, S.CANCELLED)
# Em campo: a caminho ou em atendimento.
FIELD = (S.EN_ROUTE, S.IN_PROGRESS)
# Em campo há mais que isto é dado parado (esqueceram de concluir ou de voltar a OS): não conta
# como "em campo agora" e vira alerta.
FIELD_STUCK_AFTER = timedelta(hours=12)

# As 27 capitais (cidade normalizada, UF).
CAPITALS = frozenset(
    {
        ("rio branco", "AC"),
        ("maceio", "AL"),
        ("macapa", "AP"),
        ("manaus", "AM"),
        ("salvador", "BA"),
        ("fortaleza", "CE"),
        ("brasilia", "DF"),
        ("vitoria", "ES"),
        ("goiania", "GO"),
        ("sao luis", "MA"),
        ("cuiaba", "MT"),
        ("campo grande", "MS"),
        ("belo horizonte", "MG"),
        ("belem", "PA"),
        ("joao pessoa", "PB"),
        ("curitiba", "PR"),
        ("recife", "PE"),
        ("teresina", "PI"),
        ("rio de janeiro", "RJ"),
        ("natal", "RN"),
        ("porto alegre", "RS"),
        ("porto velho", "RO"),
        ("boa vista", "RR"),
        ("florianopolis", "SC"),
        ("sao paulo", "SP"),
        ("aracaju", "SE"),
        ("palmas", "TO"),
    }
)
_CAPITAL_NAMES = frozenset(name for name, _ in CAPITALS)


def normalize(text: str | None) -> str:
    """Sem acento, minúsculo e com espaços simples ("São  Paulo" -> "sao paulo")."""
    if not text:
        return ""
    plain = unicodedata.normalize("NFD", text)
    plain = "".join(c for c in plain if unicodedata.category(c) != "Mn")
    return " ".join(plain.lower().split())


def is_capital(city: str | None, state: str | None) -> bool:
    name = normalize(city)
    if not name:
        return False
    uf = (state or "").strip().upper()
    if uf:
        return (name, uf) in CAPITALS
    return name in _CAPITAL_NAMES  # sem UF cadastrada: vale o nome da cidade


# ------------------------------------------------------------------ configuração


async def rules(db: AsyncSession) -> FieldRules:
    setting = await db.get(SystemSetting, RULES_KEY)
    if setting is None or not isinstance(setting.value, dict):
        return FieldRules()
    try:
        return FieldRules.model_validate(setting.value)
    except ValidationError:
        return FieldRules()


async def save_rules(db: AsyncSession, data: FieldRules, actor: User) -> FieldRules:
    setting = await db.get(SystemSetting, RULES_KEY)
    if setting is None:
        setting = SystemSetting(key=RULES_KEY)
        db.add(setting)
    setting.value = data.model_dump()
    setting.updated_by_id = actor.id
    await db.flush()
    return data


# ------------------------------------------------------------------ relógios


def arrival_hours(r: FieldRules, city: str | None, state: str | None) -> int | None:
    return r.arrival_hours_capital if is_capital(city, state) else r.arrival_hours_interior


def clock_start(ticket: Any) -> datetime | None:
    """Início do relógio de chegada: a abertura da OS. Nas OS antigas que tiveram a autorização do
    cliente registrada (função retirada em 2026-11-12), vale a hora da autorização."""
    if ticket.authorization_status == AuthorizationStatus.AUTHORIZED and ticket.authorized_at:
        return ticket.authorized_at
    return ticket.created_at


def arrival_due(
    start: datetime | None, hours: int | None, scheduled_start: datetime | None
) -> datetime | None:
    """Prazo de chegada: início do relógio + horas da cidade; com a visita combinada para depois
    disso, o horário combinado + tolerância (sem "Chegada atrasada" falsa em toda preventiva)."""
    if start is None or not hours:
        return None
    due = start + timedelta(hours=hours)
    if scheduled_start is not None:
        due = max(due, scheduled_start + SCHEDULE_TOLERANCE)
    return due


async def recompute_arrival_due(db: AsyncSession, ticket: Ticket, r: FieldRules) -> None:
    """Prazo de chegada a partir do início do relógio, do local (capital ou interior) e da
    agenda. Depois da chegada o prazo não muda mais."""
    if ticket.arrived_at is not None:
        return
    location = await db.get(Location, ticket.location_id) if ticket.location_id else None
    hours = arrival_hours(
        r, location.city if location else None, location.state if location else None
    )
    ticket.arrival_due_at = arrival_due(clock_start(ticket), hours, ticket.scheduled_start)


def start_onsite_clock(ticket: Ticket, r: FieldRules, start: datetime, *, used_s: int = 0) -> None:
    """Limite de tempo na loja para o trecho que começa em `start`: o que sobra das horas do
    chamado depois dos `used_s` segundos já usados em visitas anteriores."""
    left = max(0, r.onsite_hours * 3600 - used_s)
    ticket.onsite_due_at = start + timedelta(seconds=left)
    ticket.onsite_warning_at = ticket.onsite_due_at - timedelta(minutes=r.onsite_warning_minutes)


def on_arrival(ticket: Ticket, r: FieldRules, now: datetime) -> None:
    """Primeira chegada ao local: começa a contar o tempo de técnico na loja."""
    if ticket.arrived_at is not None:
        return
    ticket.arrived_at = now
    start_onsite_clock(ticket, r, now)


def on_reentry(ticket: Ticket, r: FieldRules, now: datetime) -> None:
    """Volta para "Em atendimento" (nova visita ou retomada depois de uma pausa): o limite é o
    que sobrou das horas do chamado, não o relógio corrido desde a primeira chegada."""
    start_onsite_clock(ticket, r, now, used_s=ticket.work_seconds or 0)


# ------------------------------------------------------------------ situação (para listas e filas)


def late_to_start(scheduled_start: datetime | None, now: datetime) -> bool:
    """A visita já devia ter começado: 30 min ou mais depois do horário (SCHEDULE_TOLERANCE). A
    mesma conta do "Atrasada" da Minha fila e das Atividades do dia e do "sem início" da Início."""
    return scheduled_start is not None and scheduled_start <= now - SCHEDULE_TOLERANCE


def bounced_after_schedule(t: Any) -> bool:
    """Teve visita improdutiva no horário agendado ou depois (OS migrada que manteve a agenda): a
    visita aconteceu e a OS espera data nova, então não está "atrasada para começar"."""
    return (
        t.last_unproductive_at is not None
        and t.scheduled_start is not None
        and t.last_unproductive_at >= t.scheduled_start
    )


def awaiting_new_visit(t: Any) -> bool:
    """A última visita deu improdutiva e nenhuma visita nova foi marcada depois dela ("Improdutiva:
    reagendar"). Não há chegada a cobrar: o técnico foi. No fluxo nativo a improdutiva tira a agenda
    e o prazo de chegada recalculado fica no passado; o "Chegada atrasada" volta a valer para a
    visita nova, quando ela é marcada."""
    bounced = t.last_unproductive_at
    return bounced is not None and (t.scheduled_start is None or t.scheduled_start < bounced)


def awaiting_new_visit_clause() -> ColumnElement[bool]:
    """A regra de awaiting_new_visit no banco."""
    return and_(
        Ticket.last_unproductive_at.is_not(None),
        or_(Ticket.scheduled_start.is_(None), Ticket.scheduled_start < Ticket.last_unproductive_at),
    )


def arrival_status(t: Any, now: datetime) -> str | None:
    """ "met" | "late" | "at_risk" | "pending" | None (sem prazo ou visita que não houve)."""
    due = t.arrival_due_at
    if due is None:
        return None
    arrived = t.arrived_at
    if arrived is not None:
        return "met" if arrived <= due else "late"
    if t.status in FINISHED:
        return None  # resolvida sem visita (remoto) ou cancelada
    if now > due:
        return "late"
    if due - now <= AT_RISK:
        return "at_risk"
    return "pending"


def onsite_status(t: Any, now: datetime) -> str | None:
    """ "ok" | "warning" | "over" | None: tempo de técnico na loja contra o limite."""
    due = t.onsite_due_at
    if t.arrived_at is None or due is None:
        return None
    if t.status == S.IN_PROGRESS:
        moment = now
    elif t.status in (S.RESOLVED, S.CLOSED) and t.resolved_at is not None:
        moment = t.resolved_at
    else:
        return None
    if moment > due:
        return "over"
    warning = getattr(t, "onsite_warning_at", None)
    if warning is not None and moment >= warning:
        return "warning"
    return "ok"


# ------------------------------------------------------------------ em campo agora (regra única)


def field_since() -> ColumnElement[Any]:
    """Desde quando a OS está em campo: a última ida para "Em deslocamento" ou "Em atendimento" no
    histórico; sem esse evento (OS importada), o início do atendimento, a chegada ou a última
    mudança. Fora de campo é nulo: o CASE só roda a subconsulta nas OS em campo."""
    moved = (
        select(func.max(TicketEvent.created_at))
        .where(
            TicketEvent.ticket_id == Ticket.id,
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            TicketEvent.to_value.in_([s.value for s in FIELD]),
        )
        .correlate(Ticket)
        .scalar_subquery()
    )
    since = func.coalesce(moved, Ticket.work_started_at, Ticket.arrived_at, Ticket.updated_at)
    return case((Ticket.status.in_(FIELD), since))


def in_field_now_clause(now: datetime) -> ColumnElement[bool]:
    """Em campo agora: a caminho ou em atendimento há até 12 h."""
    return and_(Ticket.status.in_(FIELD), field_since() >= now - FIELD_STUCK_AFTER)


def field_stuck_clause(now: datetime) -> ColumnElement[bool]:
    """Parada em campo: a caminho ou em atendimento há mais de 12 h."""
    return field_since() < now - FIELD_STUCK_AFTER


def field_stuck(t: Any, since: datetime | None, now: datetime) -> bool:
    """A mesma regra para uma OS (do ORM ou linha de consulta), com o `field_since` já lido."""
    return t.status in FIELD and since is not None and now - since > FIELD_STUCK_AFTER


async def field_since_of(
    db: AsyncSession, ticket_ids: Collection[uuid.UUID]
) -> dict[uuid.UUID, datetime]:
    """`field_since` das OS em campo entre estas, numa consulta só (as outras ficam de fora)."""
    if not ticket_ids:
        return {}
    rows = await db.execute(
        select(Ticket.id, field_since()).where(Ticket.id.in_(ticket_ids), Ticket.status.in_(FIELD))
    )
    return {ticket_id: since for ticket_id, since in rows.all() if since is not None}

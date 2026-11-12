"""Regras de campo da Maxx Field: dois relógios de 4 horas e a autorização do cliente.

- Chegada: nas capitais o técnico chega em até 4 horas da solicitação (no interior, o prazo
  configurado). Quando a autorização do cliente é exigida, o relógio começa na autorização
  (antes dela a visita nem pode sair).
- Permanência: cada chamado inclui até 4 horas de técnico na loja, contadas da chegada
  (a primeira vez em "Em atendimento").
"""

import unicodedata
from datetime import datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import AuthorizationStatus, TicketStatus
from app.models import Location, SystemSetting, Ticket, User
from app.schemas.field import FieldRules

RULES_KEY = "field.rules"
AT_RISK = timedelta(minutes=60)
S = TicketStatus
FINISHED = (S.RESOLVED, S.CLOSED, S.CANCELLED)

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
    """Início do relógio de chegada: a autorização (quando exigida) ou a abertura da OS."""
    status = ticket.authorization_status
    if status == AuthorizationStatus.AUTHORIZED:
        return ticket.authorized_at or ticket.created_at
    if status == AuthorizationStatus.NOT_REQUIRED or status is None:
        return ticket.created_at
    return None  # pendente ou negada: o relógio não começou


async def recompute_arrival_due(db: AsyncSession, ticket: Ticket, r: FieldRules) -> None:
    """Prazo de chegada a partir do início do relógio e do local (capital ou interior)."""
    if ticket.arrived_at is not None:
        return
    start = clock_start(ticket)
    location = await db.get(Location, ticket.location_id) if ticket.location_id else None
    hours = arrival_hours(
        r, location.city if location else None, location.state if location else None
    )
    ticket.arrival_due_at = start + timedelta(hours=hours) if start and hours else None


def on_arrival(ticket: Ticket, r: FieldRules, now: datetime) -> None:
    """Primeira chegada ao local: começa a contar o tempo de técnico na loja."""
    if ticket.arrived_at is not None:
        return
    ticket.arrived_at = now
    ticket.onsite_due_at = now + timedelta(hours=r.onsite_hours)
    ticket.onsite_warning_at = ticket.onsite_due_at - timedelta(minutes=r.onsite_warning_minutes)


# ------------------------------------------------------------------ situação (para listas e filas)


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

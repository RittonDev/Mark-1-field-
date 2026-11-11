"""Cálculo de SLA (resposta e solução) com pausa nos estados de pendência.

Relógio 24x7 em minutos corridos. Calendário de horário comercial e feriados
fica como evolução (ver docs/STATUS_E_SLA.md).
"""

from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import SlaStatus, TicketPriority, TicketStatus
from app.models.catalog import SlaPolicy

# (resposta, solução) em minutos.
DEFAULT_SLA_MINUTES: dict[TicketPriority, tuple[int, int]] = {
    TicketPriority.CRITICAL: (30, 4 * 60),
    TicketPriority.HIGH: (60, 8 * 60),
    TicketPriority.MEDIUM: (4 * 60, 24 * 60),
    TicketPriority.LOW: (8 * 60, 72 * 60),
}


class SlaTicket(Protocol):
    status: TicketStatus
    created_at: datetime
    response_due_at: datetime | None
    resolution_due_at: datetime | None
    first_response_at: datetime | None
    resolved_at: datetime | None
    sla_paused_at: datetime | None
    sla_paused_seconds: int


def utcnow() -> datetime:
    return datetime.now(UTC)


async def get_policy_minutes(db: AsyncSession, priority: TicketPriority) -> tuple[int, int]:
    policy = await db.scalar(select(SlaPolicy).where(SlaPolicy.priority == priority))
    if policy is None:
        return DEFAULT_SLA_MINUTES[priority]
    return policy.response_minutes, policy.resolution_minutes


def set_due_dates(
    ticket: SlaTicket, *, base: datetime, response_minutes: int, resolution_minutes: int
) -> None:
    """Define prazos a partir da abertura, somando o tempo já pausado."""
    paused = timedelta(seconds=ticket.sla_paused_seconds or 0)
    ticket.response_due_at = base + timedelta(minutes=response_minutes) + paused
    ticket.resolution_due_at = base + timedelta(minutes=resolution_minutes) + paused


def pause(ticket: SlaTicket, now: datetime) -> None:
    if ticket.sla_paused_at is None:
        ticket.sla_paused_at = now


def resume(ticket: SlaTicket, now: datetime) -> None:
    """Retoma o relógio e empurra os prazos ainda abertos pelo tempo pausado."""
    if ticket.sla_paused_at is None:
        return
    delta = now - ticket.sla_paused_at
    ticket.sla_paused_seconds = (ticket.sla_paused_seconds or 0) + int(delta.total_seconds())
    if ticket.first_response_at is None and ticket.response_due_at is not None:
        ticket.response_due_at = ticket.response_due_at + delta
    if ticket.resolved_at is None and ticket.resolution_due_at is not None:
        ticket.resolution_due_at = ticket.resolution_due_at + delta
    ticket.sla_paused_at = None


def _elapsed_ratio(created_at: datetime, due: datetime, paused_s: int, now: datetime) -> float:
    total = (due - created_at).total_seconds() - paused_s
    if total <= 0:
        return 1.0
    elapsed = (now - created_at).total_seconds() - paused_s
    return elapsed / total


def compute_sla_status(ticket: SlaTicket, now: datetime | None = None) -> SlaStatus:
    now = now or utcnow()
    if ticket.status == TicketStatus.CANCELLED:
        return SlaStatus.OK
    if ticket.resolved_at is not None and ticket.status in (
        TicketStatus.RESOLVED,
        TicketStatus.CLOSED,
    ):
        if ticket.resolution_due_at is None or ticket.resolved_at <= ticket.resolution_due_at:
            return SlaStatus.MET
        return SlaStatus.BREACHED

    response_breached = (
        ticket.first_response_at is None
        and ticket.response_due_at is not None
        and (ticket.sla_paused_at or now) > ticket.response_due_at
    )
    resolution_breached = ticket.resolution_due_at is not None and (
        (ticket.sla_paused_at or now) > ticket.resolution_due_at
    )
    if response_breached or resolution_breached:
        return SlaStatus.BREACHED
    if ticket.sla_paused_at is not None:
        return SlaStatus.PAUSED

    paused_s = ticket.sla_paused_seconds or 0
    ratios: list[float] = []
    if ticket.resolution_due_at is not None:
        ratios.append(_elapsed_ratio(ticket.created_at, ticket.resolution_due_at, paused_s, now))
    if ticket.first_response_at is None and ticket.response_due_at is not None:
        ratios.append(_elapsed_ratio(ticket.created_at, ticket.response_due_at, paused_s, now))
    if ratios and max(ratios) >= settings.SLA_AT_RISK_RATIO:
        return SlaStatus.AT_RISK
    return SlaStatus.OK

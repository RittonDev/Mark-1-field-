from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.core.enums import SlaStatus, TicketStatus
from app.services import sla

T0 = datetime(2026, 1, 10, 12, 0, tzinfo=UTC)


@dataclass
class FakeTicket:
    status: TicketStatus = TicketStatus.ASSIGNED
    created_at: datetime = T0
    response_due_at: datetime | None = None
    resolution_due_at: datetime | None = None
    first_response_at: datetime | None = None
    resolved_at: datetime | None = None
    sla_paused_at: datetime | None = None
    sla_paused_seconds: int = 0


def make(response: int = 60, resolution: int = 240) -> FakeTicket:
    t = FakeTicket()
    sla.set_due_dates(t, base=T0, response_minutes=response, resolution_minutes=resolution)
    return t


def test_due_dates_from_creation() -> None:
    t = make()
    assert t.response_due_at == T0 + timedelta(hours=1)
    assert t.resolution_due_at == T0 + timedelta(hours=4)


def test_pause_and_resume_push_due_dates() -> None:
    t = make()
    sla.pause(t, T0 + timedelta(minutes=30))
    sla.resume(t, T0 + timedelta(minutes=90))
    assert t.sla_paused_at is None
    assert t.sla_paused_seconds == 3600
    assert t.response_due_at == T0 + timedelta(hours=2)
    assert t.resolution_due_at == T0 + timedelta(hours=5)


def test_resume_keeps_response_due_when_already_responded() -> None:
    t = make()
    t.first_response_at = T0 + timedelta(minutes=10)
    sla.pause(t, T0 + timedelta(minutes=30))
    sla.resume(t, T0 + timedelta(minutes=90))
    assert t.response_due_at == T0 + timedelta(hours=1)
    assert t.resolution_due_at == T0 + timedelta(hours=5)


def test_status_ok_at_risk_breached() -> None:
    t = make()
    t.first_response_at = T0 + timedelta(minutes=5)
    assert sla.compute_sla_status(t, T0 + timedelta(hours=1)) == SlaStatus.OK
    assert sla.compute_sla_status(t, T0 + timedelta(hours=3, minutes=30)) == SlaStatus.AT_RISK
    assert sla.compute_sla_status(t, T0 + timedelta(hours=5)) == SlaStatus.BREACHED


def test_response_breach_counts() -> None:
    t = make()
    assert sla.compute_sla_status(t, T0 + timedelta(minutes=61)) == SlaStatus.BREACHED


def test_paused_ticket_reports_paused() -> None:
    t = make()
    t.first_response_at = T0
    t.status = TicketStatus.ON_HOLD_VENDOR
    sla.pause(t, T0 + timedelta(minutes=30))
    assert sla.compute_sla_status(t, T0 + timedelta(hours=10)) == SlaStatus.PAUSED


def test_resolved_met_or_breached() -> None:
    t = make()
    t.status = TicketStatus.RESOLVED
    t.resolved_at = T0 + timedelta(hours=2)
    assert sla.compute_sla_status(t, T0 + timedelta(days=3)) == SlaStatus.MET
    t.resolved_at = T0 + timedelta(hours=6)
    assert sla.compute_sla_status(t, T0 + timedelta(days=3)) == SlaStatus.BREACHED

import uuid

from pydantic import BaseModel

from app.core.enums import Responsibility


class AssigneeLoad(BaseModel):
    user_id: uuid.UUID
    name: str
    open: int
    in_progress: int
    breached: int


class DashboardSummary(BaseModel):
    by_status: dict[str, int]
    by_priority: dict[str, int]
    open_total: int
    unassigned: int
    sla_breached: int
    sla_at_risk: int
    created_today: int
    resolved_today: int
    avg_resolution_minutes_30d: float | None
    sla_compliance_30d: float | None  # % de OS resolvidas dentro do prazo nos últimos 30 dias
    by_assignee: list[AssigneeLoad]


class ViolationReasonCount(BaseModel):
    reason_id: uuid.UUID
    name: str
    responsibility: Responsibility
    count: int


class ClockViolations(BaseModel):
    breached: int  # OS do período que furaram este relógio
    justified: int  # dessas, quantas têm motivo informado
    by_reason: list[ViolationReasonCount]


class SlaViolationReport(BaseModel):
    period_days: int
    tickets_total: int
    response: ClockViolations
    resolution: ClockViolations
    by_responsibility: dict[str, int]  # internal / customer / third_party (os dois relógios)
    pending_justification: int  # resolvidas/fechadas com violação sem motivo

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, computed_field, model_validator

from app.core.config import settings
from app.core.enums import (
    AssetType,
    Impact,
    SlaStatus,
    TicketEventType,
    TicketPriority,
    TicketSource,
    TicketStatus,
    TicketType,
    Urgency,
)
from app.schemas.common import ORMModel, Ref
from app.schemas.user import UserRef
from app.db.base import utcnow
from app.services.durations import actual_seconds
from app.services.sla import compute_sla_status


def format_ticket_code(number: int) -> str:
    return f"{settings.TICKET_PREFIX}-{number:06d}"


class ServiceTypeRef(ORMModel):
    id: uuid.UUID
    name: str
    estimated_minutes: int


class CategoryRef(ORMModel):
    id: uuid.UUID
    name: str
    full_name: str


class LocationRef(ORMModel):
    id: uuid.UUID
    name: str
    code: str | None
    document: str | None
    address_line: str | None
    city: str | None
    state: str | None
    latitude: float | None
    longitude: float | None
    contact_name: str | None
    contact_phone: str | None


class AssetRef(ORMModel):
    id: uuid.UUID
    name: str
    asset_type: AssetType
    brand: str | None
    model: str | None
    serial_number: str | None
    asset_tag: str | None
    ip_address: str | None


class TicketListItem(ORMModel):
    id: uuid.UUID
    number: int
    title: str
    status: TicketStatus
    priority: TicketPriority
    type: TicketType
    source: TicketSource
    category: CategoryRef | None
    customer: Ref | None
    location: LocationRef | None
    assignee: UserRef | None
    team: Ref | None
    requester_name: str | None
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    response_due_at: datetime | None
    resolution_due_at: datetime | None
    first_response_at: datetime | None
    resolved_at: datetime | None
    sla_paused_at: datetime | None
    sla_paused_seconds: int
    created_at: datetime
    updated_at: datetime
    version: int

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return format_ticket_code(self.number)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def sla_status(self) -> SlaStatus:
        return compute_sla_status(self)  # type: ignore[arg-type]


class TicketDetail(TicketListItem):
    description: str
    impact: Impact
    urgency: Urgency
    asset: AssetRef | None
    requester: UserRef | None
    requester_contact: str | None
    service_address: str | None
    created_by: UserRef | None
    closed_at: datetime | None
    cancelled_at: datetime | None
    reopen_count: int
    resolution_notes: str | None
    service_type: ServiceTypeRef | None
    # Estimada: copiada do tipo na abertura (ou informada). Real: tempo em "Em atendimento".
    estimated_minutes: int | None
    work_seconds: int
    work_started_at: datetime | None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def actual_minutes(self) -> int:
        """Duração real em minutos (inclui o atendimento em andamento)."""
        return actual_seconds(self.work_seconds, self.work_started_at, utcnow()) // 60

    # Preenchido pela API conforme o papel do usuário logado.
    allowed_transitions: list[TicketStatus] = []
    can_edit: bool = False
    can_assign: bool = False


class TicketCreate(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=20000)
    type: TicketType = TicketType.INCIDENT
    impact: Impact = Impact.MEDIUM
    urgency: Urgency = Urgency.MEDIUM
    # Se omitida, calculada pela matriz impacto x urgência.
    priority: TicketPriority | None = None
    source: TicketSource = TicketSource.WEB
    category_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    requester_id: uuid.UUID | None = None
    requester_name: str | None = Field(default=None, max_length=160)
    requester_contact: str | None = Field(default=None, max_length=160)
    service_address: str | None = Field(default=None, max_length=255)
    service_type_id: uuid.UUID | None = None
    estimated_minutes: int | None = Field(default=None, gt=0, le=60 * 24 * 7)
    team_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None


class TicketUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=3, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    type: TicketType | None = None
    impact: Impact | None = None
    urgency: Urgency | None = None
    priority: TicketPriority | None = None
    category_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    requester_name: str | None = Field(default=None, max_length=160)
    requester_contact: str | None = Field(default=None, max_length=160)
    service_address: str | None = Field(default=None, max_length=255)
    service_type_id: uuid.UUID | None = None
    estimated_minutes: int | None = Field(default=None, gt=0, le=60 * 24 * 7)
    team_id: uuid.UUID | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    expected_version: int | None = None


class TicketAssign(BaseModel):
    """`assignee_id = null` remove o analista (a OS volta para a fila)."""

    assignee_id: uuid.UUID | None
    team_id: uuid.UUID | None = None
    note: str | None = Field(default=None, max_length=2000)
    expected_version: int | None = None


class TicketTransition(BaseModel):
    to_status: TicketStatus
    note: str | None = Field(default=None, max_length=5000)
    resolution_notes: str | None = Field(default=None, max_length=20000)
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    # Geolocalização do técnico no momento da mudança (check-in de campo).
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    expected_version: int | None = None


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=10000)
    is_internal: bool = False


class CommentOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    author: UserRef | None
    body: str
    is_internal: bool
    created_at: datetime


class EventOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    actor: UserRef | None
    event_type: TicketEventType
    from_value: str | None
    to_value: str | None
    note: str | None
    data: dict[str, Any] | None
    created_at: datetime


class WorklogCreate(BaseModel):
    description: str = Field(min_length=1, max_length=5000)
    started_at: datetime
    ended_at: datetime | None = None
    minutes: int | None = Field(default=None, gt=0, le=24 * 60)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)

    @model_validator(mode="after")
    def _duration(self) -> "WorklogCreate":
        if self.ended_at is None and self.minutes is None:
            raise ValueError("Informe ended_at ou minutes")
        if self.ended_at is not None and self.ended_at <= self.started_at:
            raise ValueError("ended_at deve ser posterior a started_at")
        return self


class WorklogOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    user: UserRef | None
    description: str
    started_at: datetime
    ended_at: datetime | None
    minutes: int
    latitude: float | None
    longitude: float | None
    created_at: datetime


class AttachmentOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    kind: str
    uploaded_by: UserRef | None
    created_at: datetime
    download_url: str | None = None


class TicketFilters(BaseModel):
    status: list[TicketStatus] | None = None
    priority: list[TicketPriority] | None = None
    type: TicketType | None = None
    assignee_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    service_type_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    q: str | None = None
    mine: bool = False
    unassigned: bool = False
    open_only: bool = False
    sla_breached: bool = False

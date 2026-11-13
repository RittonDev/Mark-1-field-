"""Portal do cliente: o que o usuário do cliente vê e envia.

Lista fechada de campos (nada de etiquetas internas, analista, prazos de SLA, custos ou valores do
técnico): o cliente acompanha a solicitação, a visita e o relatório final.
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import TicketStatus, Urgency
from app.schemas.common import Ref


class PortalLocation(BaseModel):
    id: uuid.UUID
    code: str | None
    name: str
    address: str | None
    city: str | None
    state: str | None


class PortalMe(BaseModel):
    customer: Ref
    locations: int


class PortalRequestItem(BaseModel):
    id: uuid.UUID
    code: str
    title: str
    status: TicketStatus
    location: PortalLocation | None
    requester_name: str | None
    created_at: datetime
    updated_at: datetime
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    technician: str | None
    arrived_at: datetime | None
    resolved_at: datetime | None
    cancelled_at: datetime | None


class PortalTimelineEntry(BaseModel):
    status: TicketStatus | Literal["created"]
    at: datetime


class PortalRequestDetail(PortalRequestItem):
    description: str
    client_reference: str | None
    contact: str | None
    resolution_notes: str | None
    report_url: str | None
    can_cancel: bool
    timeline: list[PortalTimelineEntry]


class PortalRequestCreate(BaseModel):
    location_id: uuid.UUID
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=5000)
    urgency: Urgency = Urgency.MEDIUM
    # Quem atende na loja (nome e telefone), para a central combinar a visita.
    contact: str | None = Field(default=None, max_length=160)
    # Nº do chamado no sistema do cliente, quando houver.
    client_reference: str | None = Field(default=None, max_length=80)


class PortalCancel(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class PortalInboxCount(BaseModel):
    pending: int

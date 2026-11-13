import uuid
from dataclasses import dataclass, field
from datetime import datetime

from pydantic import BaseModel

from app.core.enums import TicketPriority, TicketStatus
from app.schemas.common import Ref


class ConflictItem(BaseModel):
    # Quem está ocupado (o responsável ou outro técnico da visita).
    who: str | None = None
    id: uuid.UUID
    code: str
    title: str
    customer: str | None
    location: str | None
    start: datetime
    end: datetime


class CalendarLocation(BaseModel):
    id: uuid.UUID
    name: str
    city: str | None


class CalendarEvent(BaseModel):
    id: uuid.UUID
    code: str
    title: str
    status: TicketStatus
    priority: TicketPriority
    start: datetime
    end: datetime
    # Sem fim informado: o fim vem da estimativa do tipo de serviço (ou 1 hora).
    end_is_estimated: bool
    assignee: Ref | None
    # Outros técnicos da visita: a OS aparece também na agenda deles.
    helpers: list[Ref] = []
    team: Ref | None
    customer: Ref | None
    location: CalendarLocation | None
    service_type: str | None
    # OS com horário sobreposto de alguém da visita (o responsável ou outro técnico), no período
    # consultado.
    conflict_with: list[uuid.UUID]


@dataclass
class CalendarFilters:
    assignee_ids: list[uuid.UUID] = field(default_factory=list)
    unassigned: bool = False
    team_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    city: str | None = None
    statuses: list[TicketStatus] = field(default_factory=list)

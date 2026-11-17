"""Tela inicial da gestão (pontos de atenção, indicadores, sugestões) e a busca inteligente."""

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, SerializerFunctionWrapHandler, model_serializer

from app.core.enums import TicketPriority, TicketStatus
from app.schemas.common import TagOut


class ListFilters(BaseModel):
    """Recorte da lista de OS (os mesmos parâmetros de GET /tickets). A web transforma em URL da
    lista de chamados. Só vão na resposta as chaves usadas (as ausentes ficam de fora).

    `technician_id` é o "técnico que atuou": responsável atual, outro técnico da visita ou quem já
    foi responsável (histórico de atribuições)."""

    status: list[TicketStatus] | None = None
    priority: list[TicketPriority] | None = None
    number: int | None = None
    customer_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    technician_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    tag: list[str] | None = None
    created_from: date | None = None
    created_to: date | None = None
    scheduled_from: date | None = None
    scheduled_to: date | None = None
    q: str | None = None
    open_only: bool | None = None
    sla_breached: bool | None = None
    unassigned: bool | None = None
    no_owner: bool | None = None
    violation_pending: bool | None = None

    @model_serializer(mode="wrap")
    def _only_present(self, handler: SerializerFunctionWrapHandler):
        data = handler(self)
        return {key: value for key, value in data.items() if value is not None}


# --------------------------------------------------------------------------- tela inicial

Severity = Literal["critical", "high", "medium", "low"]


class HomeKpis(BaseModel):
    open: int
    scheduled_today: int
    in_field_now: int
    resolved_today: int
    late: int  # em aberto com SLA estourado (a aba "SLA violado" da lista)
    unassigned: int  # em aberto sem técnico


class AttentionItem(BaseModel):
    ticket_id: uuid.UUID | None = None
    number: int | None = None
    title: str
    customer: str | None = None
    location: str | None = None
    technician: str | None = None
    when: datetime | None = None
    reason: str


class AttentionGroup(BaseModel):
    key: str
    title: str
    severity: Severity
    count: int
    hint: str
    filters: ListFilters | None = None
    link: str | None = None
    items: list[AttentionItem] = Field(default_factory=list)


class Suggestion(BaseModel):
    key: str
    title: str
    detail: str
    link: str | None = None
    filters: ListFilters | None = None


class WeekDay(BaseModel):
    day: date
    created: int
    resolved: int


class HomeOverview(BaseModel):
    generated_at: datetime
    kpis: HomeKpis
    attention: list[AttentionGroup]
    suggestions: list[Suggestion]
    week: list[WeekDay]


# --------------------------------------------------------------------------- busca inteligente

ChipKind = Literal[
    "number",
    "status",
    "period",
    "customer",
    "location",
    "technician",
    "tag",
    "city",
    "priority",
    "text",
]


class SearchChip(BaseModel):
    """Como a busca entendeu um pedaço da frase (ex.: "Agendadas: amanhã")."""

    kind: ChipKind
    label: str


class SearchTicket(BaseModel):
    id: uuid.UUID
    number: int
    title: str
    status: TicketStatus
    customer: str | None = None
    location: str | None = None
    city: str | None = None
    technician: str | None = None
    scheduled_start: datetime | None = None
    created_at: datetime
    tags: list[TagOut] = Field(default_factory=list)


class SearchCustomer(BaseModel):
    id: uuid.UUID
    name: str
    document: str | None = None
    open_count: int = 0


class SearchLocation(BaseModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    city: str | None = None
    customer: str | None = None


class SearchTechnician(BaseModel):
    id: uuid.UUID
    name: str
    city: str | None = None
    active: bool


class SmartSearchResult(BaseModel):
    query: str
    chips: list[SearchChip] = Field(default_factory=list)
    filters: ListFilters | None = None
    total: int = 0
    tickets: list[SearchTicket] = Field(default_factory=list)
    customers: list[SearchCustomer] = Field(default_factory=list)
    locations: list[SearchLocation] = Field(default_factory=list)
    technicians: list[SearchTechnician] = Field(default_factory=list)


def tags_out(raw: Any) -> list[TagOut]:
    """Etiquetas da OS (JSONB [{name, color}]) sem as vazias ou malformadas."""
    out: list[TagOut] = []
    for tag in raw or []:
        if isinstance(tag, dict) and str(tag.get("name") or "").strip():
            color = tag.get("color")
            out.append(TagOut(name=str(tag["name"]), color=color if isinstance(color, str) else None))
    return out

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field, model_validator

from app.core.config import settings
from app.core.enums import (
    AssetType,
    Impact,
    Responsibility,
    SlaStatus,
    TicketEventType,
    TicketPriority,
    TicketSource,
    TicketStatus,
    TicketType,
    Urgency,
)
from app.db.base import utcnow
from app.schemas.common import ORMModel, Ref, TagOut
from app.schemas.expense import ExpenseOut
from app.schemas.forms import TicketFormOut
from app.schemas.part_request import PartRequestOut
from app.schemas.payout import MyPayout, PayoutOut
from app.schemas.user import UserRef
from app.services import field as field_rules
from app.services.durations import actual_seconds
from app.services.sla import compute_sla_status
from app.services.sla import resolution_breached as sla_resolution_breached
from app.services.sla import response_breached as sla_response_breached


def format_ticket_code(number: int) -> str:
    return f"{settings.TICKET_PREFIX}-{number:06d}"


class ViolationReasonRef(ORMModel):
    id: uuid.UUID
    name: str
    responsibility: Responsibility


class ServiceTypeRef(ORMModel):
    id: uuid.UUID
    name: str
    estimated_minutes: int


class CategoryRef(ORMModel):
    id: uuid.UUID
    name: str
    full_name: str


class ProjectRef(ORMModel):
    id: uuid.UUID
    number: int
    name: str

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return f"PRJ-{self.number:04d}"


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


ArrivalStatus = Literal["met", "late", "at_risk", "pending"]
OnsiteStatus = Literal["ok", "warning", "over"]


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
    # Analista responsável (a fila dele), separado de quem executa (assignee).
    owner: UserRef | None = None
    # Outros técnicos da visita, além do responsável.
    helpers: list[UserRef] = []
    # Nº do chamado no sistema do cliente.
    client_reference: str | None = None
    team: Ref | None
    project: ProjectRef | None = None
    requester_name: str | None
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    response_due_at: datetime | None
    resolution_due_at: datetime | None
    first_response_at: datetime | None
    resolved_at: datetime | None
    sla_paused_at: datetime | None
    # Visitas improdutivas: a OS voltou para reagendar (contador para relatórios e a lista).
    unproductive_count: int = 0
    last_unproductive_at: datetime | None = None
    sla_paused_seconds: int
    created_at: datetime
    updated_at: datetime
    version: int
    # Regras de campo: prazo de chegada (4h nas capitais) e tempo de técnico na loja (4h).
    arrival_due_at: datetime | None = None
    arrived_at: datetime | None = None
    onsite_due_at: datetime | None = None
    onsite_warning_at: datetime | None = Field(default=None, exclude=True)
    # Outras OS no mesmo local nos últimos 30 dias (preenchido nas listagens e na fila).
    recurrence_30d: int = 0
    # Etiquetas (ex.: "Avulso", "Faturamento Matriz").
    tags: list[TagOut] = []

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return format_ticket_code(self.number)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def sla_status(self) -> SlaStatus:
        return compute_sla_status(self)  # type: ignore[arg-type]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def arrival_status(self) -> ArrivalStatus | None:
        return field_rules.arrival_status(self, utcnow())  # type: ignore[return-value]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def onsite_status(self) -> OnsiteStatus | None:
        return field_rules.onsite_status(self, utcnow())  # type: ignore[return-value]


class RecurrenceItem(ORMModel):
    id: uuid.UUID
    number: int
    title: str
    status: TicketStatus
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return format_ticket_code(self.number)


class TicketRecurrence(BaseModel):
    """Reincidência: outras OS no mesmo local nos últimos 30 dias."""

    count_30d: int
    previous: list[RecurrenceItem]


class ReportLinkOut(BaseModel):
    """Link público do relatório da OS concluída (para o cliente)."""

    token: str
    path: str
    url: str
    created_at: datetime | None
    views: int
    last_viewed_at: datetime | None


class TicketDetail(TicketListItem):
    description: str
    impact: Impact
    urgency: Urgency
    asset: AssetRef | None
    requester: UserRef | None
    requester_contact: str | None
    service_address: str | None
    # Recado para o técnico: com quem falar, acesso, o que levar.
    visit_note: str | None = None
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

    # Motivo de violação, um por relógio de SLA.
    response_violation_reason: ViolationReasonRef | None
    resolution_violation_reason: ViolationReasonRef | None
    violation_note: str | None

    # Formulários anexados pela gestão e assinatura do responsável no local.
    forms: list[TicketFormOut] = []
    signature_required: bool = False
    signer_name: str | None = None
    signer_role: str | None = None
    signed_at: datetime | None = None
    signature_attachment_id: uuid.UUID | None = None
    # Custos extras: a gestão lança; o técnico só vê; o solicitante não recebe.
    expenses: list[ExpenseOut] = []
    # Pedidos de peça do técnico (peça só entra com orçamento aprovado).
    part_requests: list[PartRequestOut] = []
    # Valor de cada técnico na OS: a gestão vê todos; o técnico, só o dele (my_payout).
    payouts: list[PayoutOut] = []
    my_payout: MyPayout | None = None
    # Só na tela da OS: outras OS no mesmo local nos últimos 30 dias.
    recurrence: TicketRecurrence | None = None
    # OS migrada (Field Control): valores, itens, solicitação original e arquivos. Só a equipe.
    legacy: dict[str, Any] | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def response_breached(self) -> bool:
        return sla_response_breached(self)  # type: ignore[arg-type]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def resolution_breached(self) -> bool:
        return sla_resolution_breached(self)  # type: ignore[arg-type]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def violation_reason_pending(self) -> bool:
        """Resolvida com prazo violado e sem motivo informado: falta justificar."""
        if self.status not in (TicketStatus.RESOLVED, TicketStatus.CLOSED):
            return False
        return (self.response_breached and self.response_violation_reason is None) or (
            self.resolution_breached and self.resolution_violation_reason is None
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def actual_minutes(self) -> int:
        """Duração real em minutos (inclui o atendimento em andamento)."""
        return actual_seconds(self.work_seconds, self.work_started_at, utcnow()) // 60

    # Preenchido pela API conforme o papel do usuário logado.
    allowed_transitions: list[TicketStatus] = []
    can_edit: bool = False
    can_assign: bool = False
    # Só para a gestão: link do relatório para o cliente (existe com a OS concluída).
    report_link: ReportLinkOut | None = None


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
    # Nº do chamado do cliente e o recado da visita para o técnico.
    client_reference: str | None = Field(default=None, max_length=80)
    visit_note: str | None = Field(default=None, max_length=5000)
    service_type_id: uuid.UUID | None = None
    estimated_minutes: int | None = Field(default=None, gt=0, le=60 * 24 * 7)
    team_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    # Outros técnicos da visita (só a gestão escolhe).
    helper_ids: list[uuid.UUID] = Field(default_factory=list, max_length=6)
    # Analista responsável (só a gestão escolhe). Sem informar: quem abre assume (vai para a
    # fila dele). null explícito: fica sem analista, para alguém assumir depois.
    owner_id: uuid.UUID | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    # Agendar mesmo com o técnico ocupado no horário (a API recusa com 409 sem isso).
    allow_conflict: bool = False


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
    client_reference: str | None = Field(default=None, max_length=80)
    visit_note: str | None = Field(default=None, max_length=5000)
    service_type_id: uuid.UUID | None = None
    estimated_minutes: int | None = Field(default=None, gt=0, le=60 * 24 * 7)
    team_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    # Só a gestão: troca os outros técnicos da visita (lista completa; [] tira todos).
    helper_ids: list[uuid.UUID] | None = Field(default=None, max_length=6)
    # Só a gestão: transfere a OS para a fila de outro analista (null tira da fila).
    owner_id: uuid.UUID | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    # Só a gestão: exigir (ou dispensar) a assinatura do responsável no local.
    signature_required: bool | None = None
    # Só a gestão: o que foi feito (descrição da conclusão) e as etiquetas, a qualquer momento.
    resolution_notes: str | None = Field(default=None, max_length=20000)
    tags: list[TagOut] | None = Field(default=None, max_length=20)
    expected_version: int | None = None
    allow_conflict: bool = False


class TicketAssign(BaseModel):
    """`assignee_id = null` remove o analista (a OS volta para a fila)."""

    assignee_id: uuid.UUID | None
    team_id: uuid.UUID | None = None
    note: str | None = Field(default=None, max_length=2000)
    expected_version: int | None = None
    allow_conflict: bool = False


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
    # Ao resolver uma OS com prazo violado, o motivo de cada relógio (opcional para o técnico).
    response_violation_reason_id: uuid.UUID | None = None
    resolution_violation_reason_id: uuid.UUID | None = None
    violation_note: str | None = Field(default=None, max_length=2000)
    allow_conflict: bool = False


class TicketTimesIn(BaseModel):
    """Correção dos horários reais pela central (o técnico nunca mexe no horário).

    Só os campos informados mudam. `work_minutes` é o tempo de atendimento; sem ele, ao mexer no
    início ou no término, vale o intervalo entre os dois. O motivo fica no histórico.
    """

    en_route_at: datetime | None = None  # saída para o local
    arrived_at: datetime | None = None  # início do atendimento (chegada)
    resolved_at: datetime | None = None  # término (conclusão)
    work_minutes: int | None = Field(default=None, ge=0, le=60 * 24 * 14)
    reason: str = Field(min_length=3, max_length=500)
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
    description: str | None = None
    # Arquivo migrado ainda no armazenamento de origem (Field Control): sem tamanho conhecido.
    external: bool = False
    form_id: uuid.UUID | None = None
    field_id: str | None = None
    uploaded_by: UserRef | None
    created_at: datetime
    download_url: str | None = None


class AttachmentUpdate(BaseModel):
    """Legenda do anexo (vazio apaga)."""

    description: str | None = Field(default=None, max_length=500)


class TicketViolationUpdate(BaseModel):
    """Justificar (ou corrigir) a violação de SLA, inclusive com a OS já fechada."""

    response_violation_reason_id: uuid.UUID | None = None
    resolution_violation_reason_id: uuid.UUID | None = None
    violation_note: str | None = Field(default=None, max_length=2000)


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
    project_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    no_owner: bool = False
    q: str | None = None
    mine: bool = False
    unassigned: bool = False
    open_only: bool = False
    sla_breached: bool = False
    violation_pending: bool = False


class TicketUnproductive(BaseModel):
    """Visita improdutiva: o técnico foi e não conseguiu atender. A OS volta para reagendar."""

    reason_id: uuid.UUID
    note: str | None = Field(default=None, max_length=2000)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    expected_version: int | None = None

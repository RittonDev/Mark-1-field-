import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import (
    AuthorizationStatus,
    Impact,
    TicketEventType,
    TicketPriority,
    TicketSource,
    TicketStatus,
    TicketType,
    Urgency,
)
from app.db.base import Base, Timestamps, UUIDPrimaryKey, created_at_column
from app.models._types import str_enum
from app.models.asset import Asset
from app.models.catalog import Category, ServiceType, ViolationReason
from app.models.customer import Customer, Location
from app.models.user import Team, User


class Ticket(UUIDPrimaryKey, Timestamps, Base):
    """Ordem de serviço (OS) / chamado."""

    __tablename__ = "tickets"
    __table_args__ = (
        Index("ix_tickets_status_priority", "status", "priority"),
        Index("ix_tickets_updated_at", "updated_at"),
    )

    # Número sequencial legível (exibido como OS-000123). Identity do PostgreSQL.
    number: Mapped[int] = mapped_column(Integer, Identity(start=1), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")

    type: Mapped[TicketType] = mapped_column(str_enum(TicketType), default=TicketType.INCIDENT)
    status: Mapped[TicketStatus] = mapped_column(
        str_enum(TicketStatus), default=TicketStatus.NEW, index=True
    )
    impact: Mapped[Impact] = mapped_column(str_enum(Impact), default=Impact.MEDIUM)
    urgency: Mapped[Urgency] = mapped_column(str_enum(Urgency), default=Urgency.MEDIUM)
    priority: Mapped[TicketPriority] = mapped_column(
        str_enum(TicketPriority), default=TicketPriority.MEDIUM, index=True
    )
    source: Mapped[TicketSource] = mapped_column(str_enum(TicketSource), default=TicketSource.WEB)

    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), index=True
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), index=True
    )
    # Endereço do atendimento quando diferente do cadastrado no local (como no Field Control).
    service_address: Mapped[str | None] = mapped_column(String(255))
    asset_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("assets.id", ondelete="SET NULL"), index=True
    )

    requester_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    requester_name: Mapped[str | None] = mapped_column(String(160))
    requester_contact: Mapped[str | None] = mapped_column(String(160))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    # Quem executa (técnico em campo ou analista no remoto) e grupo técnico.
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # Analista responsável: acompanha a OS até o fim (a "fila" dele), mesmo com técnico em campo.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("teams.id", ondelete="SET NULL"), index=True
    )
    # OS de projeto: valores e equipe seguem o projeto.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )

    # Agenda da visita.
    scheduled_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scheduled_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # SLA.
    response_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    first_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sla_paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sla_paused_seconds: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reopen_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    resolution_notes: Mapped[str | None] = mapped_column(Text)

    # Tipo de serviço e duração: a estimativa é copiada do tipo na abertura (a OS guarda a
    # estimativa com que foi agendada); a real é o tempo somado em "Em atendimento".
    service_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("service_types.id", ondelete="SET NULL"), index=True
    )
    estimated_minutes: Mapped[int | None] = mapped_column(Integer)
    work_seconds: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    work_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Motivo de violação de SLA, um por relógio (como no Field Control), mais uma observação.
    response_violation_reason_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("violation_reasons.id", ondelete="SET NULL")
    )
    resolution_violation_reason_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("violation_reasons.id", ondelete="SET NULL")
    )
    violation_note: Mapped[str | None] = mapped_column(Text)

    # Visitas improdutivas (foi ao local e não atendeu): a OS volta para reagendar.
    unproductive_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_unproductive_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Assinatura do responsável no local, coletada pelo técnico ao finalizar. Fica exigida
    # quando a gestão anexa um formulário obrigatório que pede assinatura.
    signature_required: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    signer_name: Mapped[str | None] = mapped_column(String(160))
    signer_role: Mapped[str | None] = mapped_column(String(120))
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Anexo (kind="signature") com a imagem; sem FK para não criar ciclo tickets <-> anexos.
    signature_attachment_id: Mapped[uuid.UUID | None] = mapped_column()

    # Relatório para o cliente (link público da OS concluída). Só o identificador fica no banco;
    # o token do link leva também uma assinatura HMAC (ver services/client_report.py).
    report_link_id: Mapped[str | None] = mapped_column(String(24), unique=True)
    report_link_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    report_views: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    report_last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Regras de campo (ver services/field.py): prazo de chegada (capital x interior) e tempo de
    # técnico na loja, contado da primeira chegada ("Em atendimento").
    arrival_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    onsite_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    onsite_warning_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Autorização do cliente para a visita (cada chamado é cobrado).
    authorization_status: Mapped[AuthorizationStatus] = mapped_column(
        str_enum(AuthorizationStatus),
        default=AuthorizationStatus.NOT_REQUIRED,
        server_default=AuthorizationStatus.NOT_REQUIRED.value,
        index=True,
    )
    authorized_by_name: Mapped[str | None] = mapped_column(String(160))
    authorization_channel: Mapped[str | None] = mapped_column(String(20))
    authorization_ref: Mapped[str | None] = mapped_column(String(80))
    authorized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    authorized_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    # Etiquetas (ex.: "Avulso", "Faturamento Matriz", "Pendente envio PGTO"): [{name, color}].
    tags: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    # OS migrada de outro sistema (Field Control): valores, itens, solicitação original, arquivos
    # e o número antigo. Só a equipe vê (TicketDetail.legacy).
    legacy: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    # Concorrência otimista) (web e mobile editando a mesma OS).
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    category: Mapped[Category | None] = relationship(lazy="selectin")
    customer: Mapped[Customer | None] = relationship(lazy="selectin")
    location: Mapped[Location | None] = relationship(lazy="selectin")
    asset: Mapped[Asset | None] = relationship(lazy="selectin")
    requester: Mapped[User | None] = relationship(foreign_keys=[requester_id], lazy="selectin")
    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_id], lazy="selectin")
    owner: Mapped[User | None] = relationship(foreign_keys=[owner_id], lazy="selectin")
    authorized_by: Mapped[User | None] = relationship(
        foreign_keys=[authorized_by_id], lazy="selectin"
    )
    team: Mapped[Team | None] = relationship(lazy="selectin")
    project: Mapped["Project | None"] = relationship(lazy="selectin")  # noqa: F821
    service_type: Mapped[ServiceType | None] = relationship(lazy="selectin")
    response_violation_reason: Mapped[ViolationReason | None] = relationship(
        foreign_keys=[response_violation_reason_id], lazy="selectin"
    )
    resolution_violation_reason: Mapped[ViolationReason | None] = relationship(
        foreign_keys=[resolution_violation_reason_id], lazy="selectin"
    )

    forms: Mapped[list["TicketForm"]] = relationship(  # noqa: F821
        lazy="selectin", order_by="TicketForm.created_at", viewonly=True
    )
    expenses: Mapped[list["TicketExpense"]] = relationship(  # noqa: F821
        lazy="selectin", order_by="TicketExpense.created_at", viewonly=True
    )
    part_requests: Mapped[list["TicketPartRequest"]] = relationship(  # noqa: F821
        lazy="selectin", order_by="TicketPartRequest.created_at", viewonly=True
    )

    __mapper_args__ = {"version_id_col": version, "eager_defaults": True}


class TicketComment(UUIDPrimaryKey, Base):
    """Acompanhamento (público para o solicitante ou nota interna da equipe)."""

    __tablename__ = "ticket_comments"

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    body: Mapped[str] = mapped_column(Text)
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = created_at_column()

    author: Mapped[User | None] = relationship(lazy="selectin")


class TicketEvent(UUIDPrimaryKey, Base):
    """Histórico / trilha de auditoria imutável da OS."""

    __tablename__ = "ticket_events"

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    event_type: Mapped[TicketEventType] = mapped_column(str_enum(TicketEventType), index=True)
    from_value: Mapped[str | None] = mapped_column(String(64))
    to_value: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(Text)
    data: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created_at_column()

    actor: Mapped[User | None] = relationship(lazy="selectin")


class TicketWorklog(UUIDPrimaryKey, Base):
    """Apontamento de horas / tarefa executada pelo técnico."""

    __tablename__ = "ticket_worklogs"

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    description: Mapped[str] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    minutes: Mapped[int] = mapped_column(Integer)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = created_at_column()

    user: Mapped[User | None] = relationship(lazy="selectin")


class TicketAttachment(UUIDPrimaryKey, Base):
    """Anexo: foto de evidência, documento, assinatura do cliente."""

    __tablename__ = "ticket_attachments"

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20), default="file")  # file | photo | signature
    # Arquivo no nosso armazenamento; vazio quando o arquivo ainda está em outro sistema.
    storage_key: Mapped[str | None] = mapped_column(String(500))
    # Arquivo migrado que continua no armazenamento de origem (ex.: S3 do Field Control).
    external_url: Mapped[str | None] = mapped_column(String(1000))
    # Foto de um campo de formulário (ex.: "Foto do rack antes").
    form_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ticket_forms.id", ondelete="CASCADE"), index=True
    )
    field_id: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = created_at_column()

    uploaded_by: Mapped[User | None] = relationship(lazy="selectin")

"""Formulários (checklists) que a gestão anexa à OS e o técnico preenche no app.

O modelo (FormTemplate) é montado pelos analistas. Ao anexar na OS, os campos são copiados
(TicketForm.fields): mudar o modelo depois não altera as OS em andamento. As fotos ficam nos
anexos da OS, ligadas ao formulário e ao campo (TicketAttachment.form_id / field_id).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import FormStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.user import User


class FormTemplate(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "form_templates"

    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text)
    # [{id, type, label, help, required, options, min_photos, max_photos}]
    fields: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    # Tipos de serviço em que o formulário é sugerido (a gestão decide se anexa).
    service_type_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    # Ao anexar como obrigatório, a OS passa a exigir a assinatura do responsável no local.
    requires_signature: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class TicketForm(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "ticket_forms"

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("form_templates.id", ondelete="SET NULL")
    )
    template_version: Mapped[int] = mapped_column(Integer, default=1)
    name: Mapped[str] = mapped_column(String(160))
    fields: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[FormStatus] = mapped_column(str_enum(FormStatus), default=FormStatus.PENDING)
    answers: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    completed_by: Mapped[User | None] = relationship(
        foreign_keys=[completed_by_id], lazy="selectin"
    )

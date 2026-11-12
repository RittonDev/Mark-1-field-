"""Custos extras da OS (material comprado, km rodado, pedágio...) para reembolsar o técnico.

Só a gestão (analistas e gestores) lança e altera; o técnico vê os da OS dele, sem editar.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import ExpenseKind, ExpenseStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey, utcnow
from app.models._types import str_enum
from app.models.user import User


class TicketExpense(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "ticket_expenses"

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[ExpenseKind] = mapped_column(str_enum(ExpenseKind))
    description: Mapped[str] = mapped_column(String(200))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    unit_value: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    # A quem reembolsar (padrão: o técnico responsável pela OS).
    technician_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[ExpenseStatus] = mapped_column(
        str_enum(ExpenseStatus), default=ExpenseStatus.PENDING, index=True
    )
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Comprovante (anexo da OS); sem FK, como a assinatura.
    receipt_attachment_id: Mapped[uuid.UUID | None] = mapped_column()
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    technician: Mapped[User | None] = relationship(foreign_keys=[technician_id], lazy="selectin")
    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")


class SystemSetting(Base):
    """Configurações da operação editáveis na tela (ex.: valor do km)."""

    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

"""Quanto cada técnico recebe por uma OS.

Os técnicos são parceiros sem vínculo: pegam a demanda e recebem por chamado. A central define o
valor ao colocar o técnico na OS (o padrão vem do tipo de serviço) e fecha os pagamentos na web;
o técnico vê os próprios valores no app ("Meus ganhos"). Reembolsos (km, material) continuam nos
custos extras.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import PayoutStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.user import User


class TicketPayout(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "ticket_payouts"
    __table_args__ = (UniqueConstraint("ticket_id", "technician_id", name="uq_ticket_payouts_ticket_tech"),)

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    technician_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    status: Mapped[PayoutStatus] = mapped_column(
        str_enum(PayoutStatus), default=PayoutStatus.PENDING, server_default=PayoutStatus.PENDING.value
    )
    note: Mapped[str | None] = mapped_column(Text)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    technician: Mapped[User] = relationship(foreign_keys=[technician_id], lazy="selectin")

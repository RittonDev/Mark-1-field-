"""Pedido de peça feito pelo técnico em campo.

A Maxx Field só troca peça com orçamento aprovado e assinado pelo cliente: o técnico pede
(descrição, quantidade, foto), a gestão monta o orçamento a partir do pedido e, quando o
cliente aprova pelo link, o pedido fica aprovado e o técnico é avisado.
"""

import uuid
from decimal import Decimal

from sqlalchemy import ForeignKey, Index, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import PartRequestStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.quote import Quote
from app.models.user import User


class TicketPartRequest(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "ticket_part_requests"
    __table_args__ = (Index("ix_part_requests_ticket_client", "ticket_id", "client_id"),)

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    requested_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    description: Mapped[str] = mapped_column(String(300))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    unit: Mapped[str] = mapped_column(String(20), default="un")
    note: Mapped[str | None] = mapped_column(Text)
    # Fotos já enviadas como anexo da OS (ids de ticket_attachments).
    attachment_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    status: Mapped[PartRequestStatus] = mapped_column(
        str_enum(PartRequestStatus), default=PartRequestStatus.OPEN, index=True
    )
    quote_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("quotes.id", ondelete="SET NULL"), index=True
    )
    response_note: Mapped[str | None] = mapped_column(Text)
    # Id gerado no app (pedido feito offline): reenviar não duplica.
    client_id: Mapped[str | None] = mapped_column(String(64))

    requested_by: Mapped[User | None] = relationship(lazy="selectin")
    quote: Mapped[Quote | None] = relationship(lazy="selectin")

    @property
    def quote_code(self) -> str | None:
        return f"ORC-{self.quote.number:06d}" if self.quote is not None else None

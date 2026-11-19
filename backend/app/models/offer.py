"""Oferta de OS com preço para os técnicos parceiros.

A central manda uma OS sem técnico para alguns técnicos, com o valor que ele recebe; o primeiro que
aceita fica com a OS (services/offers.py). Sem contraproposta: o técnico aceita pelo valor ou
recusa. Uma oferta pendente por técnico em cada OS (índice único parcial): reenviar substitui a
anterior.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Numeric, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import OfferCancelReason, OfferStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.user import User


class TicketOffer(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "ticket_offers"
    __table_args__ = (
        # "Minhas ofertas" do técnico (as pendentes e as que fecharam há pouco).
        Index("ix_ticket_offers_technician_status", "technician_id", "status"),
        # Uma oferta pendente por técnico em cada OS.
        Index(
            "uq_ticket_offers_ticket_tech_pending",
            "ticket_id",
            "technician_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    technician_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # Quanto o técnico recebe pela OS se aceitar (vira o valor dele na OS).
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    status: Mapped[OfferStatus] = mapped_column(
        str_enum(OfferStatus),
        default=OfferStatus.PENDING,
        server_default=OfferStatus.PENDING.value,
    )
    # Prazo para responder (opcional). Passou sem resposta: o estado efetivo é "expired".
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Recado da central para o técnico.
    note: Mapped[str | None] = mapped_column(Text)
    # Motivo da recusa (opcional, do técnico).
    decline_reason: Mapped[str | None] = mapped_column(Text)
    cancel_reason: Mapped[OfferCancelReason | None] = mapped_column(str_enum(OfferCancelReason))
    # O técnico abriu a oferta (o detalhe no app): só então ele pode aceitar.
    viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Aceite ou recusa do técnico.
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Quando o técnico abriu o escopo no app; gravado no aceite (null: oferta não aceita ou app
    # antigo).
    scope_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    technician: Mapped[User] = relationship(foreign_keys=[technician_id], lazy="selectin")
    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")

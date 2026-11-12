"""Assistência externa: impressoras (e outros equipamentos) retiradas dos clientes que vão para
conserto em assistência técnica de terceiros. Controla cada etapa, da retirada à devolução."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Identity, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import RepairStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey, created_at_column
from app.models._types import str_enum
from app.models.customer import Customer, Location
from app.models.user import User


class RepairOrder(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "repair_orders"

    number: Mapped[int] = mapped_column(Integer, Identity(), unique=True)
    status: Mapped[RepairStatus] = mapped_column(
        str_enum(RepairStatus), default=RepairStatus.WITHDRAWN, index=True
    )
    status_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL")
    )
    # OS em que o equipamento foi retirado (opcional).
    ticket_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tickets.id", ondelete="SET NULL"), index=True
    )
    equipment_type: Mapped[str] = mapped_column(String(60), default="Impressora")
    brand: Mapped[str | None] = mapped_column(String(80))
    model: Mapped[str | None] = mapped_column(String(120))
    serial_number: Mapped[str | None] = mapped_column(String(120), index=True)
    asset_tag: Mapped[str | None] = mapped_column(String(80))  # patrimônio do cliente
    problem: Mapped[str] = mapped_column(Text)
    accessories: Mapped[str | None] = mapped_column(Text)  # cabos, toner, bandejas...
    vendor_name: Mapped[str | None] = mapped_column(String(160))
    vendor_contact: Mapped[str | None] = mapped_column(String(160))
    vendor_protocol: Mapped[str | None] = mapped_column(String(80))  # nº da OS na assistência
    vendor_quote_value: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    expected_return_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    customer: Mapped[Customer | None] = relationship(lazy="selectin")
    location: Mapped[Location | None] = relationship(lazy="selectin")
    events: Mapped[list["RepairEvent"]] = relationship(
        lazy="selectin", order_by="RepairEvent.created_at", viewonly=True
    )
    photos: Mapped[list["RepairPhoto"]] = relationship(
        lazy="selectin", order_by="RepairPhoto.created_at", viewonly=True
    )


class RepairEvent(UUIDPrimaryKey, Base):
    """Linha do tempo: cada mudança de etapa, com quem fez e quando."""

    __tablename__ = "repair_events"

    repair_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("repair_orders.id", ondelete="CASCADE"), index=True
    )
    from_status: Mapped[RepairStatus | None] = mapped_column(str_enum(RepairStatus))
    to_status: Mapped[RepairStatus] = mapped_column(str_enum(RepairStatus))
    note: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created_at_column()

    actor: Mapped[User | None] = relationship(lazy="selectin")


class RepairPhoto(UUIDPrimaryKey, Base):
    """Foto do equipamento (estado na retirada, etiqueta, laudo da assistência...)."""

    __tablename__ = "repair_photos"

    repair_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("repair_orders.id", ondelete="CASCADE"), index=True
    )
    storage_key: Mapped[str] = mapped_column(String(255))
    caption: Mapped[str | None] = mapped_column(String(200))
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = created_at_column()

import uuid

from sqlalchemy import Boolean, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import AssetType
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.customer import Customer, Location


class Asset(UUIDPrimaryKey, Timestamps, Base):
    """Equipamento / item de configuração (impressora, computador, switch, câmera, DVR...)."""

    __tablename__ = "assets"

    customer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"), index=True
    )
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), index=True
    )
    asset_type: Mapped[AssetType] = mapped_column(str_enum(AssetType), index=True)
    name: Mapped[str] = mapped_column(String(200))
    brand: Mapped[str | None] = mapped_column(String(80))
    model: Mapped[str | None] = mapped_column(String(120))
    serial_number: Mapped[str | None] = mapped_column(String(120), index=True)
    asset_tag: Mapped[str | None] = mapped_column(String(60), index=True)  # patrimônio
    ip_address: Mapped[str | None] = mapped_column(String(45))
    mac_address: Mapped[str | None] = mapped_column(String(17))
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    customer: Mapped[Customer] = relationship(lazy="selectin")
    location: Mapped[Location | None] = relationship(lazy="selectin")

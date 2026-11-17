"""Técnicos favoritos por cidade: as decisões manuais da central.

A lista automática (até 3 por cidade, quem mais atendeu nas lojas da cidade nos últimos 12 meses)
é calculada na hora em services/technician_favorites e não fica no banco. Aqui ficam só as
exceções: o técnico fixado na cidade (include) ou tirado da lista automática (hide).
"""

import uuid
from enum import StrEnum

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.user import User


class FavoriteKind(StrEnum):
    INCLUDE = "include"  # fixado: favorito mesmo sem OS ou fora do top 3
    HIDE = "hide"  # tirado da lista automática da cidade (o próximo sobe)


class TechnicianFavorite(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "technician_favorites"
    __table_args__ = (
        UniqueConstraint("state", "city_key", "user_id", name="uq_technician_favorites_city_tech"),
    )

    # Cidade da loja: UF em maiúsculas + cidade sem acento (technician_regions.fold_text).
    state: Mapped[str] = mapped_column(String(2))
    city_key: Mapped[str] = mapped_column(String(120))
    # Grafia das lojas no momento da gravação (a tela usa a grafia atual).
    city: Mapped[str] = mapped_column(String(120))
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[FavoriteKind] = mapped_column(str_enum(FavoriteKind))
    note: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="selectin")
    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")
    updated_by: Mapped[User | None] = relationship(foreign_keys=[updated_by_id], lazy="selectin")

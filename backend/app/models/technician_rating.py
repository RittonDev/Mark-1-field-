"""Avaliação do cliente sobre um técnico numa OS concluída (services/technician_ratings.py).

Uma por OS e técnico (o responsável ou um auxiliar; quem saiu da OS e tem avaliação ainda é
corrigido ou excluído), nota de 1 a 5, comentário e quem avaliou no cliente (`rater_name`). Hoje a
central registra (`source` "central"); "client" fica para o formulário do cliente no módulo de OS.
Só a gestão vê: nada no app e fora do Elo. O rastro fica nos históricos da OS (eventos rating_set e
rating_removed) e do cadastro do técnico; corrigir grava quem corrigiu (`updated_by`).
"""

import uuid

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import RatingSource
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.user import User


class TechnicianRating(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "technician_ratings"
    __table_args__ = (
        UniqueConstraint(
            "ticket_id", "technician_id", name="uq_technician_ratings_ticket_technician"
        ),
        CheckConstraint("score BETWEEN 1 AND 5", name="score"),
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"))
    technician_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    score: Mapped[int] = mapped_column(SmallInteger)
    comment: Mapped[str | None] = mapped_column(Text)
    # Quem avaliou, no cliente (até 120).
    rater_name: Mapped[str | None] = mapped_column(String(120))
    source: Mapped[RatingSource] = mapped_column(
        str_enum(RatingSource),
        default=RatingSource.CENTRAL,
        server_default=RatingSource.CENTRAL.value,
    )
    # Quem registrou e quem corrigiu por último (null: nunca corrigida).
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    technician: Mapped[User] = relationship(foreign_keys=[technician_id], lazy="selectin")
    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")
    updated_by: Mapped[User | None] = relationship(foreign_keys=[updated_by_id], lazy="selectin")

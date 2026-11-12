"""Rastreamento dos técnicos de campo.

Coleta só durante a jornada (o técnico inicia e encerra) e só depois do aceite do termo de
ciência (LGPD). Fora disso, os pontos são descartados. O histórico expira em
TRACKING_RETENTION_DAYS.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKey, created_at_column


class TechnicianShift(UUIDPrimaryKey, Base):
    """Jornada de trabalho: o rastreamento só vale entre o início e o fim."""

    __tablename__ = "technician_shifts"
    __table_args__ = (Index("ix_technician_shifts_user_ended", "user_id", "ended_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    start_latitude: Mapped[float | None] = mapped_column(Float)
    start_longitude: Mapped[float | None] = mapped_column(Float)
    end_latitude: Mapped[float | None] = mapped_column(Float)
    end_longitude: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = created_at_column()


class LocationPing(Base):
    """Posição enviada pelo app (em lote, inclusive depois de ficar offline)."""

    __tablename__ = "location_pings"
    __table_args__ = (
        # A unicidade (dedupe do reenvio) já cria o índice usado pelo mapa e pelo histórico.
        UniqueConstraint("user_id", "recorded_at", name="uq_location_pings_user_recorded"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    shift_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("technician_shifts.id", ondelete="SET NULL")
    )
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # hora do aparelho
    received_at: Mapped[datetime] = created_at_column()  # hora do servidor
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    accuracy_m: Mapped[float | None] = mapped_column(Float)
    speed_mps: Mapped[float | None] = mapped_column(Float)
    heading: Mapped[float | None] = mapped_column(Float)
    battery_pct: Mapped[int | None] = mapped_column(Integer)
    # Android informa localização simulada (app de GPS falso): sinalizamos para o gestor.
    is_mock: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

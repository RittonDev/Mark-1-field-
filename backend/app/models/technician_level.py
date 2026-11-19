"""Elo dos técnicos (Bronze, Prata, Ouro e Diamante): o cálculo guardado e o que a central
desconsiderou.

A faixa sai da quantidade e da qualidade dos atendimentos dos últimos 12 meses
(services/technician_levels.py). A linha de technician_levels é recalculada a cada 6 h pela
rotina periódica e na hora para um técnico (app, cadastro na central, desconsiderar). Ela guarda
a faixa em vigor (com a carência de 30 dias para descer) e os números da última conta.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Text, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import LevelOccurrenceKind, LevelTier
from app.db.base import Base, Timestamps, UUIDPrimaryKey, created_at_column
from app.models._types import str_enum
from app.models.user import User


class TechnicianLevel(Timestamps, Base):
    """Um por técnico. Sem linha: Bronze (o técnico ainda não entrou na conta)."""

    __tablename__ = "technician_levels"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # Faixa em vigor: sobe na hora e só desce depois de 30 dias seguidos abaixo do critério.
    tier: Mapped[LevelTier] = mapped_column(str_enum(LevelTier), index=True)
    # Faixa pelos números da última conta (abaixo de `tier` enquanto corre a carência).
    computed_tier: Mapped[LevelTier] = mapped_column(str_enum(LevelTier))
    tier_since: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Desde quando a conta está abaixo da faixa em vigor (null: cumpre os critérios).
    at_risk_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Números da última conta: {window_start, window_end, services, as_assignee, as_helper,
    # measured, arrivals, late, reworks, lost, waived}.
    metrics: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TechnicianLevelWaiver(UUIDPrimaryKey, Base):
    """Ocorrência que a central desconsiderou (com o motivo): atraso por agenda errada, reabertura
    por engano, motivo de improdutiva mal escolhido. Só a gestão vê; o técnico não."""

    __tablename__ = "technician_level_waivers"
    __table_args__ = (
        UniqueConstraint(
            "technician_id", "kind", "ref_id", name="uq_technician_level_waivers_occurrence"
        ),
    )

    technician_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[LevelOccurrenceKind] = mapped_column(str_enum(LevelOccurrenceKind))
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    # A OS no atraso; o evento do histórico no retorno e na visita perdida.
    ref_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    # Motivo (1 a 300 caracteres).
    note: Mapped[str] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = created_at_column()

    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")

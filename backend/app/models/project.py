"""Projetos: OS marcadas como parte de um projeto têm valores, equipe e acompanhamento próprios
(ex.: troca do cabeamento de 30 lojas de uma rede, com valor fechado e equipe dedicada)."""

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Identity, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import ProjectStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.customer import Customer
from app.models.user import Team, User


class Project(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "projects"

    number: Mapped[int] = mapped_column(Integer, Identity(), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[ProjectStatus] = mapped_column(
        str_enum(ProjectStatus), default=ProjectStatus.ACTIVE, index=True
    )
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    # Valor fechado com o cliente (o projeto tem preço próprio, fora da tabela avulsa).
    contract_value: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    # Condições do projeto: valor por visita, por loja, regras de cobrança...
    pricing_notes: Mapped[str | None] = mapped_column(Text)
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"))
    # Técnicos dedicados ao projeto (sugeridos primeiro ao atribuir as OS dele).
    member_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    customer: Mapped[Customer | None] = relationship(lazy="selectin")
    manager: Mapped[User | None] = relationship(foreign_keys=[manager_id], lazy="selectin")
    team: Mapped[Team | None] = relationship(lazy="selectin")

import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import Responsibility, TicketPriority, ViolationScope
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.customer import Customer
from app.models.user import Team


class Category(UUIDPrimaryKey, Timestamps, Base):
    """Categoria hierárquica (ex.: Impressoras > Atolamento de papel).

    `default_team_id` roteia automaticamente a OS para um grupo técnico.
    """

    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("parent_id", "name", name="uq_categories_parent_name"),)

    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), index=True
    )
    default_team_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("teams.id", ondelete="SET NULL")
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    parent: Mapped["Category | None"] = relationship(
        remote_side="Category.id", lazy="selectin", join_depth=3
    )
    default_team: Mapped[Team | None] = relationship(lazy="selectin")

    @property
    def full_name(self) -> str:
        parts = [self.name]
        node = self.parent
        depth = 0
        while node is not None and depth < 5:
            parts.append(node.name)
            node = node.parent
            depth += 1
        return " > ".join(reversed(parts))


class SlaPolicy(UUIDPrimaryKey, Timestamps, Base):
    """Metas de SLA por prioridade (minutos corridos, 24x7)."""

    __tablename__ = "sla_policies"

    priority: Mapped[TicketPriority] = mapped_column(str_enum(TicketPriority), unique=True)
    response_minutes: Mapped[int] = mapped_column(Integer)
    resolution_minutes: Mapped[int] = mapped_column(Integer)


class ServiceType(UUIDPrimaryKey, Timestamps, Base):
    """Tipo de serviço (o "Tipo de OS" do Field Control) com a duração estimada.

    Sem `customer_id`, vale para todos os clientes; com, é o catálogo daquele cliente
    (ex.: "Preventiva de loja - Shoulder"). A duração observada é derivada das OS concluídas
    (mediana do tempo em atendimento) e sugere correções da estimativa.
    """

    __tablename__ = "service_types"
    __table_args__ = (
        UniqueConstraint("customer_id", "name", name="uq_service_types_customer_name"),
    )

    name: Mapped[str] = mapped_column(String(160), index=True)
    description: Mapped[str | None] = mapped_column(Text)
    estimated_minutes: Mapped[int] = mapped_column(Integer)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"), index=True
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL")
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    customer: Mapped[Customer | None] = relationship(lazy="selectin")
    category: Mapped[Category | None] = relationship(lazy="selectin")


class ViolationReason(UUIDPrimaryKey, Timestamps, Base):
    """Motivo de violação de SLA (tela "Motivos de violação" do Field Control)."""

    __tablename__ = "violation_reasons"

    name: Mapped[str] = mapped_column(String(160), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    applies_to: Mapped[ViolationScope] = mapped_column(
        str_enum(ViolationScope), default=ViolationScope.BOTH
    )
    responsibility: Mapped[Responsibility] = mapped_column(str_enum(Responsibility))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")


class UnproductiveReason(UUIDPrimaryKey, Timestamps, Base):
    """Motivo de visita improdutiva (o técnico foi e não conseguiu atender)."""

    __tablename__ = "unproductive_reasons"

    name: Mapped[str] = mapped_column(String(160), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    responsibility: Mapped[Responsibility] = mapped_column(str_enum(Responsibility))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

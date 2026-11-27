import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.core.enums import Responsibility, TicketPriority, ViolationScope
from app.core.text import fold
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
    # Quanto o técnico parceiro recebe por uma OS deste tipo (padrão; a central ajusta em cada OS).
    technician_fee: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
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


# ------------------------------------------- catálogos de Configurações › Técnicos (Entrega 2)
# Ferramental, Áreas de atuação e Aptidões: uma regra só (services/technician_catalogs.py). A
# central inclui, renomeia e desativa; exclui só o que nunca foi usado. Sem ordem manual: as listas
# saem em ordem alfabética (name_key). Desativado, o item some das escolhas (app, ficha, filtros) e
# fica guardado com quem já tinha; reativado, volta. `name_key` = core.text.fold(name)
# (`name_key_of`), gravado sozinho quando o nome muda (@validates): o banco recusa o nome repetido
# sem acento e sem maiúsculas (uq_*_name_key), de reserva para a trava do serviço. `used_at`: o 1º
# uso (o item entrou no perfil de alguém pelo app, pela central ou pela ficha); com ele, o item não
# sai mais (desativa).

# O tamanho da coluna name_key: o fold de um nome de 80 pode passar disso (a ligadura U+FB03 vira
# "ffi"), e aí ele é cortado, como na migração c8f2a4e6b0d3 (key_of).
NAME_KEY_MAX = 160


def name_key_of(name: str | None) -> str:
    """O name_key de um nome: o fold (sem acento e sem maiúsculas), cortado em NAME_KEY_MAX."""
    return fold(name)[:NAME_KEY_MAX]


class TechnicianTool(UUIDPrimaryKey, Timestamps, Base):
    """Ferramenta do ferramental dos técnicos. O técnico marca no app as que tem (users.tool_ids
    guarda os ids, em texto). O banco recusa também o nome exato repetido (uq_tool_catalog_name, de
    antes do name_key)."""

    __tablename__ = "tool_catalog"
    __table_args__ = (
        UniqueConstraint("name", name="uq_tool_catalog_name"),
        UniqueConstraint("name_key", name="uq_tool_catalog_name_key"),
    )

    name: Mapped[str] = mapped_column(String(80))
    name_key: Mapped[str] = mapped_column(String(NAME_KEY_MAX))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @validates("name")
    def _name_key(self, _: str, name: str) -> str:
        self.name_key = name_key_of(name)
        return name


class ServiceArea(UUIDPrimaryKey, Timestamps, Base):
    """Área de atuação (users.service_areas e technician_applications.service_areas guardam os
    ids, em texto). `code`: o código das 10 áreas fixas de antes ("redes"): a ficha aberta antes
    da Entrega 2 ainda manda o código, e a sugestão de técnicos (services/suggestions.py) segue
    por ele; as áreas novas ficam sem código."""

    __tablename__ = "area_catalog"
    __table_args__ = (
        UniqueConstraint("name_key", name="uq_area_catalog_name_key"),
        UniqueConstraint("code", name="uq_area_catalog_code"),
    )

    name: Mapped[str] = mapped_column(String(80))
    name_key: Mapped[str] = mapped_column(String(NAME_KEY_MAX))
    code: Mapped[str | None] = mapped_column(String(32))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @validates("name")
    def _name_key(self, _: str, name: str) -> str:
        self.name_key = name_key_of(name)
        return name


class Skill(UUIDPrimaryKey, Timestamps, Base):
    """Aptidão do catálogo. O técnico guarda [{skill_id, level, since}] em users.skills e a ficha
    [{skill_id, level}] (sem o nome: renomear vale para todos)."""

    __tablename__ = "skill_catalog"
    __table_args__ = (UniqueConstraint("name_key", name="uq_skill_catalog_name_key"),)

    name: Mapped[str] = mapped_column(String(80))
    name_key: Mapped[str] = mapped_column(String(NAME_KEY_MAX))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @validates("name")
    def _name_key(self, _: str, name: str) -> str:
        self.name_key = name_key_of(name)
        return name

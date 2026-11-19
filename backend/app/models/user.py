import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core import permissions
from app.core.enums import PixKeyType, UserRole
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.access import AccessProfile
from app.models.customer import Customer

STAFF_ROLES = frozenset(
    {UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST, UserRole.TECHNICIAN}
)
TICKET_MANAGER_ROLES = frozenset({UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST})


class Team(UUIDPrimaryKey, Timestamps, Base):
    """Grupo técnico (ex.: Suporte N1, Campo - Infraestrutura, CFTV)."""

    __tablename__ = "teams"

    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")


class User(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("ix_users_base_state_city", "base_state", "base_city"),
        # Chave PIX: tipo e chave andam juntos (os dois preenchidos ou os dois vazios).
        CheckConstraint("(pix_key IS NULL) = (pix_key_type IS NULL)", name="pix_pair"),
    )

    name: Mapped[str] = mapped_column(String(160))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(40))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(str_enum(UserRole), index=True)
    job_title: Mapped[str | None] = mapped_column(String(120))
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("teams.id", ondelete="SET NULL"), index=True
    )
    # Usuário do cliente (solicitante): a empresa dele. No portal ele abre e acompanha as
    # solicitações de todas as lojas dessa empresa.
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Aceite do termo de ciência do rastreamento (LGPD); sem ele a jornada não começa.
    location_consent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Senha provisória (técnico importado): o app obriga a trocar no primeiro acesso.
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    # Foto do perfil (chave no armazenamento de arquivos).
    avatar_key: Mapped[str | None] = mapped_column(String(255))
    # Tokens emitidos antes disto deixam de valer (troca/redefinição de senha, desativação).
    sessions_revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Onde o técnico mora e que região atende: base das sugestões de técnico por cidade.
    home_city: Mapped[str | None] = mapped_column(String(120))
    home_state: Mapped[str | None] = mapped_column(String(2))
    home_latitude: Mapped[float | None] = mapped_column(Float)
    home_longitude: Mapped[float | None] = mapped_column(Float)
    # Região de atuação do técnico: a cidade onde mais atendeu (histórico de OS) ou, sem
    # histórico, o endereço dele. Recalculada por services/technician_regions.refresh_bases.
    base_city: Mapped[str | None] = mapped_column(String(120))
    base_state: Mapped[str | None] = mapped_column(String(2))
    base_latitude: Mapped[float | None] = mapped_column(Float)
    base_longitude: Mapped[float | None] = mapped_column(Float)
    base_source: Mapped[str | None] = mapped_column(String(10))  # history | home
    base_visits: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_visit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    base_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    coverage_area: Mapped[str | None] = mapped_column(Text)
    # Ficha completa: endereço (rua, número, complemento; bairro; CEP), jornada de trabalho
    # {start, end, break_start, break_end} ("HH:MM:SS"), serviços que faz (ids de service_types),
    # foto que veio de fora (Field Control) e dados de origem.
    address_line: Mapped[str | None] = mapped_column(String(255))
    address_district: Mapped[str | None] = mapped_column(String(120))
    address_zip: Mapped[str | None] = mapped_column(String(10))
    # Sem jornada fica NULL de verdade (não o "null" do JSON).
    work_schedule: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    service_type_ids: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    avatar_external_url: Mapped[str | None] = mapped_column(String(1000))
    # Chave PIX para receber por chamado: só o próprio técnico cadastra e troca (app, com a senha);
    # a central vê em Pagamentos e pode remover. A chave fica normalizada (core/pix.py).
    pix_key_type: Mapped[PixKeyType | None] = mapped_column(str_enum(PixKeyType))
    pix_key: Mapped[str | None] = mapped_column(String(80))
    pix_holder_name: Mapped[str | None] = mapped_column(String(160))
    pix_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Perfil técnico: o técnico mantém no app; a central só vê (services/tech_profile.py). Sem
    # índice: os filtros varrem só os técnicos; GIN em tool_ids/availability se a base passar de
    # dezenas de milhares de técnicos. Ferramentas: ids (texto) do tool_catalog, inclusive as
    # desativadas que já estavam marcadas; turnos "dia:turno" ("sat:afternoon"); meios de transporte
    # e CNH (valem com a parte "transport" carimbada); aptidões [{name, level, since}]; formação
    # [{id, course, level, institution, start, end}]; e o carimbo de cada parte informada
    # {parte: {at, via: "app"|"ficha"}}. Grave sempre objetos novos (user.skills = [...],
    # user.tech_profile_stamps = {**antigo, parte: carimbo}): mudar a lista ou o dicionário no
    # lugar não é detectado e não grava.
    tool_ids: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    availability: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    transport_modes: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    has_driver_license: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    skills: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    education: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )
    tech_profile_stamps: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default="{}"
    )
    legacy: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # Conta Microsoft (Entra ID) vinculada no primeiro login: "oid" do token.
    entra_oid: Mapped[str | None] = mapped_column(String(64), unique=True)
    # Perfil de acesso (telas e filas): só supervisor e analista. O administrador tem acesso
    # total sempre; técnico e cliente ficam fora da matriz (core/permissions.py).
    access_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("access_profiles.id", ondelete="RESTRICT"), index=True
    )
    # Ajustes da pessoa por cima do perfil:
    # {"items": {item: "none"|"view"|"edit"}, "queue_scope": "own"|"all"|null,
    #  "queue_unowned": bool|null}. Sem ajuste fica NULL de verdade.
    access_overrides: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))

    team: Mapped[Team | None] = relationship(lazy="selectin")
    customer: Mapped[Customer | None] = relationship(lazy="selectin")
    # Chega carregado com o usuário (como team e customer): sem I/O síncrono depois.
    access_profile: Mapped[AccessProfile | None] = relationship(lazy="selectin")

    def token_revoked(self, payload: dict) -> bool:
        """Token emitido antes da última revogação de sessões (iat em segundos inteiros)."""
        if self.sessions_revoked_at is None:
            return False
        return int(payload.get("iat", 0)) < int(self.sessions_revoked_at.timestamp())

    @property
    def is_staff(self) -> bool:
        """Equipe interna (vê notas internas e apontamentos)."""
        return self.role in STAFF_ROLES

    @property
    def can_manage_tickets(self) -> bool:
        """Gestão completa das OS na web: vê todas, cria, edita, atribui, muda status."""
        return self.role in TICKET_MANAGER_ROLES

    @property
    def is_manager(self) -> bool:
        """Configuração: grupos, categorias (SLA e usuários só admin)."""
        return self.role in (UserRole.ADMIN, UserRole.SUPERVISOR)

    @property
    def access_summary(self) -> dict[str, Any] | None:
        """Acesso efetivo (telas e filas) para a tela; técnico e cliente: None."""
        return permissions.summary(self)

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
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
from app.core.enums import OperationalStatus, UserRole
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
    __table_args__ = (Index("ix_users_base_state_city", "base_state", "base_city"),)

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
    # Ficha completa: endereço em partes (address_line é o logradouro; número, complemento, bairro e
    # CEP; a migração b7e2d4f6a8c1 separou as linhas "rua, número - complemento"), jornada de
    # trabalho {start, end, break_start, break_end} ("HH:MM:SS"), serviços que faz (ids de
    # service_types), foto que veio de fora (Field Control) e dados de origem.
    address_line: Mapped[str | None] = mapped_column(String(255))
    address_number: Mapped[str | None] = mapped_column(String(10))  # "S/N" vale
    address_complement: Mapped[str | None] = mapped_column(String(60))
    address_district: Mapped[str | None] = mapped_column(String(120))
    address_zip: Mapped[str | None] = mapped_column(String(10))
    # Sem jornada fica NULL de verdade (não o "null" do JSON).
    work_schedule: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    service_type_ids: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    avatar_external_url: Mapped[str | None] = mapped_column(String(1000))
    # Dados pessoais do técnico (schemas/personal.py valida e formata). CPF só com os 11 números,
    # único entre os usuários (vários vazios valem); o técnico informa uma vez, depois só a central
    # muda. RG com os três ou nenhum (número, órgão emissor e UF). Telefone secundário formatado como
    # o celular; mini biografia até 500.
    cpf: Mapped[str | None] = mapped_column(String(11), unique=True)
    rg_number: Mapped[str | None] = mapped_column(String(20))
    rg_issuer: Mapped[str | None] = mapped_column(String(20))
    rg_state: Mapped[str | None] = mapped_column(String(2))
    birth_date: Mapped[date | None] = mapped_column(Date)
    phone_secondary: Mapped[str | None] = mapped_column(String(40))
    bio: Mapped[str | None] = mapped_column(Text)
    # Veículo (Transporte): modelo e placa "ABC1234" ou "ABC1D23", sem hífen.
    vehicle_model: Mapped[str | None] = mapped_column(String(60))
    vehicle_plate: Mapped[str | None] = mapped_column(String(7))
    # Empresa do técnico: CNPJ normalizado (aceita o alfanumérico), razão social e nome fantasia.
    company_document: Mapped[str | None] = mapped_column(String(14))
    company_name: Mapped[str | None] = mapped_column(String(160))
    company_trade_name: Mapped[str | None] = mapped_column(String(160))
    # Áreas de atuação (os códigos de schemas/onboarding.SERVICE_AREAS), copiadas da ficha na
    # aprovação.
    service_areas: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    # E-mail de login validado pelo link (services/account.py). O e-mail novo pedido pelo app fica
    # em email_pending até o link: o login só muda quando ele é validado.
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    email_pending: Mapped[str | None] = mapped_column(String(255))
    email_pending_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Situação na operação (só a central vê): ativo, inativo ou bloqueado, com o motivo, quem e
    # quando. Separada do acesso ao app (is_active): receber OS pede os dois.
    operational_status: Mapped[OperationalStatus] = mapped_column(
        str_enum(OperationalStatus),
        default=OperationalStatus.ACTIVE,
        server_default=OperationalStatus.ACTIVE.value,
    )
    operational_reason: Mapped[str | None] = mapped_column(Text)
    operational_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Sem relação para users: o nome sai de uma consulta (as telas pedem só às vezes).
    operational_changed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # Indisponibilidade (services/unavailability.py): [{"id", "start", "end"}] com as datas locais
    # "AAAA-MM-DD", os dois dias inclusive, sem motivo (LGPD); o que acabou sai na gravação.
    unavailability: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )
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
    has_driver_license: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
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

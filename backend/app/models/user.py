import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import UserRole
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum

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

    name: Mapped[str] = mapped_column(String(160))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(40))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(str_enum(UserRole), index=True)
    job_title: Mapped[str | None] = mapped_column(String(120))
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("teams.id", ondelete="SET NULL"), index=True
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

    team: Mapped[Team | None] = relationship(lazy="selectin")

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

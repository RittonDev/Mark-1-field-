import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import UserRole
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum


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

    team: Mapped[Team | None] = relationship(lazy="selectin")

    @property
    def is_staff(self) -> bool:
        return self.role in (UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST)

    @property
    def is_manager(self) -> bool:
        return self.role in (UserRole.ADMIN, UserRole.SUPERVISOR)

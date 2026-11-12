"""Homologação de técnicos: convite por link e ficha preenchida pelo próprio técnico.

O analista gera o link e envia ao técnico; ele preenche a ficha (dados pessoais, atuação,
skills, região e o acesso ao app) e aceita o aviso de privacidade (LGPD). A ficha chega em
"Homologação" para análise; aprovada, vira o usuário técnico com o e-mail e a senha que ele
mesmo cadastrou.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import ApplicationStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey, created_at_column
from app.models._types import str_enum
from app.models.user import User


class OnboardingInvite(UUIDPrimaryKey, Base):
    """Link de cadastro. Só o hash do token fica no banco (o link aparece uma vez)."""

    __tablename__ = "onboarding_invites"

    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str | None] = mapped_column(String(160))
    # None = reutilizável até expirar (ex.: link enviado num grupo de técnicos).
    max_uses: Mapped[int | None] = mapped_column(Integer)
    use_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = created_at_column()

    created_by: Mapped[User | None] = relationship(lazy="selectin")


class TechnicianApplication(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "technician_applications"

    invite_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("onboarding_invites.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[ApplicationStatus] = mapped_column(
        str_enum(ApplicationStatus), default=ApplicationStatus.PENDING, index=True
    )

    # Dados pessoais
    full_name: Mapped[str] = mapped_column(String(160))
    email: Mapped[str] = mapped_column(String(255), index=True)
    phone: Mapped[str] = mapped_column(String(40))
    document: Mapped[str] = mapped_column(String(20))  # CPF
    birth_date: Mapped[date | None] = mapped_column(Date)
    postal_code: Mapped[str | None] = mapped_column(String(12))
    address: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str] = mapped_column(String(120))
    state: Mapped[str] = mapped_column(String(2))

    # Atuação
    company_document: Mapped[str | None] = mapped_column(String(20))  # CNPJ/MEI
    years_experience: Mapped[int | None] = mapped_column(Integer)
    service_areas: Mapped[list[str]] = mapped_column(JSONB, default=list)
    skills: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    certifications: Mapped[str | None] = mapped_column(Text)
    tools: Mapped[str | None] = mapped_column(Text)
    has_vehicle: Mapped[bool] = mapped_column(Boolean, default=False)
    vehicle_type: Mapped[str | None] = mapped_column(String(20))
    has_driver_license: Mapped[bool] = mapped_column(Boolean, default=False)
    coverage_area: Mapped[str] = mapped_column(Text)
    availability: Mapped[list[str]] = mapped_column(JSONB, default=list)
    notes: Mapped[str | None] = mapped_column(Text)
    photo_key: Mapped[str | None] = mapped_column(String(255))

    # Acesso ao app: a senha que o técnico escolheu (hash). Apagada na análise.
    password_hash: Mapped[str | None] = mapped_column(String(255))

    # LGPD: aceite do aviso de privacidade (versão exibida e quando).
    privacy_consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    privacy_version: Mapped[str] = mapped_column(String(20))

    # Análise
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    invite: Mapped[OnboardingInvite | None] = relationship(lazy="selectin")
    reviewed_by: Mapped[User | None] = relationship(foreign_keys=[reviewed_by_id], lazy="selectin")

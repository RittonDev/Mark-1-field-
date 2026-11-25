"""Links de uso único mandados por e-mail: validar o e-mail e criar uma senha nova.

Só o SHA-256 do token fica no banco (services/account.py); o token cru nasce na hora do envio,
dentro do e-mail (nem a fila guarda o link), e vai no fragmento da URL (#token=), que não chega a
servidor nem a log. Cada token tem um alvo só: o usuário ou a ficha da homologação (apagar a ficha
apaga os tokens dela). `reason`: na validação "signup" (a ficha), "change" (o e-mail novo pedido
no app) ou "check" (o login de sempre); na senha "self" (Esqueci minha senha), "central" (link
mandado pela central) ou "welcome" (criar a primeira senha, na boas-vindas).
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import AccountTokenPurpose
from app.db.base import Base, UUIDPrimaryKey, created_at_column
from app.models._types import str_enum


class AccountToken(UUIDPrimaryKey, Base):
    __tablename__ = "account_tokens"
    __table_args__ = (
        CheckConstraint("(user_id IS NULL) <> (application_id IS NULL)", name="one_target"),
    )

    purpose: Mapped[AccountTokenPurpose] = mapped_column(str_enum(AccountTokenPurpose))
    reason: Mapped[str | None] = mapped_column(String(16))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("technician_applications.id", ondelete="CASCADE"), index=True
    )
    # O endereço para onde o link foi (minúsculas): a validação vale para ele.
    email: Mapped[str] = mapped_column(String(255))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = created_at_column()

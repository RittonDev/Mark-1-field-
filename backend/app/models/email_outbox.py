"""Fila e registro dos e-mails transacionais (services/mail.py).

Cada e-mail pedido vira uma linha "pending"; a entrega (logo depois do commit e, de novo, pela
rotina da fila) monta o texto, cria o link de uso único e manda. `context` guarda só o nome e as
opções do modelo, nunca o token. Sem envio configurado a linha fica "pending" até `send_by` e vence
("Não enviado"); o servidor que recusa de vez ou as tentativas esgotadas dão "failed". A central vê
o registro na ficha do técnico; a rotina apaga as linhas depois de 180 dias.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import EmailStatus, EmailTemplate
from app.db.base import Base, UUIDPrimaryKey, created_at_column, utcnow
from app.models._types import str_enum
from app.models.user import User


class EmailOutbox(UUIDPrimaryKey, Base):
    __tablename__ = "email_outbox"
    __table_args__ = (Index("ix_email_outbox_status_next", "status", "next_attempt_at"),)

    template: Mapped[EmailTemplate] = mapped_column(str_enum(EmailTemplate))
    to_email: Mapped[str] = mapped_column(String(255))
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("technician_applications.id", ondelete="CASCADE"), index=True
    )
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    status: Mapped[EmailStatus] = mapped_column(
        str_enum(EmailStatus),
        default=EmailStatus.PENDING,
        server_default=EmailStatus.PENDING.value,
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    # Passou disso sem sair: vence (um link de 2 h que chega um dia depois não serve).
    send_by: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # O erro da última tentativa (sem o endereço nem o link).
    last_error: Mapped[str | None] = mapped_column(String(500))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = created_at_column()

    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")

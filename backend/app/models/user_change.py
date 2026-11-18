"""Histórico do cadastro do técnico: o que mudou, quem mudou e por onde (app ou central).

Cada linha guarda as mudanças de uma gravação, já com o texto da tela
(services/user_history.py): [{field, from, to}]. A chave PIX nunca fica em claro aqui, só mascarada
("CPF ***.456.789-**"); e-mail e celular ficam como estavam, para a central desfazer uma troca
indevida.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, UUIDPrimaryKey, created_at_column
from app.models.user import User

# Por onde a mudança chegou.
VIA_APP = "app"  # o próprio técnico, no Meu cadastro do app
VIA_CENTRAL = "central"  # a central, em Técnicos, Usuários ou Pagamentos


class UserChange(UUIDPrimaryKey, Base):
    __tablename__ = "user_changes"
    __table_args__ = (Index("ix_user_changes_user_created", "user_id", "created_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # Quem mudou (o técnico no app ou a pessoa da central); sem ele, "Sistema".
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    via: Mapped[str] = mapped_column(String(10))
    changes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created_at_column()

    actor: Mapped[User | None] = relationship(foreign_keys=[actor_id], lazy="selectin")

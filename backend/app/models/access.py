"""Perfis de acesso: o nível de cada tela do menu e a visibilidade das filas.

Só supervisor e analista usam perfil. O administrador tem acesso total sempre, e técnico e cliente
ficam fora da matriz (o papel deles já decide tudo). O catálogo das telas e os padrões de cada papel
estão no código (core/permissions.py): os perfis padrão ("supervisor" e "analyst") nascem vazios e,
assim, reproduzem o acesso de antes dos perfis. Cada chave gravada em `items` sobrepõe o padrão.

Sem FK para users (quem aponta é users.access_profile_id): não há ciclo no create_all dos testes.
"""

from typing import Any

from sqlalchemy import Boolean, CheckConstraint, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPrimaryKey


class AccessProfile(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "access_profiles"
    __table_args__ = (CheckConstraint("queue_scope in ('own','all')", name="queue_scope"),)

    name: Mapped[str] = mapped_column(String(80), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    # "supervisor" | "analyst" nos perfis padrão; NULL nos perfis criados na tela.
    system_key: Mapped[str | None] = mapped_column(String(20), unique=True)
    # {item_key: "none" | "view" | "edit"}. Chave ausente = padrão do código (do system_key; num
    # perfil criado na tela, o padrão do analista).
    items: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    # "own" = só a própria fila; "all" = todas as filas da equipe.
    queue_scope: Mapped[str] = mapped_column(String(10), default="all", server_default="all")
    # Com "own": também vê (e pode puxar) as OS sem analista.
    queue_unowned: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

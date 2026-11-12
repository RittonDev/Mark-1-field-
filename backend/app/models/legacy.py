"""Referências de registros migrados de outro sistema (ex.: Field Control).

Guarda o id de origem de cada registro importado: a importação pode rodar de novo sem
duplicar nada, e a equipe consegue achar a OS/cliente pelo número antigo.
"""

import uuid
from datetime import datetime

from sqlalchemy import Index, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKey, created_at_column


class LegacyRef(UUIDPrimaryKey, Base):
    __tablename__ = "legacy_refs"
    __table_args__ = (
        UniqueConstraint(
            "source", "kind", "external_id", name="uq_legacy_refs_source_kind_external"
        ),
        Index("ix_legacy_refs_kind_internal", "kind", "internal_id"),
    )

    source: Mapped[str] = mapped_column(String(30))  # "fieldcontrol"
    kind: Mapped[str] = mapped_column(String(30))  # customer, location, user, ticket, quote...
    external_id: Mapped[str] = mapped_column(String(80))
    internal_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    created_at: Mapped[datetime] = created_at_column()

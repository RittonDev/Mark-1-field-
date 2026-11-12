"""Orçamentos da OS, enviados ao cliente por link para aprovar (com assinatura) ou recusar.

Ex.: OS "organizar rack": a gestão já sabe que vai precisar de velcro, monta o orçamento com
os itens do catálogo e manda o link; o cliente aprova com nome, matrícula (opcional) e
assinatura, e pode deixar um comentário para a empresa.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Identity, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import QuoteStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.user import User


class QuoteItemCatalog(UUIDPrimaryKey, Timestamps, Base):
    """Itens com preço de referência para montar orçamentos rápido (material e serviço)."""

    __tablename__ = "quote_item_catalog"

    name: Mapped[str] = mapped_column(String(200), unique=True)
    unit: Mapped[str] = mapped_column(String(20), default="un")
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # product (material) | service (mão de obra) | expense (deslocamento, pedágio...)
    kind: Mapped[str] = mapped_column(String(20), default="product", server_default="product")


class Quote(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "quotes"

    number: Mapped[int] = mapped_column(Integer, Identity(), unique=True)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[QuoteStatus] = mapped_column(
        str_enum(QuoteStatus), default=QuoteStatus.DRAFT, index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    # [{description, quantity, unit, unit_price, catalog_item_id}]
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    discount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    valid_until: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)  # condições, prazo, pagamento

    # Link público do cliente: só o id fica no banco (o token leva um HMAC); dá para copiar
    # de novo a qualquer momento. Editar ou reenviar mantém o link; trocar ou cancelar muda.
    link_id: Mapped[str | None] = mapped_column(String(24), unique=True)
    # Links enviados antes do link_id (só o hash): seguem abrindo até a próxima edição.
    token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    # Decisão do cliente.
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approver_name: Mapped[str | None] = mapped_column(String(160))
    approver_document: Mapped[str | None] = mapped_column(String(20))
    approver_role: Mapped[str | None] = mapped_column(String(120))
    approver_registration: Mapped[str | None] = mapped_column(String(40))  # matrícula
    client_comment: Mapped[str | None] = mapped_column(Text)  # comentário para a empresa
    signature_key: Mapped[str | None] = mapped_column(String(255))
    decision_ip: Mapped[str | None] = mapped_column(String(64))
    rejection_reason: Mapped[str | None] = mapped_column(Text)

    # Orçamento migrado (Field Control): código antigo, link da assinatura e anexos.
    legacy: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id], lazy="selectin")

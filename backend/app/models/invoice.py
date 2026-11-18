"""Nota fiscal do técnico parceiro (opcional).

O técnico emite a nota no portal da prefeitura e envia pelo app (aba Ganhos), com o arquivo (PDF,
XML ou foto) e as OS que ela cobre; a central confere em Pagamentos. A nota nunca trava pagamento.
Cada valor (ticket_payouts.invoice_id) fica em no máximo uma nota; uma nota cobre vários valores do
mesmo técnico. Regras em services/invoices.py.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import InvoiceStatus
from app.db.base import Base, Timestamps, UUIDPrimaryKey
from app.models._types import str_enum
from app.models.user import User


class TechnicianInvoice(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "technician_invoices"
    __table_args__ = (
        # O mesmo envio repetido pelo app (resposta perdida) não vira outra nota.
        UniqueConstraint(
            "technician_id", "client_upload_id", name="uq_technician_invoices_technician_upload"
        ),
    )

    technician_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # Chave de idempotência gerada no app (uma por abertura da tela de envio).
    client_upload_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    number: Mapped[str] = mapped_column(String(30))
    issue_date: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    # Mês do serviço: sempre o dia 1 (a API usa "AAAA-MM").
    competence: Mapped[date] = mapped_column(Date, index=True)
    # Observação do técnico (até 500 caracteres).
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[InvoiceStatus] = mapped_column(
        str_enum(InvoiceStatus),
        default=InvoiceStatus.PENDING,
        server_default=InvoiceStatus.PENDING.value,
        index=True,
    )
    # Motivo da recusa (3 a 300 caracteres).
    reject_reason: Mapped[str | None] = mapped_column(Text)
    # Quem conferiu ou recusou, e quando.
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    filename: Mapped[str] = mapped_column(String(255))
    # O tipo real, pelo conteúdo (storage.sniff_document), não o que o aparelho declarou.
    content_type: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer)
    # invoices/{técnico}/{uuid}_{nome} dentro de MEDIA_ROOT.
    storage_key: Mapped[str] = mapped_column(String(500))

    technician: Mapped[User] = relationship(foreign_keys=[technician_id], lazy="selectin")
    reviewed_by: Mapped[User | None] = relationship(foreign_keys=[reviewed_by_id], lazy="selectin")
